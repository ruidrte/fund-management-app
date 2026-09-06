/**
 * Reading an LP capital master.
 *
 * What is pinned is the handful of judgements the workbook does not state, and
 * each is a place where a plausible wrong answer is available: that a transfer
 * between two investors nets to nothing at fund level, that a company held in
 * several share classes is not apportioned across them, that two accounts whose
 * names differ only in a suffix are two accounts, that a liability signed
 * negative in the accounts is a positive amount to deduct, and that the price
 * of a unit is worked out from the file rather than assumed.
 */

import { describe, expect, it } from 'vitest';
import { isMasterWorkbook, planMasterImport, summariseMaster } from '../src/ingest/master';
import { isSupportWorkbook } from '../src/ingest/support';
import { isMandateWorkbook } from '../src/ingest/mandate';
import { analyse } from '../src/engine';
import { DEFAULT_CONVENTIONS } from '../src/domain/types';
import {
  masterSheets as workbook, statedSheets, REGISTER, TRIAL_BALANCE,
} from './fixtures/master';

const plan = () => planMasterImport(workbook(), { vehicleId: 'veh-nw' });

describe('recognising the workbook', () => {
  it('needs an investors’ register and an investments ledger', () => {
    expect(isMasterWorkbook(workbook())).toBe(true);
    expect(isMasterWorkbook([REGISTER])).toBe(false);
    expect(isMasterWorkbook([TRIAL_BALANCE])).toBe(false);
  });

  it('is not mistaken for either of the other two workbook shapes', () => {
    expect(isSupportWorkbook(workbook())).toBe(false);
    expect(isMandateWorkbook(workbook())).toBe(false);
  });

  it('reads what it is about and when it was built for', () => {
    const summary = summariseMaster(workbook())!;
    expect(summary.fund).toBe('Northwind Ventures Fund SCA SICAV-RAIF');
    expect(summary.reportingDate).toBe('2026-06-30');
    expect(summary.holdings).toBe(2);
    expect(summary.instruments).toBe(3);
    expect(summary.investors).toBe(5);
  });
});

describe('a company is a position and a share class is an asset', () => {
  it('holds the companies, with the stake the portfolio sheet states', () => {
    const positions = plan().positions;
    expect(positions.map((p) => p.name).sort())
      .toEqual(['Continuum Labs Inc.', 'Halyard Robotics']);
    const halyard = positions.find((p) => p.name === 'Halyard Robotics')!;
    expect(halyard.kind).toBe('direct-investment');
    // Stated once on every tranche of the same company, so the largest is the
    // commitment rather than the sum of them.
    expect(halyard.commitment).toBe(900_000);
    expect(halyard.ownership).toBe(0.0375);
  });

  it('holds a share class under the company that issued it', () => {
    const built = plan();
    const halyard = built.positions.find((p) => p.name === 'Halyard Robotics')!;
    expect(built.assets.filter((a) => a.positionId === halyard.id).map((a) => a.name).sort())
      .toEqual(['Common (CS)', 'Series A Preferred (SA)']);
    expect(built.assets.every((a) => a.attributes?.company)).toBe(true);
  });

  it('matches a company across sheets through the suffix it is registered under', () => {
    // The ledger writes `Continuum Labs Inc.` and the portfolio sheet the same;
    // a suffix is not a different company, and a weaker match is not a match.
    const built = plan();
    const continuum = built.positions.find((p) => p.name === 'Continuum Labs Inc.')!;
    // The country reaches the share class, which is what an exposure view reads.
    expect(built.assets.find((a) => a.positionId === continuum.id)?.country).toBe('USA');
  });

  it('carries the rate a dollar tranche was converted at', () => {
    expect(plan().fxRates.map((r) => `${r.base}/${r.quote}|${r.date}|${r.rate}`))
      .toEqual(['USD/EUR|2025-08-20|1.1']);
  });
});

describe('what each company is worth', () => {
  it('takes the approved value where the company is held one way', () => {
    const built = plan();
    const continuum = built.positions.find((p) => p.name === 'Continuum Labs Inc.')!;
    const valued = built.valuations.find((v) => v.positionId === continuum.id)!;
    expect(valued.nav).toBe(260_000);
    expect(valued.period).toBe('2026Q2');

    const asset = built.assets.find((a) => a.positionId === continuum.id)!;
    expect(built.assetValuations.find((v) => v.assetId === asset.id)?.unrealised).toBe(260_000);
  });

  it('refuses to split a company held in several classes, and names it', () => {
    const built = plan();
    const halyard = built.positions.find((p) => p.name === 'Halyard Robotics')!;
    // The company is still valued; it is the split across its classes that is
    // left to the approval letter rather than apportioned on a basis nobody
    // chose.
    expect(built.valuations.find((v) => v.positionId === halyard.id)?.nav).toBe(1_100_000);
    const classes = built.assets.filter((a) => a.positionId === halyard.id).map((a) => a.id);
    expect(built.assetValuations.filter((v) => classes.includes(v.assetId))).toEqual([]);
    expect(built.problems.some((p) => /held in 2 share classes/.test(p))).toBe(true);
  });
});

describe('the investors', () => {
  it('keeps two accounts whose names differ only in a suffix apart', () => {
    const built = plan();
    const studio = built.investors.filter((i) => i.name.startsWith('NORTHWIND STUDIO AG'));
    expect(studio).toHaveLength(2);
    expect(new Set(studio.map((i) => i.id)).size).toBe(2);
    expect(studio.map((i) => i.shareClass).sort()).toEqual(['Founder', 'LP']);
  });

  it('nets a transfer between two investors to nothing at fund level', () => {
    const calls = plan().cashflows.filter((c) => c.investorId && c.type === 'Capital Call');
    // 300,000 + 200,000 + 29,000 + 1,000 called, then 100,000 moved from one
    // account to another. The fund called 530,000, not 730,000.
    expect(calls.reduce((sum, c) => sum + c.amount, 0)).toBe(530_000);
  });

  it('leaves the transferor short by what they transferred away', () => {
    const built = plan();
    const from = built.investors.find((i) => i.name === 'NORTHWIND STUDIO AG [LP]')!;
    const to = built.investors.find((i) => i.name === 'ALDGATE PARTNERS LLP')!;
    const called = (id: string) => built.cashflows
      .filter((c) => c.investorId === id && c.type === 'Capital Call')
      .reduce((sum, c) => sum + c.amount, 0);
    expect(called(from.id)).toBe(200_000);
    expect(called(to.id)).toBe(100_000);
    expect(from.commitment).toBe(500_000);
  });

  it('keeps a fee charged inside the commitment apart from one charged outside', () => {
    const fees = plan().cashflows.filter((c) => c.investorId && c.type === 'Fee');
    expect(fees.filter((f) => f.affectsCommitment)).toHaveLength(0);
    expect(fees.reduce((sum, f) => sum + f.amount, 0)).toBe(2_000 + 1_000 + 500);
    const opex = plan().cashflows.filter((c) => c.type === 'Expense');
    expect(opex.reduce((sum, f) => sum + f.amount, 0)).toBe(1_500);
  });

  it('works the price of a unit out of the file rather than assuming it', () => {
    // 530,000 called against 1,030 units in issue is 514.56 a unit, which is
    // not a round price — so no unit count is filed at all.
    expect(plan().metrics.some((m) => m.metric === 'units.held')).toBe(false);
    // Told what a unit costs, it files them.
    const told = planMasterImport(workbook(), { vehicleId: 'veh-nw', unitPrice: 1_000 });
    const units = told.metrics.filter((m) => m.metric === 'units.held');
    expect(units.reduce((sum, m) => sum + (m.value ?? 0), 0)).toBe(530);
  });
});

describe('an investor who has called nothing', () => {
  const view = () => {
    const built = plan();
    return analyse({
      client: {
        id: 'c', name: 'A house', shortName: 'H', reportingCurrency: 'EUR',
        conventions: DEFAULT_CONVENTIONS,
      },
      vehicles: [{
        id: 'veh-nw', clientId: 'c', kind: 'direct-fund', name: 'Northwind', shortName: 'NW',
        currency: 'EUR', unitScale: 1, inceptionDate: '2024-01-15',
        investorCommitment: 1_030_000, status: 'Investing',
      }],
      positions: built.positions,
      assets: built.assets,
      investors: built.investors,
      positionValuations: built.valuations,
      assetValuations: built.assetValuations,
      cashflows: built.cashflows,
      balanceSheets: built.balanceSheets,
      metrics: built.metrics,
      fxRates: built.fxRates,
    }, { clientId: 'c', vehicleId: 'veh-nw', period: '2026Q2' });
  };

  it('is shown as having called nothing, not a share of what others called', () => {
    // Harbour Trust called; Aldgate received a transfer. The fund's own
    // register is complete, so an investor with no movements has made none —
    // and giving them a pro-rata share of the fund's called capital would be a
    // capital call they never received.
    const idle = view().net.investors.find((row) => row.investor.name === 'HARBOUR TRUST')!;
    expect(idle.called).toBeGreaterThan(0);

    const founder = view().net.investors.find(
      (row) => row.investor.name === 'NORTHWIND VENTURES SARL [GP]',
    )!;
    expect(founder.called).toBe(1_000);
    expect(founder.allocated).toBe(false);
  });

  it('adds the capital accounts up to what the fund called, and checks it', () => {
    const net = view().net;
    const total = net.investors.reduce((sum, row) => sum + row.called, 0);
    expect(Math.round(total)).toBe(Math.round(net.product.called));

    const identity = view().checks.results.find((row) => row.id === 'investor_called_sum')!;
    expect(identity.status).toBe('pass');
  });
});

describe('the accounts', () => {
  it('turns a liability signed negative into an amount to deduct', () => {
    const sheet = plan().balanceSheets.find((b) => b.period === '2026Q2')!;
    expect(sheet.cash).toBe(120_000);
    expect(sheet.otherAssets).toBe(4_000);
    expect(sheet.currentLiabilities).toBe(2_500);
    expect(sheet.accruedExpenses).toBe(13_000);
  });

  it('keeps every account of the trial balance, by account rather than by label', () => {
    const built = plan();
    const audit = built.metrics.find(
      (m) => m.metric === 'pl.60101600' && m.period === '2026Q2',
    );
    expect(audit?.value).toBe(-8_000);
    expect(audit?.scope.kind).toBe('vehicle');
    expect(built.metrics.some((m) => m.metric === 'bs.13002020')).toBe(true);
  });

  it('keeps what the change log says was restated', () => {
    const basis = plan().metrics.find((m) => m.metric === 'narrative.basis');
    expect(basis?.text).toContain('superseded');
  });
});

describe('the capital account statements', () => {
  const built = () => planMasterImport(statedSheets(), { vehicleId: 'veh-ut' });

  it('reads what each investor has, rather than working it out', () => {
    const facts = built().metrics.filter((m) => m.metric === 'capitalAccount');
    expect(facts).toHaveLength(3);
    expect(facts.map((m) => m.value).sort((a, b) => (a ?? 0) - (b ?? 0)))
      .toEqual([-80_000, 240_000, 840_000]);
  });

  it('keeps two accounts of one holder apart by the class each is in', () => {
    // `HALYARD VENTURES AG` appears twice on the statement, once as an LP and
    // once as the founder. Matching on the name alone would give one of them
    // both figures and the other none.
    const facts = built().metrics.filter((m) => m.metric === 'capitalAccount');
    const founder = facts.find((m) => m.scope.id.includes('founder'));
    expect(founder?.value).toBe(-80_000);
    expect(built().problems.some((p) => /match no investor/.test(p))).toBe(false);
  });

  it('reads the shares held at the statement date', () => {
    const units = built().metrics.filter((m) => m.metric === 'units');
    expect(units.map((m) => m.value).sort((a, b) => (a ?? 0) - (b ?? 0)))
      .toEqual([100, 200, 700]);
    expect(units.every((m) => m.period === '2026Q1')).toBe(true);
  });

  it('does not mistake the totals column for another investor', () => {
    expect(built().metrics.filter((m) => m.metric === 'units')).toHaveLength(3);
  });

  it('says nothing of the kind where the book carries no statements', () => {
    const plain = planMasterImport(workbook(), { vehicleId: 'veh-ut' });
    expect(plain.metrics.some((m) => m.metric === 'capitalAccount')).toBe(false);
  });
});

describe('the currency a holding is kept in', () => {
  it('is the fund\'s, because that is what the figures beside it are in', () => {
    // The ledger states a dollar tranche and the euro figure the fund books it
    // at. Tagging the holding with the company's currency and then filing the
    // euro figures against it translates them a second time.
    const built = planMasterImport(workbook(), { vehicleId: 'veh-ut' });
    const dollar = built.positions.find((p) => p.name.startsWith('Continuum'))!;
    expect(dollar.currency).toBe('EUR');
    const call = built.cashflows.find(
      (c) => c.positionId === dollar.id && c.type === 'Capital Call',
    )!;
    expect(call.amount).toBe(-200_000);
    expect(call.currency).toBe('EUR');
  });
});
