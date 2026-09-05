import { describe, expect, it } from 'vitest';
import {
  isStagedSupport, planStagedImport, summariseStaged,
} from '../src/ingest/staged';
import type { TableData } from '../src/ingest/types';
import type { Cell } from '../src/ingest/workbook';

/* ------------------------------------------------------------------ *
 * A file of this shape, in miniature
 *
 * Two target funds in two currencies, three quarters, and every tab the reader
 * looks at — including a computed one, which it must not look at, and a check
 * that did not pass, which it must.
 * ------------------------------------------------------------------ */

function sheet(sheetName: string, rows: Cell[][]): TableData {
  return { sheetName, rows, headerRow: 0, columns: [] } as unknown as TableData;
}

const README = sheet('00_README', [
  ['TWO — Quarterly Reporting Process | Support File v1.0'],
  ['Two Rivers Fund SCS SICAV-RAIF · A Manager AG · built on the Administrator NAV Pack'],
]);

const CONTROL = sheet('01_Control', [
  ['PERIOD PARAMETERS'],
  ['The only tab to review by hand.'],
  [],
  ['PERIOD'],
  ['', 'Reporting date', '2026-03-31'],
  ['', 'Quarter', 'Q1 2026'],
  ['', 'Prior quarter (comparative)', 'Q4 2025'],
  ['', 'Fund currency', 'EUR'],
  [],
  ['FUND — capital'],
  ['', 'LP commitment (reporting basis)', 10_000_000],
  ['', 'LP capital called', 6_300_000],
  ['', 'Unfunded commitment', 3_700_000],
  ['', 'NAV Class C (LP)', 5_215_795.97],
  ['', 'Number of Limited Partners', 1],
  [],
  ['FX — period end'],
  ['', 'EUR/SEK', 10.943],
  ['', 'EUR/USD', 1.1498],
  [],
  ['CHECK SETTINGS'],
  ['', 'Check tolerance', 1],
]);

const NAV_PACK = sheet('10_IN_NAVPack', [
  ['INPUT — NAV PACK (ADMINISTRATOR)'],
  ['Paste VALUES from the pack. Nothing in this tab should be calculated.'],
  [],
  ['A. COVER — Fund Keyfacts'],
  ['', 'Total NAV', 5_216_795.97],
  ['', 'Subtotal NAV — GP', 1_000],
  [],
  ['C. SNA — Statement of Net Assets (EUR)'],
  ['', 'Formation expense', 225_272.03],
  ['', 'Portfolio investment', 4_447_663.11],
  ['', 'Other receivables', 5_850],
  ['', 'Bank', 726_766.95],
  ['', 'Total Assets', 5_405_552.09],
  ['', 'Total Liabilities', -188_756.12],
  ['', 'NAV', 5_216_795.97],
  [],
  ['D. SOO — Statement of Operations (YTD, EUR)'],
  ['', 'Administration Fees', -32_380.25],
  ['', 'Total charges', -137_838.34],
  [],
  ['E. PORTFOLIO OVERVIEW'],
  ['', 'Deal Name', 'CCY', 'Commitment CCY', 'Investment Cost CCY', 'Investment Cost EUR',
    'FX Gains/Losses EUR', 'Valuation Gains/Losses EUR', 'Valuation EUR', 'Valuation CCY',
    'Remaining Commitment CCY'],
  ['', 'Northern III (D) AB', 'SEK', 56_000_000, 27_293_554.54, 2_435_091.5,
    -59_288.68, -245_725.09, 2_740_105.27, 29_984_971.95, 28_706_445.46],
  ['', 'SAHPF VI REIT, L.P.', 'USD', 5_000_000, 2_100_000, 1_849_567.33,
    24_616.07, 117_393.42, 1_707_557.84, 1_963_350, 2_900_000],
  ['', 'Grand Total(s):', '', 61_000_000, 29_393_554.54, 4_284_658.83,
    -34_672.61, -128_331.67, 4_447_663.11, 31_948_321.95, 31_606_445.46],
  [],
  ['F. TRIAL BALANCE'],
  ['', 'Account', 'Opening Balance', 'Debit', 'Credit', 'Ending Balance'],
  ['', '10010 - Cash', 1_264_072.82, 420_169.7, 957_475.57, 726_766.95],
  ['', '10030 - Investments', 3_868_704.85, 415_953.98, 0, 4_284_658.83],
  ['', '30010 - Partners\' capital', -5_132_777.67, 121_351.89, 0, -5_011_425.78],
  ['', 'Total (must be 0)', 0, '', '', 0],
]);

const TF_HISTORY = sheet('11_IN_TF_History', [
  ['INPUT — QUARTERLY SERIES BY TARGET FUND'],
  [],
  ['Quarter', 'Period end', 'Target fund', 'CCY', 'Commitment CCY', 'Investment cost CCY',
    'Equalisation & fees CCY', 'Distributions CCY', 'NAV CCY', 'Total drawn CCY',
    'Open commitment CCY', 'FX EUR/CCY (period end)', 'MoIC'],
  ['Q3 2025', '2025-09-30', 'Northern III (D) AB', 'SEK', 56_000_000, 20_612_320,
    94_394.35, 0, 22_292_143.34, 20_706_714.35, 35_387_680, 11.0565, 1.081496],
  ['Q3 2025', '2025-09-30', 'SAHPF VI REIT, L.P.', 'USD', 5_000_000, 1_950_000,
    -465, 0, 1_882_892, 1_949_535, 3_050_000, 1.1741, 0.965586],
  ['Q4 2025', '2025-12-31', 'Northern III (D) AB', 'SEK', 56_000_000, 24_132_542.5,
    94_394.35, 0, 27_130_214.53, 24_226_936.85, 31_867_457.5, 10.8215, 1.124217],
  ['Q4 2025', '2025-12-31', 'SAHPF VI REIT, L.P.', 'USD', 5_000_000, 1_950_000,
    -465, 0, 1_869_737, 1_949_535, 3_050_000, 1.175, 0.958839],
  ['Q1 2026', '2026-03-31', 'Northern III (D) AB', 'SEK', 56_000_000, 27_293_554.54,
    101_394.17, 0, 29_984_971.95, 27_394_948.71, 28_706_445.46, 10.943, 1.09861],
  ['Q1 2026', '2026-03-31', 'SAHPF VI REIT, L.P.', 'USD', 5_000_000, 2_100_000,
    23_572, 0, 1_963_350, 2_123_572, 2_900_000, 1.1498, 0.934929],
]);

const FUND_HISTORY = sheet('12_IN_FundHistory', [
  ['INPUT — QUARTERLY SERIES AT FUND LEVEL'],
  [],
  ['Quarter', 'Period end', 'LP commitment', 'LP capital called', 'Distributions',
    'Cum. investment gains', 'NAV Class C', 'Cash & equivalents', 'Formation expense',
    'Portfolio value', 'Liabilities', 'Shares'],
  ['Q4 2025', '2025-12-31', 10_000_000, 6_300_000, 0, 226_510, 5_416_112.06,
    1_269_922.82, 245_792.76, 4_098_330.7, -196_934.22, 6_300_000],
  ['Q1 2026', '2026-03-31', 10_000_000, 6_300_000, 0, 159_888.43, 5_215_795.97,
    732_616.95, 225_272.03, 4_447_663.11, -188_756.12, 6_300_000],
]);

const CASHFLOWS = sheet('13_IN_Cashflows', [
  ['INPUT — CAPITAL CALLS AND DISTRIBUTIONS'],
  [],
  ['', 'Date', 'Transaction', 'Commitment', 'Called', 'Distributed', 'Net flow', 'Unfunded', 'Notes'],
  ['', '2024-03-11', 'Commitment', 10_000_000, 0, 0, 0, 10_000_000, 'First close.'],
  ['', '2024-03-22', 'Drawdown #1', 0, 2_000_000, 0, -2_000_000, 8_000_000],
  ['', '2025-10-08', 'Drawdown #2', 0, 4_300_000, 0, -4_300_000, 3_700_000],
  ['', '', 'Totals', 10_000_000, 6_300_000, 0, -6_300_000, 3_700_000],
]);

const TARGET_FUNDS = sheet('14_IN_TargetFunds', [
  ['INPUT — TARGET FUNDS'],
  [],
  ['A. CLASSIFICATION ATTRIBUTES'],
  ['', 'Target fund', 'CCY', 'Asset class', 'Sector', 'Region', 'Country (domicile)', 'Vintage'],
  ['', 'Northern III (D) AB', 'SEK', 'Private Equity', 'Circular Economy', 'Europe', 'Sweden', 2023],
  ['', 'SAHPF VI REIT, L.P.', 'USD', 'Real Estate', 'Affordable Housing', 'North America', 'USA', 2023],
  [],
  ['B. FACT BOX — NORTHERN III AB (slide 6)'],
  ['', 'Fund Manager', 'Northern AB'],
  ['', 'Fund Size (SEK)', 3_061_200_000],
  ['', 'Implied interest %', 0.018293],
  [],
  ['D. PORTFOLIO COMPANIES — NORTHERN III AB (SEK m)'],
  ['', 'Company', 'Country', 'Sector', 'Sub-sector', 'FM Stake', 'Entry year', 'Invest.',
    'Distrib. / Realization', 'Current Value', 'PFDB name'],
  ['', 'Westgroup', 'Sweden', 'CE Materials', 'Waste Management', 0.614, 2023,
    169.732848, 0, 424.33162, 'Westgroup'],
  ['', 'evis (fka Insort)', 'Austria', 'CE Services', 'Manufacturing', 0.694, 2023,
    325.496278, 0, 401.831165, 'Insort'],
  ['', 'Total Unrealized', '', '', '', '', '', 495.229126, 0, 826.162785],
  [],
  ['E. PORTFOLIO ASSETS — SAHPF VI (USD m)'],
  ['', 'Property', 'Country', 'Sector', 'State', 'FM Stake', 'Entry year', 'Invest.',
    'Distrib. / Realization', 'Current Value', 'PFDB name'],
  ['', 'Taurus Hill', 'USA', 'Aff. Housing', 'MA', 0.95, 2024, 20.569162, 0, 19.666482, 'Taurus Hill'],
  ['', 'Belmont Tower', 'USA', 'Aff. Housing', 'IL', 0.44, 2024, 12.563764, 0.783056, 17.103566, 'Belmont Tower'],
  [],
  ['F. IMPACT KPIs — NORTHERN III (slide 6)'],
  ['', 'Portfolio KPI', 'Unit', 'Contributors', 'Value', 'Period'],
  ['', 'Emissions reduction', 'tCO2e', 'Westgroup', 591, '2025YE'],
  ['', 'Green certification', 'Properties', '', '1 of 8 achieved', 'Q1 2026'],
  [],
  ['H. NARRATIVES'],
  ['', 'Fund Summary (slide 3)', 'The fund deployed a further SEK 3.2m in the quarter.'],
  ['', 'Significant Developments (slide 6)', ''],
]);

const PFDB = sheet('15_IN_PFDB', [
  ['INPUT — FUND DATABASE, portfolio extract'],
  [],
  ['A. FUNDTX — cumulative position'],
  ['', 'Target fund', 'CCY', 'Commitment', 'Capital calls (cum)'],
  ['', 'Northern III AB', 'SEK', 56_000_000, 27_293_554],
  [],
  ['B. FUNDTX — transactions in the reporting quarter'],
  ['', 'Date', 'CCY', 'Target fund', 'Description', 'Capital call CCY', 'NAV CCY',
    'Cash paid EUR', 'FX at trade date'],
  ['', '2026-02-02', 'USD', 'Southern Affordable Housing Preservation Fund VI', 'CC8',
    150_000, 0, 126_689, 1.184],
  ['', '2026-03-30', 'SEK', 'Northern III AB', 'DD11', 3_161_012, 0, 289_842, 10.906],
  ['', '2026-03-31', 'USD', 'Southern Affordable Housing Preservation Fund VI', 'NAV',
    0, 1_963_350, 0, 1.15],
  [],
  ['C. COMPQ — portfolio companies'],
  ['', 'Target fund', 'CCY', 'Company (PFDB name)', 'Country', 'Sector (PFDB)', 'FM Stake (PFDB)'],
  ['', 'Northern III AB', 'SEK', 'Westgroup', 'Sweden', 'CE Materials', 0.65],
  ['', 'Northern III AB', 'SEK', 'Insort', 'Austria', 'CE Services', 0.71],
]);

// Computed from the tabs above, and therefore never read.
const OUTPUT = sheet('21_Portfolio', [
  ['OUTPUT — SLIDE 5 · Portfolio'],
  ['', '', 'Northern III', 'SAHPF VI', 'Total'],
  ['', 'NAV (€)', 2_740_105.27, 1_707_557.84, 4_447_663.11],
  ['', 'MoIC', 1.09861, 0.934929, 1.029418],
]);

const CHECKS = sheet('90_Checks', [
  ['RECONCILIATIONS'],
  [],
  ['', '#', 'Check', 'Value A', 'Value B', 'Difference', 'Status', 'Comment'],
  ['', 1, 'SNA: NAV = Assets + Liabilities', 5_216_795.97, 5_216_795.97, 0, 'OK', ''],
  ['', 2, 'Cumulative FX effect', 4_320_561.09, 4_284_658.83, 35_902.26, 'INFO',
    'Column A converts at closing FX; column B is the historical cost.'],
  [],
  ['KNOWN AND DELIBERATE DIFFERENCES VS THE Q4 2025 DECK'],
  ['', '', 'Topic', 'Published Q4 2025', 'New basis', '', '', 'Why'],
  ['', '', 'SAHPF VI equalisation', 'USD (465)', 'USD 23 572', '', '',
    'The database records a refund the administrator has not booked.'],
]);

const RECON = sheet('91_PFDB_Recon', [
  ['CONSISTENCY CHECK — DATABASE vs NAV PACK'],
  [],
  ['A. TARGET FUND CAPITAL ACCOUNTS'],
  ['', '#', 'Check', 'PFDB', 'NAV Pack', 'Difference', 'Status', 'Comment'],
  ['', 1, 'Northern III — commitment (SEK)', 56_000_000, 56_000_000, 0, 'OK', ''],
  ['', 2, 'SAHPF VI — equalisation (USD)', -465, 23_572, -24_037, 'DIFF',
    'OPEN: a refund of USD 24,037 the administrator has not booked.'],
]);

const SHEETS = [README, CONTROL, NAV_PACK, TF_HISTORY, FUND_HISTORY, CASHFLOWS,
  TARGET_FUNDS, PFDB, OUTPUT, CHECKS, RECON];

const plan = planStagedImport(SHEETS, { vehicleId: 'veh-two', recordedAt: '2026-06-01T00:00:00.000Z' });
const northern = plan.positions.find((p) => p.name.startsWith('Northern'))!;
const sahpf = plan.positions.find((p) => p.name.startsWith('SAHPF'))!;
const value = (metric: string, period = '2026Q1', id = 'veh-two') =>
  plan.metrics.find((m) => m.metric === metric && m.period === period && m.scope.id === id)?.value;

describe('recognising a staged reporting support file', () => {
  it('knows one by its numbering and its control tab', () => {
    expect(isStagedSupport(SHEETS)).toBe(true);
  });

  it('is not fooled by a workbook with no control tab', () => {
    expect(isStagedSupport([NAV_PACK, TF_HISTORY, OUTPUT])).toBe(false);
  });

  it('is not fooled by a control tab with no inputs beside it', () => {
    expect(isStagedSupport([CONTROL, OUTPUT])).toBe(false);
  });

  it('takes the product name from the masthead that states a legal form', () => {
    // Not `TWO — Quarterly Reporting Process`, which describes the file, and
    // not `PERIOD PARAMETERS`, which describes a tab.
    expect(summariseStaged(SHEETS)?.fund).toBe('Two Rivers Fund SCS SICAV-RAIF');
  });

  it('summarises what is in it', () => {
    const summary = summariseStaged(SHEETS)!;
    expect(summary.currency).toBe('EUR');
    expect(summary.reportingDate).toBe('2026-03-31');
    expect(summary.holdings).toBe(2);
    expect(summary.quarters).toBe(3);
    expect(summary.companies).toBe(4);
    expect(summary.movements).toBe(3);
    // The INFO and the DIFF; the two that read OK are not findings.
    expect(summary.findings).toBe(2);
  });
});

describe('what the reader files', () => {
  it('builds the balance sheet so the net asset value closes on it', () => {
    const sheets = plan.balanceSheets.find((b) => b.period === '2026Q1')!;
    expect(sheets.cash).toBeCloseTo(726_766.95, 2);
    // The deferred formation expense is an asset the pack carries above the
    // line, so it sits with the receivables rather than being netted away.
    expect(sheets.otherAssets).toBeCloseTo(231_122.03, 2);
    expect(sheets.accruedExpenses).toBeCloseTo(188_756.12, 2);
    expect(sheets.cash + sheets.otherAssets + 4_447_663.11 - sheets.accruedExpenses)
      .toBeCloseTo(5_216_795.97, 2);
  });

  it('takes the earlier quarters from the fund history', () => {
    const prior = plan.balanceSheets.find((b) => b.period === '2025Q4')!;
    expect(prior.cash).toBeCloseTo(1_269_922.82, 2);
    expect(prior.accruedExpenses).toBeCloseTo(196_934.22, 2);
    expect(plan.balanceSheets).toHaveLength(2);
  });

  it('values every holding in every quarter it is stated for', () => {
    expect(plan.valuations).toHaveLength(6);
    const at = (id: string, period: string) =>
      plan.valuations.find((v) => v.positionId === id && v.period === period)!;
    expect(at(northern.id, '2026Q1').nav).toBeCloseTo(29_984_971.95, 2);
    expect(at(northern.id, '2026Q1').drawnCumulative).toBeCloseTo(27_394_948.71, 2);
    expect(at(sahpf.id, '2025Q4').nav).toBeCloseTo(1_869_737, 2);
  });

  it('turns the pack gain signs, so a gain is positive', () => {
    // The pack states a gain as a credit and therefore negative. Northern is
    // worth more than it cost and SAHPF less; filed as they arrive, the two
    // would be reported the wrong way round.
    expect(value('pack.unrealisedGain', '2026Q1', northern.id)).toBeCloseTo(245_725.09, 2);
    expect(value('pack.unrealisedGain', '2026Q1', sahpf.id)).toBeCloseTo(-117_393.42, 2);
    expect(value('pack.fxGain', '2026Q1', northern.id)).toBeCloseTo(59_288.68, 2);
  });

  it('signs investor calls into the vehicle and portfolio calls out of it', () => {
    const called = plan.cashflows.filter((c) => c.investorId && c.type === 'Capital Call');
    expect(called.reduce((sum, c) => sum + c.amount, 0)).toBeCloseTo(6_300_000, 2);
    expect(called.every((c) => c.amount > 0)).toBe(true);
    const paid = plan.cashflows.filter((c) => c.positionId);
    expect(paid.every((c) => c.amount < 0)).toBe(true);
    expect(paid.find((c) => c.positionId === northern.id)!.amount).toBeCloseTo(-3_161_012, 2);
  });

  it('matches a holding the database spells out and the pack abbreviates', () => {
    // `Southern Affordable Housing Preservation Fund VI` against `SAHPF VI`.
    const paid = plan.cashflows.filter((c) => c.positionId === sahpf.id);
    expect(paid).toHaveLength(1);
    expect(paid[0].amount).toBeCloseTo(-150_000, 2);
    expect(paid[0].date).toBe('2026-02-02');
    expect(plan.problems.some((p) => /not one of the holdings/.test(p))).toBe(false);
  });

  it('does not turn a row with no call into one', () => {
    // The third row of the transactions block states a valuation, not a payment.
    expect(plan.cashflows.filter((c) => c.positionId)).toHaveLength(2);
  });

  it('files one investor for one partner, and says it invented the name', () => {
    expect(plan.investors).toHaveLength(1);
    expect(plan.investors[0].name).toBe('Class C limited partner');
    expect(plan.investors[0].commitment).toBe(10_000_000);
    expect(plan.notes.some((n) => /does not name them/.test(n))).toBe(true);
  });

  it('keeps the administrator rates one euro at a time', () => {
    expect(plan.fxRates.every((r) => r.base === 'EUR')).toBe(true);
    const closing = plan.fxRates.filter((r) => r.authority === 'administrator');
    expect(closing.find((r) => r.quote === 'SEK' && r.period === '2026Q1')?.rate).toBe(10.943);
    expect(closing.find((r) => r.quote === 'USD' && r.period === '2025Q4')?.rate).toBe(1.175);
    // Three quarters times two currencies, stated three times over and filed once.
    expect(closing).toHaveLength(6);
  });

  it('keeps the rate a payment settled at without letting it pass for a fixing', () => {
    const trade = plan.fxRates.filter((r) => r.authority === 'manual');
    expect(trade).toHaveLength(2);
    expect(trade.find((r) => r.quote === 'SEK')?.rate).toBe(10.906);
    expect(trade.find((r) => r.quote === 'SEK')?.date).toBe('2026-03-30');
  });

  it('scales a look-through table out of the millions it is written in', () => {
    const westgroup = plan.assets.find((a) => a.name === 'Westgroup')!;
    const valued = plan.assetValuations.find((v) => v.assetId === westgroup.id)!;
    expect(valued.unrealised).toBeCloseTo(424_331_620, 0);
    expect(valued.invested).toBeCloseTo(169_732_848, 0);
    const belmont = plan.assets.find((a) => a.name === 'Belmont Tower')!;
    expect(plan.assetValuations.find((v) => v.assetId === belmont.id)!.realised)
      .toBeCloseTo(783_056, 0);
    expect(belmont.status).toBe('Partially Realised');
  });

  it('keeps the target fund stake beside the database stake rather than instead of it', () => {
    const westgroup = plan.assets.find((a) => a.name === 'Westgroup')!;
    expect(westgroup.ownership).toBe(0.614);
    expect(value('database.ownership', '2026Q1', westgroup.id)).toBe(0.65);
    const evis = plan.assets.find((a) => a.name.startsWith('evis'))!;
    expect(evis.attributes?.databaseName).toBe('Insort');
    expect(evis.currency).toBe('SEK');
  });

  it('keeps the sub-sector of a company and the state of a property under one name', () => {
    expect(plan.assets.find((a) => a.name === 'Westgroup')!.attributes?.detail)
      .toBe('Waste Management');
    expect(plan.assets.find((a) => a.name === 'Taurus Hill')!.attributes?.detail).toBe('MA');
  });

  it('keeps the accounts, the operations and the series at fund level', () => {
    expect(value('tb.10030.ending')).toBeCloseTo(4_284_658.83, 2);
    expect(value('tb.10010.debit')).toBeCloseTo(420_169.7, 2);
    expect(value('pl.ytd.totalCharges')).toBeCloseTo(-137_838.34, 2);
    expect(value('sna.nav')).toBeCloseTo(5_216_795.97, 2);
    expect(value('fund.navClassC', '2025Q4')).toBeCloseTo(5_416_112.06, 2);
    expect(value('fund.cumInvestmentGains')).toBeCloseTo(159_888.43, 2);
  });

  it('dates an impact figure by the period it was measured for', () => {
    expect(value('impact.emissionsReduction', '2025Q4', northern.id)).toBe(591);
    const written = plan.metrics.find((m) => m.metric === 'impact.greenCertification');
    expect(written?.text).toBe('1 of 8 achieved');
    expect(written?.period).toBe('2026Q1');
  });

  it('keeps a narrative that is written and reports one that is not', () => {
    expect(plan.metrics.find((m) => m.metric === 'narrative.fundSummarySlide3')?.text)
      .toMatch(/deployed a further/);
    expect(plan.problems.some((p) => /1 of the report's narratives are not written/.test(p)))
      .toBe(true);
  });
});

describe('what the reader refuses to do', () => {
  it('does not read the computed tabs', () => {
    // `21_Portfolio` states a portfolio MoIC of 1.029418 and NAVs in euro. Every
    // one of them is a formula over the input tabs, so filing them would be
    // filing the same fact twice and then checking it against itself.
    expect(plan.metrics.some((m) => m.value === 1.029418)).toBe(false);
    expect(plan.notes.some((n) => /computed tab\(s\) were not read/.test(n))).toBe(true);
  });

  it('carries the file\'s own unresolved checks through, in its own words', () => {
    expect(plan.problems.some((p) => /a refund of USD 24,037/.test(p) && /\[DIFF\]/.test(p)))
      .toBe(true);
    expect(plan.notes.some((n) => /Cumulative FX effect/.test(n))).toBe(true);
    // The two checks that read OK say nothing the figures do not.
    expect(plan.problems.some((p) => /commitment \(SEK\)/.test(p))).toBe(false);
  });

  it('carries what changed against the quarter last published', () => {
    expect(plan.notes.some((n) => /Changed against the last published quarter — SAHPF VI equalisation/.test(n)))
      .toBe(true);
  });

  it('names the quarter where total drawn moves further than the cash did', () => {
    // Between Q4 2025 and Q1 2026 the equalisation is restated rather than
    // charged: SAHPF's drawn moves 174,037 where 150,000 was paid. A quarter's
    // deployment taken from the drawn column is overstated by the difference.
    const said = plan.notes.filter((n) => /is the equalisation/.test(n));
    expect(said.some((n) => /24,037/.test(n) && /2026Q1/.test(n))).toBe(true);
    expect(said.some((n) => /6,999.82/.test(n) && /2026Q1/.test(n))).toBe(true);
  });

  it('says nothing about a trial balance that reconciles', () => {
    expect(plan.problems.some((p) => /trial balance/.test(p))).toBe(false);
  });

  it('reports a trial balance that does not add up', () => {
    const broken = SHEETS.map((s) => (s === NAV_PACK
      ? sheet('10_IN_NAVPack', NAV_PACK.rows.map((row) => (String(row[1]).startsWith('10030')
        ? ['', '10030 - Investments', 3_868_704.85, 415_953.98, 0, 9_999_999]
        : row)))
      : s));
    const bad = planStagedImport(broken, { vehicleId: 'veh-two' });
    expect(bad.problems.some((p) => /does not add up on 1 account/.test(p))).toBe(true);
    expect(bad.problems.some((p) => /does not net to zero/.test(p))).toBe(true);
  });

  it('refuses to apportion calls between partners it cannot name', () => {
    const many = SHEETS.map((s) => (s === CONTROL
      ? sheet('01_Control', CONTROL.rows.map((row) => (row[1] === 'Number of Limited Partners'
        ? ['', 'Number of Limited Partners', 7]
        : row)))
      : s));
    const plural = planStagedImport(many, { vehicleId: 'veh-two' });
    expect(plural.investors).toHaveLength(0);
    expect(plural.cashflows.some((c) => c.investorId)).toBe(false);
    expect(plural.problems.some((p) => /states 7 limited partners and names none/.test(p)))
      .toBe(true);
  });

  it('says when the control tab and the history disagree', () => {
    const stale = SHEETS.map((s) => (s === CONTROL
      ? sheet('01_Control', CONTROL.rows.map((row) => (row[1] === 'LP capital called'
        ? ['', 'LP capital called', 5_000_000]
        : row)))
      : s));
    const drifted = planStagedImport(stale, { vehicleId: 'veh-two' });
    expect(drifted.problems.some((p) => /disagree on capital called/.test(p))).toBe(true);
  });

  it('throws on a workbook that states no quarter', () => {
    expect(() => planStagedImport([NAV_PACK, TF_HISTORY], { vehicleId: 'veh-two' }))
      .toThrow(/not a staged support file/);
  });
});
