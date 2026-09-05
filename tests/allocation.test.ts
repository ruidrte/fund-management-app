/**
 * Reading an asset allocation database.
 *
 * The fixture is the shape of a real one, with invented companies. What is
 * pinned is the handful of judgements the sheet does not state: that the
 * exposure column is already the product's own share and must not be scaled
 * again, that the sheet's units are settled against the book rather than
 * assumed, that a company split across sectors keeps its split, and that money
 * returned is not exposure.
 */

import { describe, expect, it } from 'vitest';
import {
  isAllocationWorkbook, planAllocationImport, summariseAllocation,
} from '../src/ingest/allocation';
import type { TableData } from '../src/ingest/types';

const serial = (iso: string): number =>
  Math.round((Date.parse(`${iso}T00:00:00Z`) - Date.UTC(1899, 11, 30)) / 86_400_000);

const HEADER = [
  'Asset', 'GP', 'Fund Name', 'Update', 'Source', 'Investment Quarter', 'Inv. Year',
  'Anlageart', 'Sektor', 'Risikoprofil', 'Region', 'Country', 'CCY',
  'Total Comm.', 'Invested (CCY)', 'Realized (CCY)', 'Unrealized (CCY)', 'Total Value (CCY)',
  'DPI', 'RPI', 'TVPI', 'Baltic Infra Ownership', 'FX',
  'Baltic Infra Comm (€)', 'Baltic Infra Invested (€)', 'Baltic Infra exposure (€)',
  'SFDR', 'UN SDG',
];

/** One row, given the handful of fields each test actually varies. */
const row = (
  asset: string, fund: string, gp: string, date: string, sector: string,
  over: Partial<{
    region: string; country: string; ccy: string; invested: number; realised: number;
    ownership: number; fx: number; exposure: number; sfdr: string; sdg: string;
  }> = {},
) => [
  asset, gp, fund, serial(date), 'CAS', 'Q1 2025', 2025,
  'Primärinvestition', sector, 'Core', over.region ?? 'EU', over.country ?? 'Deutschland',
  over.ccy ?? 'EUR',
  0, 0, over.realised ?? 0, 0, 0,
  0, 0, 0, over.ownership ?? 1, over.fx ?? 1,
  0, over.invested ?? 0, over.exposure ?? 0,
  over.sfdr ?? 'Art. 8', over.sdg ?? 'UN SDG 7',
];

const SHEET: TableData = {
  sheetName: 'Asset DB',
  rows: [
    ['Asset Database'],
    ['Baltic Infra'],
    ['Asset Entries'],
    [],
    [],
    HEADER,
    // A company split across two sectors, in thousands of the book's unit.
    row('Harbour Grid', 'BW 21', 'Baltic Wind', '2026-06-30', 'Elektrifizierung',
      { invested: 600, exposure: 700 }),
    row('Harbour Grid', 'BW 21', 'Baltic Wind', '2026-06-30', 'Umweltschonender Transport',
      { invested: 200, exposure: 300 }),
    // A company that has returned money: what came back is not exposure.
    row('Sound Fibre', 'SG II', 'Sound Capital', '2026-06-30', 'Kommunikationsinfrastruktur & Digitalisierung',
      { invested: 500, realised: 250, exposure: 400, region: 'UK', country: 'Vereinigtes' }),
  ],
};

const sheets = (): TableData[] => [SHEET];

/** The holdings these funds are, and what the book says they are worth. */
const holdings = { 'BW 21': 'pos-wind', 'SG II': 'pos-sound' };
const reference = { 'pos-wind': 1_000_000, 'pos-sound': 400_000 };
const plan = () => planAllocationImport(sheets(), { holdings, reference });

describe('recognising the sheet', () => {
  it('knows it by its per-company ledger', () => {
    expect(isAllocationWorkbook(sheets())).toBe(true);
    expect(isAllocationWorkbook([{ sheetName: 'Portfolio', rows: [['Asset']] }])).toBe(false);
  });

  it('reads the product, its funds and their managers from the sheet', () => {
    const summary = summariseAllocation(sheets())!;

    expect(summary.product).toBe('Baltic Infra');
    expect(summary.funds).toEqual([
      { name: 'BW 21', manager: 'Baltic Wind', companies: 1 },
      { name: 'SG II', manager: 'Sound Capital', companies: 1 },
    ]);
    // The currency comes from the exposure column's own heading.
    expect(summary.currency).toBe('EUR');
    expect(summary).toMatchObject({ companies: 2, rows: 3, last: '2026Q2' });
  });
});

describe('the units the sheet is kept in', () => {
  it('are settled against what the holdings are worth, not assumed', () => {
    const { assetValuations, notes } = plan();
    const total = assetValuations.reduce((sum, v) => sum + v.unrealised, 0);

    // 700 + 300 + 400 filed, against 1,400,000 held: the sheet is in thousands.
    expect(total).toBe(1_400_000);
    expect(notes.join(' ')).toContain('1,000s');
  });

  it('leaves the figures alone when the two already agree', () => {
    const { assetValuations, notes } = planAllocationImport(sheets(), {
      holdings,
      reference: { 'pos-wind': 1_000, 'pos-sound': 400 },
    });

    expect(assetValuations.reduce((sum, v) => sum + v.unrealised, 0)).toBe(1_400);
    expect(notes.join(' ')).not.toContain('1,000s');
  });

  it('takes the units most of the sheet agrees on, not the average', () => {
    // One holding filed in its own currency differs by a rate. It must not move
    // the answer, and it is reported rather than silently absorbed.
    const { assetValuations, notes } = planAllocationImport(sheets(), {
      holdings,
      reference: { 'pos-wind': 1_000_000, 'pos-sound': 348_000 },
    });

    expect(assetValuations.reduce((sum, v) => sum + v.unrealised, 0)).toBe(1_400_000);
    expect(notes.join(' ')).toContain('0.870x');
  });
});

describe('what counts as exposure', () => {
  it('is what is still held, not what came back', () => {
    const { assetValuations } = plan();
    const fibre = assetValuations.find((v) => v.assetId.includes('sound-fibre'))!;

    expect(fibre.unrealised).toBe(400_000);
    expect(fibre.realised).toBe(250_000);
    expect(fibre.invested).toBe(500_000);
  });

  it('is not scaled a second time by the share already applied to it', () => {
    const { assets } = plan();

    expect(assets.every((a) => a.ownership === 1)).toBe(true);
  });
});

describe('a company split across sectors', () => {
  it('keeps one row per sector, named so the split is visible', () => {
    const { assets, notes } = plan();
    const harbour = assets.filter((a) => a.name.startsWith('Harbour Grid'));

    expect(harbour.map((a) => a.name)).toEqual([
      'Harbour Grid — Electrification',
      'Harbour Grid — Clean Mobility',
    ]);
    expect(notes.join(' ')).toContain('split across sectors');
  });

  it('leaves a company with one sector under its own name', () => {
    expect(plan().assets.some((a) => a.name === 'Sound Fibre')).toBe(true);
  });
});

describe('the labels', () => {
  it('are translated where the sheet is written in German', () => {
    const { assets } = plan();
    const fibre = assets.find((a) => a.name === 'Sound Fibre')!;

    expect(fibre.sector).toBe('Communication Infrastructure & Digitalisation');
    expect(fibre.region).toBe('UK');
    expect(fibre.country).toBe('United Kingdom');
    expect(fibre.assetClass).toBe('Primary');
  });

  it('carry the sustainability classification the sheet files', () => {
    const { assets } = plan();

    expect(assets[0].esg).toEqual({ sfdr: 'Article 8', sdgs: [7] });
  });
});

describe('a fund nobody matched', () => {
  it('is left out, and said so rather than filed against a guess', () => {
    const { assets, problems } = planAllocationImport(sheets(), {
      holdings: { 'BW 21': 'pos-wind' },
    });

    expect(assets.every((a) => a.positionId === 'pos-wind')).toBe(true);
    expect(problems.join(' ')).toContain('"SG II" was not matched');
  });
});
