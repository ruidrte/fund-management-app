/**
 * Reading a portfolio database.
 *
 * The fixture is the shape of a real one — the same sheets, headings, units and
 * sign conventions — with invented funds and figures. What is being pinned is
 * the conversion, and that is where a wrong answer looks most plausible: a
 * misread sign or a factor of a thousand produces a portfolio that ties to
 * itself and to nothing else.
 */

import { describe, expect, it } from 'vitest';
import { isPortfolioDatabase, planImport, programsIn } from '../src/ingest/pfdb';
import type { TableData } from '../src/ingest/types';

/** Excel keeps dates as days since 1899-12-30; the workbook is full of them. */
const serial = (iso: string): number =>
  Math.round((Date.parse(`${iso}T00:00:00Z`) - Date.UTC(1899, 11, 30)) / 86_400_000);

const FUND_DB: TableData = {
  sheetName: 'FundDB',
  rows: [
    ['Progid', 'Program', 'Fund', 'Short', 'Type', 'Fund Manager', 'CCY', 'Size (Mio)',
      'Vintage', 'Region', 'Sector', 'Strategy', 'First Close'],
    ['1', 'ABIF', 'Baltic Wind Partners II', 'BWP II', 'Primary', 'Baltic Capital', 'EUR', 200,
      2021, 'Europe', 'Infrastructure', 'Growth', serial('2021-06-30')],
    ['2', 'ABIF', 'Nordic Growth IV', 'NG IV', 'Primary', 'Nordic GP', 'SEK', 1000,
      2019, 'Europe', 'PE', 'Buyout', serial('2019-03-31')],
    // No size: its share of the fund cannot be worked out.
    ['3', 'ABIF', 'Opportunity Fund I', 'OF I', 'Primary', 'Opp GP', 'EUR', null,
      2022, 'Europe', 'PE', 'Growth', serial('2022-01-31')],
    ['4', 'ABIF', 'Direct Holding AG', 'DH', 'Direct', 'In house', 'CHF', 10,
      2020, 'Europe', 'Infrastructure', null, serial('2020-06-30')],
    // The limited partner's own book: one fund, which is the vehicle itself.
    ['5', 'LPX', 'Abendrot Impulse Fund', 'ABIF', 'Primary', 'EBG', 'EUR', 165,
      2017, 'Europe', 'Impact', null, serial('2017-06-30')],
  ],
};

const FUND_TX: TableData = {
  sheetName: 'FundTX',
  rows: [
    ['Program', 'Fund', 'Date', 'Description', 'CCY', 'Commitment', 'Capital Calls',
      'Other Exp(Inc)', 'Distribs (Recall.)', 'Distribs (Other)', 'NAV', 'DCash'],
    ['ABIF', 'Baltic Wind Partners II', serial('2021-06-30'), 'Commitment', 'EUR', 8000, null, null, null, null, null, 0],
    ['ABIF', 'Baltic Wind Partners II', serial('2021-09-15'), 'DD1', 'EUR', null, 2000, null, null, null, null, -2000],
    ['ABIF', 'Baltic Wind Partners II', serial('2021-12-31'), 'NAV', 'EUR', null, null, null, null, null, 2100, 0],
    ['ABIF', 'Baltic Wind Partners II', serial('2022-03-20'), 'DD2/D1', 'EUR', null, 1000, 25, null, -400, null, -625],
    ['ABIF', 'Nordic Growth IV', serial('2019-03-31'), 'Commitment', 'SEK', 45000, null, null, null, null, null, 0],
    ['ABIF', 'Nordic Growth IV', serial('2022-03-31'), 'NAV', 'SEK', null, null, null, null, null, 30000, 0],
    ['ABIF', 'Opportunity Fund I', serial('2022-01-31'), 'Commitment', 'EUR', 5000, null, null, null, null, null, 0],
    ['ABIF', 'Direct Holding AG', serial('2020-06-30'), 'Commitment', 'CHF', 10000, null, null, null, null, null, 0],
    // A row whose flows do not agree with the workbook's own cash column.
    ['ABIF', 'Nordic Growth IV', serial('2022-06-30'), 'Broken', 'SEK', null, 500, null, null, null, null, -900],
    // A fund that is not in FundDB under this programme.
    ['ABIF', 'Ghost Fund', serial('2022-06-30'), 'DD1', 'EUR', null, 100, null, null, null, null, -100],
    // The limited partner's own rows.
    ['LPX', 'Abendrot Impulse Fund', serial('2021-06-30'), 'Commitment', 'EUR', 165000, null, null, null, null, null, 0],
    ['LPX', 'Abendrot Impulse Fund', serial('2021-09-30'), 'CC1', 'EUR', null, 12000, null, null, null, null, -12000],
    ['LPX', 'Abendrot Impulse Fund', serial('2022-03-31'), 'NAV (CAS)', 'EUR', null, null, null, null, null, 11800, 0],
  ],
};

const COMP_DB: TableData = {
  sheetName: 'CompDB',
  rows: [
    ['FundID', 'Fund', 'Company', 'Region', 'Geography', 'Vintage', 'Sector', 'CCY', 'FM Stake %', 'Inv Date'],
    ['1', 'Baltic Wind Partners II', 'Offshore Wind AS', 'Europe', 'Denmark', 2021, 'Renewables', 'EUR', 0.42, serial('2021-11-30')],
    ['1', 'Baltic Wind Partners II', 'Grid Services BV', 'Europe', 'Netherlands', 2022, 'Utilities', 'EUR', 0.3, serial('2022-02-28')],
    // Belongs to the fund whose share is unknown.
    ['3', 'Opportunity Fund I', 'Hidden Co', 'Europe', 'Spain', 2022, 'Services', 'EUR', 0.5, serial('2022-05-31')],
  ],
};

const COMP_Q: TableData = {
  sheetName: 'CompQ',
  rows: [
    ['Fundid', 'Fund', 'Company', 'Date', 'Status', 'CCY', 'Invested (M)', 'Realized (M)', 'Unrealized (M)', 'Total Value'],
    ['1', 'Baltic Wind Partners II', 'Offshore Wind AS', serial('2022-03-31'), 'Unrealized', 'EUR', 12.5, 0, 18.4, 18.4],
    ['1', 'Baltic Wind Partners II', 'Grid Services BV', serial('2022-03-31'), 'Partially Realized', 'EUR', 6, 2.5, 5.25, 7.75],
    ['3', 'Opportunity Fund I', 'Hidden Co', serial('2022-03-31'), 'Unrealized', 'EUR', 40, 0, 90, 90],
  ],
};

const FX: TableData = {
  sheetName: 'FX',
  rows: [
    ['Date', 'USD', 'EUR', 'SEK', 'CHF', 'T'],
    // A control row the workbook keeps at serial 1; not a date.
    [1, 1.159, 1, 11.1145, 0.9394, 'x'],
    [serial('2022-03-31'), 1.1101, 1, 10.338, 0.9924, 'x'],
  ],
};

const SHEETS = [FUND_DB, FUND_TX, COMP_DB, COMP_Q, FX];

const plan = () => planImport(SHEETS, {
  program: 'ABIF', vehicleId: 'veh-abif', investorProgram: 'LPX', investorName: 'The pension fund',
});

describe('recognising the workbook', () => {
  it('knows a portfolio database from a document', () => {
    expect(isPortfolioDatabase(SHEETS)).toBe(true);
    expect(isPortfolioDatabase([{ sheetName: 'Holdings', rows: [['Fund', 'NAV']] }])).toBe(false);
  });

  it('separates the portfolios from the book of the partner who owns one', () => {
    const programs = programsIn(SHEETS);
    const abif = programs.find((p) => p.program === 'ABIF')!;
    const lpx = programs.find((p) => p.program === 'LPX')!;

    expect(abif.funds).toBe(4);
    expect(abif.companies).toBe(3);
    expect(abif.investorIn).toBeUndefined();
    // LPX holds one fund, and that fund is ABIF's own vehicle.
    expect(lpx.investorIn).toBe('ABIF');
    expect(abif.first).toBe('2019Q1');
    expect(abif.last).toBe('2022Q2');
  });
});

describe('the portfolio', () => {
  it('takes each fund from the static sheet and its commitment from the movements', () => {
    const result = plan();
    const baltic = result.positions.find((p) => p.name === 'Baltic Wind Partners II')!;

    expect(result.positions).toHaveLength(4);
    expect(baltic.commitment).toBe(8000);
    expect(baltic.currency).toBe('EUR');
    expect(baltic.vintage).toBe(2021);
    expect(baltic.assetClass).toBe('Infrastructure');
    expect(baltic.kind).toBe('fund');
    expect(result.positions.find((p) => p.name === 'Direct Holding AG')!.kind)
      .toBe('direct-investment');
  });

  it('turns the workbook’s signs into the vehicle’s own', () => {
    const { cashflows } = plan();
    const of = (description: string) =>
      cashflows.filter((c) => c.description === description);

    // A call is money out; the workbook writes it positive.
    expect(of('DD1')[0].amount).toBe(-2000);
    expect(of('DD1')[0].type).toBe('Capital Call');

    // One row, three movements: a call, an expense, and a distribution the
    // workbook wrote negative and this application writes positive.
    const combined = of('DD2/D1');
    expect(combined.map((c) => [c.type, c.amount])).toEqual([
      ['Capital Call', -1000],
      ['Distribution', 400],
      ['Fee', -25],
    ]);
  });

  it('reports a row whose flows disagree with the workbook’s own cash figure', () => {
    const { problems, cashflows } = plan();
    expect(problems.some((p) => /Broken|row 10/.test(p) || /do not agree/.test(p))).toBe(true);
    // Reported, not dropped: the reader does not get to decide it is wrong.
    expect(cashflows.some((c) => c.description === 'Broken')).toBe(true);
  });

  it('skips a movement for a fund the static sheet does not have', () => {
    const { problems, cashflows } = plan();
    expect(cashflows.some((c) => c.description === 'DD1' && c.amount === -100)).toBe(false);
    expect(problems.some((p) => p.includes('Ghost Fund'))).toBe(true);
  });

  it('files NAV rows as valuations of the holding they belong to', () => {
    const { valuations, positions } = plan();
    const baltic = positions.find((p) => p.name === 'Baltic Wind Partners II')!;
    const reported = valuations.filter((v) => v.positionId === baltic.id);
    expect(reported).toHaveLength(1);
    expect(reported[0]).toMatchObject({ period: '2021Q4', nav: 2100 });
  });
});

describe('the limited partner', () => {
  it('becomes the capital account rather than a holding', () => {
    const { investors, cashflows, valuations, positions } = plan();

    expect(positions.map((p) => p.name)).not.toContain('Abendrot Impulse Fund');
    expect(investors).toHaveLength(1);
    expect(investors[0]).toMatchObject({
      name: 'The pension fund', commitment: 165000, currency: 'EUR', entryDate: '2021-06-30',
    });

    const own = cashflows.filter((c) => c.investorId === investors[0].id);
    expect(own.some((c) => c.type === 'Capital Call' && c.amount === -12000)).toBe(true);
    expect(own.every((c) => c.positionId === undefined)).toBe(true);

    // Its NAV rows are the capital account, and must not become a portfolio
    // valuation — that would count the vehicle inside itself.
    expect(valuations.every((v) => v.nav !== 11800)).toBe(true);
  });

  it('is left out when no partner programme is chosen', () => {
    const only = planImport(SHEETS, { program: 'ABIF', vehicleId: 'veh-abif' });
    expect(only.investors).toHaveLength(0);
    expect(only.cashflows.every((c) => c.investorId === undefined)).toBe(true);
  });
});

describe('look-through', () => {
  it('scales each fund by the share the vehicle holds of it', () => {
    const { positions } = plan();
    const baltic = positions.find((p) => p.name === 'Baltic Wind Partners II')!;
    const nordic = positions.find((p) => p.name === 'Nordic Growth IV')!;

    // 8,000 thousand committed to a 200 million fund.
    expect(baltic.ownership).toBeCloseTo(8000 / 200_000, 10);
    expect(nordic.ownership).toBeCloseTo(45_000 / 1_000_000, 10);
    // Held directly, so the whole of it.
    expect(positions.find((p) => p.name === 'Direct Holding AG')!.ownership).toBe(1);
  });

  it('leaves out the companies of a fund whose share cannot be worked out', () => {
    const { assets, notes } = plan();
    expect(assets.map((a) => a.name).sort()).toEqual(['Grid Services BV', 'Offshore Wind AS']);
    // Rather than assuming 100%, which would put a whole fund's portfolio —
    // larger than the vehicle — into the look-through.
    expect(notes.some((n) => n.includes('Opportunity Fund I') && n.includes('Size (Mio)'))).toBe(true);
  });

  it('reads company values as millions and stores them as thousands', () => {
    const { assets, assetValuations } = plan();
    const wind = assets.find((a) => a.name === 'Offshore Wind AS')!;
    const value = assetValuations.find((v) => v.assetId === wind.id)!;

    expect(value).toMatchObject({ period: '2022Q1', invested: 12_500, realised: 0, unrealised: 18_400 });
    // The value is already the fund's own position, so the asset is not scaled
    // again — the vehicle's share comes from the holding.
    expect(wind.ownership).toBe(1);
    expect(assets.find((a) => a.name === 'Grid Services BV')!.status).toBe('Partially Realised');
  });
});

describe('rates', () => {
  it('reads the table as EUR-based and ignores the control row', () => {
    const { fxRates } = plan();
    const usd = fxRates.filter((r) => r.quote === 'USD');

    expect(usd).toHaveLength(1);
    expect(usd[0]).toMatchObject({
      base: 'EUR', quote: 'USD', rate: 1.1101, period: '2022Q1', authority: 'manual',
    });
    // EUR against itself is not a rate.
    expect(fxRates.some((r) => r.quote === 'EUR')).toBe(false);
  });
});

describe('funds whose names differ only at the end', () => {
  // Two real ones did: "Generation IM Sustainable Solutions Fund II" and
  // "... III", and "Rose Affordable Housing Preservation Fund IV" and "... V".
  // Truncating the name to build an identifier merged each pair into a single
  // holding carrying both funds' figures — a portfolio two funds short, with no
  // row missing from any sheet to point at.
  const LONG = 'Generation IM Sustainable Solutions Fund';
  const sheets = (): TableData[] => [
    {
      sheetName: 'FundDB',
      rows: [
        ['Progid', 'Program', 'Fund', 'CCY', 'Size (Mio)', 'Vintage'],
        ['1', 'ABIF', `${LONG} II`, 'EUR', 500, 2019],
        ['2', 'ABIF', `${LONG} III`, 'EUR', 800, 2022],
      ],
    },
    {
      sheetName: 'FundTX',
      rows: [
        ['Program', 'Fund', 'Date', 'CCY', 'Commitment', 'Capital Calls', 'NAV', 'DCash'],
        ['ABIF', `${LONG} II`, serial('2019-06-30'), 'EUR', 4000, null, null, 0],
        ['ABIF', `${LONG} II`, serial('2022-03-31'), 'EUR', null, null, 3100, 0],
        ['ABIF', `${LONG} III`, serial('2022-01-31'), 'EUR', 6000, null, null, 0],
        ['ABIF', `${LONG} III`, serial('2022-03-31'), 'EUR', null, null, 5200, 0],
      ],
    },
  ];

  const built = () => planImport(sheets(), { program: 'ABIF', vehicleId: 'veh-1' });

  it('gives each of them its own holding', () => {
    const { positions, problems } = built();

    expect(positions).toHaveLength(2);
    expect(new Set(positions.map((p) => p.id)).size).toBe(2);
    expect(problems).toEqual([]);
  });

  it('keeps each valuation on its own holding', () => {
    const { positions, valuations } = built();
    const navOf = (name: string) => {
      const position = positions.find((p) => p.name === name)!;
      return valuations.find((v) => v.positionId === position.id)!.nav;
    };

    expect(navOf(`${LONG} II`)).toBe(3_100);
    expect(navOf(`${LONG} III`)).toBe(5_200);
  });

  it('still produces the same identifier when the same workbook is read twice', () => {
    expect(built().positions.map((p) => p.id)).toEqual(built().positions.map((p) => p.id));
  });
});

describe('a workbook holding more than one product', () => {
  // The real one holds every programme a house runs. Loading them one at a time
  // files the same rate table twice and leaves the book half-migrated if the
  // second pass never happens, so they are planned together and committed once.
  const sheets = (): TableData[] => [
    {
      sheetName: 'FundDB',
      rows: [
        ['Progid', 'Program', 'Fund', 'CCY', 'Size (Mio)', 'Vintage'],
        ['1', 'ABIF', 'Baltic Wind Partners II', 'EUR', 200, 2021],
        ['2', 'PHF', 'Nordic Health Fund I', 'EUR', 300, 2022],
      ],
    },
    {
      sheetName: 'FundTX',
      rows: [
        ['Program', 'Fund', 'Date', 'CCY', 'Commitment', 'Capital Calls', 'NAV', 'DCash'],
        ['ABIF', 'Baltic Wind Partners II', serial('2021-06-30'), 'EUR', 8000, null, null, 0],
        ['ABIF', 'Baltic Wind Partners II', serial('2022-03-31'), 'EUR', null, 2000, 2100, -2000],
        ['PHF', 'Nordic Health Fund I', serial('2022-06-30'), 'EUR', 5000, null, null, 0],
        ['PHF', 'Nordic Health Fund I', serial('2022-09-30'), 'EUR', null, 1200, 1250, -1200],
      ],
    },
    {
      sheetName: 'FX',
      rows: [
        ['Date', 'USD', 'EUR', 'CHF'],
        [serial('2022-03-31'), 1.1101, 1, 0.9932],
        [serial('2022-06-30'), 1.0387, 1, 0.9967],
      ],
    },
  ];

  const both = () => [
    planImport(sheets(), { program: 'ABIF', vehicleId: 'veh-abif' }),
    planImport(sheets(), { program: 'PHF', vehicleId: 'veh-phf-i' }),
  ];

  it('keeps each programme to its own product', () => {
    const [abif, phf] = both();

    expect(abif.positions.map((p) => p.name)).toEqual(['Baltic Wind Partners II']);
    expect(phf.positions.map((p) => p.name)).toEqual(['Nordic Health Fund I']);
    expect(abif.positions.every((p) => p.vehicleId === 'veh-abif')).toBe(true);
    expect(phf.positions.every((p) => p.vehicleId === 'veh-phf-i')).toBe(true);
  });

  it('gives the two no holding, valuation or cashflow in common', () => {
    const [abif, phf] = both();
    const ids = (plan: typeof abif) => [
      ...plan.positions.map((r) => r.id),
      ...plan.valuations.map((r) => r.id),
      ...plan.cashflows.map((r) => r.id),
    ];
    const shared = ids(abif).filter((id) => ids(phf).includes(id));

    expect(shared).toEqual([]);
  });

  it('reads the one rate table identically, so the duplicates collapse', () => {
    const [abif, phf] = both();

    // Same ids, because a rate's id names its pair and its date — not the
    // programme that happened to carry it. That is what lets one commit file
    // the table once.
    expect(abif.fxRates.map((r) => r.id)).toEqual(phf.fxRates.map((r) => r.id));
    const merged = new Map([...abif.fxRates, ...phf.fxRates].map((r) => [r.id, r]));
    expect(merged.size).toBe(abif.fxRates.length);
    expect(abif.fxRates.length).toBeGreaterThan(0);
  });
});
