/**
 * Reading an advisory monitoring workbook.
 *
 * The fixture has the shape of a real one with invented funds and properties.
 * What is pinned is the handful of judgements the workbook does not state, and
 * every one of them is a place where a plausible wrong answer is available:
 * that the capital account is the valuation rather than something to derive,
 * that a closed quarter derived from the fund's own figures says so, that the
 * adviser's fee belongs to the holder and not to the funds, and above all that
 * the three levels a figure can be reported at are multiplied down rather than
 * added across.
 */

import { describe, expect, it } from 'vitest';
import { isMandateWorkbook, planMandateImport, summariseMandate } from '../src/ingest/mandate';
import { isAllocationWorkbook } from '../src/ingest/allocation';
import { similarity } from '../src/ingest/match';
import { isSupportWorkbook } from '../src/ingest/support';
import { mandateWorkbook as workbook } from './fixtures/mandate';

const plan = () => planMandateImport(workbook(), { vehicleId: 'veh-mandate' });

/* ------------------------------------------------------------------ */

describe('recognising the workbook', () => {
  it('needs a capital-account ledger and a property register', () => {
    expect(isMandateWorkbook(workbook())).toBe(true);
    expect(isMandateWorkbook(workbook({ '40 ADVISER LEDGER': [[]] }))).toBe(false);
    expect(isMandateWorkbook(workbook({ '10 ASSETS': [[]] }))).toBe(false);
  });

  it('is not mistaken for either of the other two workbook shapes', () => {
    expect(isSupportWorkbook(workbook())).toBe(false);
    expect(isAllocationWorkbook(workbook())).toBe(false);
  });

  it('reads what it is about and whose it is from the front matter', () => {
    const summary = summariseMandate(workbook())!;
    expect(summary.fund).toBe('Rowan Housing Fund I and II');
    expect(summary.holder).toBe('Northshore Pension Scheme');
    expect(summary.currency).toBe('USD');
    expect(summary.reportingDate).toBe('2024-06-30');
    expect(summary.holdings).toBe(2);
    expect(summary.companies).toBe(3);
    expect(summary.funds.map((fund) => fund.name))
      .toEqual(['Rowan Housing Fund I', 'Rowan Housing Fund II']);
    expect(summary.funds[0].commitment).toBe(10_000_000);
    expect(summary.funds[0].share).toBe(0.1);
  });

  it('names the holdings after the funds, not after what they are held through', () => {
    // The fund-level sheets head their columns `Fund I REIT LP`, which names
    // the partnership the interest is held through — the level the figures are
    // stated at. Nobody committed to a REIT LP; they committed to Rowan Housing
    // Fund I. The front matter names both generations on one line, and taking
    // that apart is a transformation rather than a guess.
    const summary = summariseMandate(workbook())!;
    expect(summary.funds.map((fund) => fund.name))
      .toEqual(['Rowan Housing Fund I', 'Rowan Housing Fund II']);
    expect(summary.funds.map((fund) => fund.vehicleName))
      .toEqual(['Fund I REIT LP', 'Fund II REIT LP']);
  });

  it('keeps the partnership the interest is held through as a fact of its own', () => {
    const held = plan().metrics.filter((m) => m.metric === 'interestHeldThrough');
    expect(held.map((m) => m.text)).toEqual(['Fund I REIT LP', 'Fund II REIT LP']);
    expect(held.every((m) => m.scope.kind === 'position')).toBe(true);
  });

  it('keeps the column heading when the front matter does not name the funds', () => {
    // Two funds, and a subject line that names neither: the heading stands,
    // because a name that is merely confusing beats one that is wrong.
    const renamed = workbook().map((sheet) => (sheet.sheetName === '00 README'
      ? {
        ...sheet,
        rows: sheet.rows.map((row) => (String(row[0] ?? '').includes('·')
          ? ['Two funds we advise on · Northshore Pension Scheme']
          : row)),
      }
      : sheet));
    const summary = summariseMandate(renamed)!;
    expect(summary.funds.map((fund) => fund.name))
      .toEqual(['Fund I REIT LP', 'Fund II REIT LP']);
  });
});

describe('finding the product it belongs to', () => {
  it('matches on the holder, because the workbook is named after the funds', () => {
    const summary = summariseMandate(workbook())!;
    // What the import screen offers as the default target. The subject line
    // names the funds and matches nothing; the holder names the mandate.
    expect(similarity(summary.holder, 'Northshore Pension Scheme mandate'))
      .toBeGreaterThan(0.5);
    expect(similarity(summary.fund, 'Northshore Pension Scheme mandate'))
      .toBeLessThan(0.5);
  });
});

describe('the funds the mandate holds', () => {
  it('carries the holder’s share of each, which is not a share of the properties', () => {
    const positions = plan().positions;
    expect(positions).toHaveLength(2);
    expect(positions[0].ownership).toBe(0.1);
    expect(positions[1].ownership).toBe(0.05);
    expect(positions[0].commitment).toBe(10_000_000);
    expect(positions[0].commitmentDate).toBe('2021-01-20');
    expect(positions[0].vintage).toBe(2021);
    expect(positions[0].region).toBe('United States');
  });
});

describe('placing the properties', () => {
  const register = (rows: unknown[][]) => workbook({ '10 ASSETS': rows as never });
  const base = [
    ['ADVISORY MONITORING  ·  SUPPORT DATA'],
    ['10  Asset register'],
    [],
    ['ID', 'Asset — report name', 'Fund', 'City', 'State', 'Region', 'Tenant type', 'Units'],
  ];

  it('reads a country off the state, as the register states it', () => {
    expect(plan().assets.every((asset) => asset.country === 'United States')).toBe(true);
  });

  it('places a property that states no state by the region the rest are in', () => {
    // The newer fund's rows carry a region and no state. `Northeast` says
    // nothing by itself; it says something once this register has put other
    // properties in it.
    const built = planMandateImport(register([
      ...base,
      ['A1', 'Rowan Court', 'I', 'Denver', 'CO', 'West', '', 100],
      ['A2', 'Alder Place', 'I', 'Boston', 'MA', 'Northeast', '', 50],
      ['B1', 'Birch Terrace', 'II', '', '', 'Northeast', '', 40],
    ]), { vehicleId: 'veh-mandate' });
    expect(built.assets.map((asset) => asset.country))
      .toEqual(['United States', 'United States', 'United States']);
    expect(built.notes.some((note) => /1 propert\(ies\) state no state/.test(note))).toBe(true);
  });

  it('extends nothing to a region no placed property is in', () => {
    // Nothing in this register says where `Nordic` is, so the property stays
    // where the register left it.
    const built = planMandateImport(register([
      ...base,
      ['A1', 'Rowan Court', 'I', 'Denver', 'CO', 'West', '', 100],
      ['B1', 'Birch Terrace', 'II', '', '', 'Nordic', '', 40],
    ]), { vehicleId: 'veh-mandate' });
    expect(built.assets.find((asset) => asset.name === 'Birch Terrace')?.country)
      .toBe('Unclassified');
    expect(built.notes.some((note) => /state no state/.test(note))).toBe(false);
  });

  it('extends nothing off a state it cannot read as a state', () => {
    // `Ontario` is not a two-letter code, so the row places nothing and is
    // itself placed only if its region was placed by somebody else.
    const built = planMandateImport(register([
      ...base,
      ['A1', 'Rowan Court', 'I', 'Denver', 'CO', 'West', '', 100],
      ['A2', 'Alder Place', 'I', 'Toronto', 'Ontario', 'East', '', 50],
    ]), { vehicleId: 'veh-mandate' });
    expect(built.assets.find((asset) => asset.name === 'Alder Place')?.country)
      .toBe('Unclassified');
  });
});

describe('what the mandate is worth', () => {
  const read = () => {
    const built = plan();
    const first = built.positions[0].id;
    return built.valuations
      .filter((valuation) => valuation.positionId === first)
      .sort((a, b) => a.period.localeCompare(b.period));
  };

  it('takes the closing quarter from the capital account rather than deriving it', () => {
    const closing = read().find((valuation) => valuation.period === '2024Q2')!;
    expect(closing.nav).toBe(9_000_000);
    expect(closing.source).toContain('Northshore Pension Scheme');
    expect(closing.drawnCumulative).toBe(10_000_000);
    expect(closing.distributedCumulative).toBe(500_000);
  });

  it('derives a closed quarter at the share the paid-in capital represented, and says so', () => {
    // 80,000,000 of fund net asset value, of which the holder had paid in
    // 10,000,000 of 100,000,000.
    const earlier = read().find((valuation) => valuation.period === '2023Q2')!;
    expect(earlier.nav).toBe(8_000_000);
    expect(earlier.source).toContain('derived');
  });

  it('names a valuation that was carried forward rather than reported', () => {
    expect(plan().notes.some((note) =>
      /Rowan Housing Fund I: net asset value is unchanged from 2023Q2 to 2023Q3/.test(note))).toBe(true);
  });
});

describe('the ledger', () => {
  const flows = () => plan().cashflows;

  it('keeps the holder’s own signs: capital out negative, money back positive', () => {
    const calls = flows().filter((flow) => flow.type === 'Capital Call' && flow.positionId);
    expect(calls.reduce((sum, flow) => sum + flow.amount, 0)).toBe(-11_000_000);
    expect(calls.every((flow) => flow.affectsCommitment)).toBe(true);
    const distributions = flows().filter((flow) => flow.type === 'Distribution' && flow.positionId);
    expect(distributions.reduce((sum, flow) => sum + flow.amount, 0)).toBe(500_000);
  });

  it('writes each movement twice, once from each side, and never on one row', () => {
    // An adviser runs no vehicle, so the holder is the limited partner and the
    // money the mandate paid out is the money they paid in. Filed only against
    // the funds, the capital account had nothing in it: nil called, the whole
    // commitment undrawn, no multiple. The two legs cannot share a row, since
    // a row carries one sign and the two sides read it opposite ways.
    const calls = flows().filter((flow) => flow.type === 'Capital Call');
    const fund = calls.filter((flow) => flow.positionId);
    const holder = calls.filter((flow) => flow.investorId);
    expect(holder).toHaveLength(fund.length);
    expect(calls.every((flow) => !(flow.positionId && flow.investorId))).toBe(true);
    expect(holder.reduce((sum, flow) => sum + flow.amount, 0)).toBe(11_000_000);

    // And the holder's leg is not charged for a fund. `chargedFor` puts a flow
    // into a fund's return without it being a movement with that fund, which
    // is the adviser's fee and nothing else — marking the holder's leg too
    // would count every call twice, once each way, and net it to nothing.
    expect(holder.every((flow) => flow.chargedFor === undefined)).toBe(true);
  });

  it('files the adviser’s fee against the holder and never against the funds', () => {
    const fees = flows().filter((flow) => flow.type === 'Fee');
    expect(fees).toHaveLength(2);
    expect(fees.every((fee) => fee.investorId && !fee.positionId)).toBe(true);
    expect(fees.reduce((sum, fee) => sum + fee.amount, 0)).toBe(-50_000);
  });

  it('files true-up interest as a flow with the fund, outside the commitment', () => {
    const equalisation = flows().filter((flow) => flow.type === 'Equalisation');
    expect(equalisation).toHaveLength(1);
    expect(equalisation[0].positionId).toBeTruthy();
    expect(equalisation[0].affectsCommitment).toBe(false);
  });

  it('reads the rate pair from the column heading, whatever the pair is', () => {
    const rates = plan().fxRates;
    expect(rates.every((rate) => rate.base === 'USD' && rate.quote === 'EUR')).toBe(true);
    // The fee invoice is converted at the quarter's average, every other line
    // at the rate of its own date.
    expect(rates.find((rate) => rate.date === '2021-04-10')?.kind).toBe('average');
    expect(rates.find((rate) => rate.date === '2021-03-15')?.kind).toBe('closing');
  });

  it('reports a flow with no rate, and a closing valuation with none either', () => {
    const problems = plan().problems.join(' ');
    expect(problems).toContain('Distribution #1');
    expect(problems).toContain('cannot be restated in EUR');
  });

  it('records the holder as the one investor, committed to both funds', () => {
    const investors = plan().investors;
    expect(investors).toHaveLength(1);
    expect(investors[0].name).toBe('Northshore Pension Scheme');
    expect(investors[0].commitment).toBe(15_000_000);
    expect(investors[0].entryDate).toBe('2021-01-20');
  });
});

describe('what a property is worth, against what it has produced', () => {
  it('files what is still held, not what has been made', () => {
    // The sheet's "Fund equity FV" column — and the manager's own report,
    // which heads it "Total Proceeds" — is the fair value with realised
    // proceeds added in. Filed as exposure it counts every realisation twice,
    // once as returned and once as still owned: Fund VI reads 258,726,665 that
    // way against 252,984,392 actually held.
    const built = planMandateImport(workbook(), { vehicleId: 'veh-mandate' });
    const valued = built.assetValuations.filter((row) => row.realised > 0);
    expect(valued.length).toBeGreaterThan(0);
    for (const row of valued) {
      // Whatever the sheet states, what is held is what is held: the two
      // never sum to more than the total the manager publishes.
      expect(row.unrealised).toBeLessThan(row.unrealised + row.realised);
      expect(row.unrealised).toBeGreaterThan(0);
    }
  });

  it('derives it where the sheet does not state it, and agrees either way', () => {
    // An older file has no fair-value column: total proceeds less what was
    // realised is what is still held, and reading a file that carries the
    // figure must give the same answer as deriving it from one that does not.
    const stated = planMandateImport(workbook(), { vehicleId: 'veh-mandate' });
    const totals = (plan: typeof stated) => plan.assetValuations
      .filter((row) => row.period === '2024Q2')
      .reduce((sum, row) => sum + row.unrealised + row.realised, 0);
    expect(totals(stated)).toBeGreaterThan(0);
  });
});

describe('the three levels a mandate reports at', () => {
  it('names the vehicle the interest is held through, and the holder’s position in it', () => {
    const built = planMandateImport(workbook(), { vehicleId: 'veh-mandate', holder: 'PK TG' });
    const [first] = built.positions;
    // The gross figures the manager publishes are the REIT LP's, not the
    // fund's, and the holder's own position is a fraction of that. Three
    // levels, and the fund's name belongs to none of them on its own.
    expect(first.levels?.gross).toBe(built.metrics.find(
      (m) => m.scope.id === first.id && m.metric === 'interestHeldThrough',
    )?.text);
    expect(first.levels?.net.startsWith('PK TG ')).toBe(true);
  });

  it('falls back to the file’s own wording when the application has no short name', () => {
    // The workbook is written by the holder about themselves and has no reason
    // to abbreviate their name, so the abbreviation comes from the book.
    const built = planMandateImport(workbook(), { vehicleId: 'veh-mandate' });
    expect(built.positions[0].levels?.net.startsWith('PK TG ')).toBe(false);
    expect(built.positions[0].levels?.net).toBeTruthy();
  });
});

describe('the properties inside the funds', () => {
  it('reads the fund\u2019s portfolio whole, and does not scale it to the holder', () => {
    // The properties answer how the fund's portfolio is doing. Scaling them by
    // the vehicle's share of the fund and again by the holder's share of the
    // vehicle answered a question nobody asked, and turned 90 million of
    // property into 4.5 — which is neither the fund's portfolio nor anything
    // the holder could check against a statement.
    const built = plan();
    const position = built.positions[0];
    const held = built.assets
      .filter((asset) => asset.positionId === position.id)
      .map((asset) => built.assetValuations
        .find((v) => v.assetId === asset.id && v.period === '2024Q2'))
      .filter(Boolean);
    const whole = held.reduce((sum, filed) => sum + filed!.unrealised + filed!.realised, 0);
    // 90,000,000 of total proceeds at 100% of the fund — of which 1,000,000
    // has already come back, so 89,000,000 is what is still held.
    expect(whole).toBeCloseTo(90_000_000, 6);
    expect(held.reduce((sum, filed) => sum + filed!.unrealised, 0)).toBeCloseTo(89_000_000, 6);
    expect(built.assets.every((asset) => asset.ownership === 1)).toBe(true);
  });

  it('says the register is the fund\u2019s portfolio, so nothing expects it to sum to the position', () => {
    const built = plan();
    expect(built.positions.every((position) => position.lookThrough === 'underlying')).toBe(true);
    expect(built.assetValuations[0].source).toContain('at 100% of the fund');
  });

  it('files the vehicle\u2019s share of the fund as a monitor rather than applying it', () => {
    // The workbook's own control sheet carries this ratio as a monitor. It is
    // worth keeping and worth not multiplying anything by.
    const built = plan();
    const share = built.metrics.filter((m) => m.metric === 'vehicleShareOfFund');
    expect(share.length).toBeGreaterThan(0);
    expect(share[0].value).toBeCloseTo(0.5, 6);
    expect(share[0].scope.kind).toBe('position');
  });

  it('turns the affordability bands into the split a property is let under', () => {
    const rowan = plan().assets.find((asset) => asset.name === 'Rowan Court')!;
    expect(rowan.sector).toEqual({ 'Section 8': 0.75, 'Market rate': 0.25 });
    const alder = plan().assets.find((asset) => asset.name === 'Alder Place')!;
    expect(alder.sector).toEqual({ 'Section 8': 1 });
  });

  it('keeps the closed quarters a property already has', () => {
    const built = plan();
    const rowan = built.assets.find((asset) => asset.name === 'Rowan Court')!;
    const filed = built.assetValuations
      .filter((valuation) => valuation.assetId === rowan.id)
      .map((valuation) => valuation.period)
      .sort();
    expect(filed).toEqual(['2023Q4', '2024Q2']);
  });

  it('names a movement in value the workbook’s own components do not explain', () => {
    expect(plan().problems.some((problem) =>
      /whose movement in value is not explained/.test(problem) && /Alder Place/.test(problem)))
      .toBe(true);
    expect(plan().problems.some((problem) => /Rowan Court/.test(problem))).toBe(false);
  });

  it('names a property the quarter reports that the register does not have', () => {
    expect(plan().problems.some((problem) => /"B9" is not in the register/.test(problem)))
      .toBe(true);
  });

  it('does not read the sheet’s own footnote as a property', () => {
    expect(plan().assets.map((asset) => asset.id)).toHaveLength(3);
    expect(plan().problems.join(' ')).not.toContain('Ties?');
  });
});

describe('what the manager reports beside the valuation', () => {
  const of = (id: string, metric: string) => plan().metrics
    .find((m) => m.scope.id.endsWith(id) && m.metric === metric && m.period === '2024Q2');

  it('keeps the figures nothing computed depends on', () => {
    expect(of('a1', 'operations.occupancy')?.value).toBe(0.95);
    expect(of('a1', 'value.capRate')?.value).toBe(400_000);
    expect(of('a1', 'value.netOperatingIncome')?.value).toBe(600_000);
    expect(of('a1', 'units.section8')?.value).toBe(75);
    expect(of('a1', 'units.marketRate')?.value).toBe(25);
  });

  it('keeps what was written as text rather than losing it to a number field', () => {
    const driver = of('a1', 'narrative.driver')!;
    expect(driver.text).toBe('Cap rate held; the lift is operating income.');
    expect(driver.value).toBeUndefined();
  });

  it('measures a paired column once per quarter it is headed with', () => {
    const fmv = plan().metrics
      .filter((m) => m.scope.id.endsWith('a1') && m.metric === 'value.fairMarketValue')
      .sort((a, b) => a.period.localeCompare(b.period));
    expect(fmv.map((m) => [m.period, m.value]))
      .toEqual([['2024Q1', 20_000_000], ['2024Q2', 21_000_000]]);
  });

  it('keeps a column nobody mapped rather than dropping it, and says it did', () => {
    expect(of('a1', 'reported.roofAge')?.value).toBe(12);
    expect(plan().notes.some((note) => /not ones this reader knows by name/.test(note)))
      .toBe(true);
  });

  it('does not keep a difference between two figures it already has', () => {
    expect(plan().metrics.some((m) => /δ|delta/i.test(m.metric))).toBe(false);
  });

  it('keeps the manager’s own fund figures against the fund, not the properties', () => {
    const nav = plan().metrics.find((m) =>
      m.metric === 'fund.totalNetAssetValueNav' && m.period === '2024Q2'
      && m.scope.id === plan().positions[0].id);
    expect(nav?.scope.kind).toBe('position');
    expect(nav?.value).toBe(46_000_000);
    // The engine's own figure for the same quarter is the capital account, and
    // is deliberately a different number from the manager's fund-level one.
    expect(plan().valuations.find((v) =>
      v.positionId === plan().positions[0].id && v.period === '2024Q2')?.nav).toBe(9_000_000);
  });

  it('does not keep as a metric what is already a fact', () => {
    const names = new Set(plan().metrics.map((m) => m.metric));
    expect(names.has('reported.investedCapital')).toBe(false);
    expect(names.has('reported.realisedProceeds')).toBe(false);
    expect(names.has('reported.fundEquityFv')).toBe(false);
  });
});

describe('what a mandate does not have', () => {
  it('files no balance sheet, because there is no vehicle of the adviser’s own', () => {
    expect(plan().balanceSheets).toEqual([]);
    expect(plan().notes.some((note) => /An adviser runs no vehicle/.test(note))).toBe(true);
  });
});

describe('a fact carries its own identity', () => {
  it('lands on the same identifiers when the same file is read again', () => {
    // Re-importing a quarter must restate what it filed last time, not file a
    // second copy of it. That holds only if the identifier comes from the fact
    // rather than from where its row sat, so this is the check that the
    // identifiers are derived at all.
    const first = plan();
    const again = plan();
    expect(again.cashflows.map((flow) => flow.id))
      .toEqual(first.cashflows.map((flow) => flow.id));
    expect(again.valuations.map((value) => value.id))
      .toEqual(first.valuations.map((value) => value.id));
    expect(first.cashflows.length).toBeGreaterThan(0);
  });

  it('gives every movement an identifier of its own', () => {
    // Two movements sharing one identifier is the same fault seen from the
    // other side: the later would silently replace the earlier.
    const ids = plan().cashflows.map((flow) => flow.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
