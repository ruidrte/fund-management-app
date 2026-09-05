/**
 * Reading an asset allocation database.
 *
 * The third shape a desk keeps: one row per company, per fund, per quarter,
 * with the sector, region, country and risk profile that the allocation charts
 * are built from. It is what makes look-through possible — the reporting
 * workbook stops at the funds, and this is what is inside them.
 *
 * The figure that matters is the one the sheet already computes: the product's
 * own exposure to each company, the fund's total scaled by the share the
 * product holds and translated into the reporting currency. Deriving it again
 * from the fund's totals would be a second opinion on a number the desk has
 * already formed, and the two would drift. Read as filed, the totals tie to the
 * reporting workbook holding by holding.
 *
 * Two things about the shape are worth knowing before reading the code:
 *
 *   A company can appear under more than one fund — two funds holding the same
 *   asset are two positions in it, not one — so a company is identified by the
 *   fund it sits in as well as by its name.
 *
 *   A company can also appear more than once under one fund, split across
 *   sectors. That split is the whole point of the sheet, so each sleeve is kept
 *   as its own row rather than merged into a single sector nobody chose.
 */

import { periodForDate, type PeriodId } from '../domain/period';
import type {
  Asset, AssetValuation, CurrencyCode, EsgClassification,
} from '../domain/types';
import type { TableData } from './types';
import type { Cell } from './workbook';

const SHEET = 'asset db';

/** The German labels this sheet is written in, and what they are in English. */
const SECTOR: Record<string, string> = {
  elektrifizierung: 'Electrification',
  'kommunikationsinfrastruktur & digitalisierung': 'Communication Infrastructure & Digitalisation',
  'energiespeicherung & -verteilung': 'Energy Storage & Distribution',
  'umweltschonender transport': 'Clean Mobility',
  'soziale infrastruktur': 'Social Infrastructure',
};

const REGION: Record<string, string> = {
  eu: 'EU',
  uk: 'UK',
  efta: 'EFTA',
  nordamerika: 'North America',
  andere: 'Rest of World',
};

const COUNTRY: Record<string, string> = {
  deutschland: 'Germany',
  frankreich: 'France',
  spanien: 'Spain',
  italien: 'Italy',
  niederlande: 'Netherlands',
  belgien: 'Belgium',
  osterreich: 'Austria',
  schweiz: 'Switzerland',
  usa: 'United States',
  vereinigtes: 'United Kingdom',
};

const KIND: Record<string, string> = {
  primarinvestition: 'Primary',
  sekundarinvestition: 'Secondary',
  'co-/direktinvestition': 'Co-/Direct',
};

const SFDR: Record<string, EsgClassification['sfdr']> = {
  'art. 6': 'Article 6',
  'art. 8': 'Article 8',
  'art. 9': 'Article 9',
};

export interface AllocationFund {
  /** The fund as this sheet names it, which is not the holding's name. */
  name: string;
  /** Its manager. "MA 22" matches nothing; "Equitix MA 22" matches its holding. */
  manager: string;
  companies: number;
}

export interface AllocationSummary {
  /** The product the sheet is headed with. */
  product: string;
  funds: AllocationFund[];
  companies: number;
  rows: number;
  /**
   * The currency the exposure column is written in, taken from its own
   * heading. It is the product's currency, not the fund's — the column has
   * already translated — so it is the currency the figures are filed under.
   */
  currency: CurrencyCode;
  first?: PeriodId;
  last?: PeriodId;
  /** Total exposure at the last quarter, for a sanity check before importing. */
  latestExposure: number;
}

export interface AllocationOptions {
  /** Fund name in the sheet -> the holding it belongs to in the book. */
  holdings: Record<string, string>;
  /**
   * What each of those holdings is worth in the book, at the sheet's last
   * quarter. An allocation sheet is often kept in thousands where the book is
   * in units, and nothing in either file says so. Comparing the two totals
   * settles it from evidence rather than by assumption — and when they do not
   * agree by a round factor, that is reported instead of scaled away.
   */
  reference?: Record<string, number>;
  recordedAt?: string;
}

export interface AllocationPlan {
  assets: Asset[];
  assetValuations: AssetValuation[];
  problems: string[];
  notes: string[];
  periods: PeriodId[];
}

/* ------------------------------------------------------------------ *
 * Cells
 * ------------------------------------------------------------------ */

function text(cell: Cell): string {
  return cell === null || cell === undefined ? '' : String(cell).trim();
}

function toNumber(cell: Cell): number | undefined {
  if (typeof cell === 'number' && Number.isFinite(cell)) return cell;
  if (typeof cell === 'string') {
    const parsed = Number(cell.replace(/[\s'’]/g, '').replace(/,(?=\d{3}\b)/g, ''));
    if (cell.trim() !== '' && Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function toDate(cell: Cell): string | undefined {
  const serial = toNumber(cell);
  if (serial !== undefined && serial > 20_000 && serial < 80_000) {
    return new Date(Date.UTC(1899, 11, 30) + serial * 86_400_000).toISOString().slice(0, 10);
  }
  const value = text(cell);
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (iso) return iso[0];
  const written = /^(\d{2})[./](\d{2})[./](\d{4})$/.exec(value);
  if (written) return `${written[3]}-${written[2]}-${written[1]}`;
  return undefined;
}

/** Lowercased and stripped of accents, for looking a label up in a glossary. */
function key(value: string): string {
  return value.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
}

function translate(dictionary: Record<string, string>, value: string): string {
  if (!value) return 'Unclassified';
  const found = dictionary[key(value)];
  if (found) return found;
  // A label the glossary does not carry is kept as written rather than
  // guessed at: an invented category is an allocation chart nobody can account
  // for.
  return value;
}

const SYMBOL: Record<string, CurrencyCode> = {
  '€': 'EUR', '$': 'USD', '£': 'GBP', 'chf': 'CHF', 'eur': 'EUR', 'usd': 'USD', 'gbp': 'GBP',
};

/** The currency named in a column heading, as `PAS Infra exposure (€)`. */
function currencyOf(heading: string): CurrencyCode | undefined {
  const inside = /\(([^)]+)\)/.exec(heading);
  if (!inside) return undefined;
  return SYMBOL[inside[1].trim().toLowerCase()] ?? SYMBOL[inside[1].trim()];
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'x';
}

/* ------------------------------------------------------------------ *
 * The sheet
 * ------------------------------------------------------------------ */

interface Row {
  line: number;
  asset: string;
  manager: string;
  fund: string;
  date: string;
  period: PeriodId;
  kind: string;
  sector: string;
  risk: string;
  region: string;
  country: string;
  currency: CurrencyCode;
  invested?: number;
  realised?: number;
  ownership?: number;
  fx?: number;
  /** Column AA: the product's own exposure, already scaled and translated. */
  exposure?: number;
  sfdr: string;
  sdg: string;
}

function table(sheets: TableData[]): TableData | undefined {
  return sheets.find((s) => s.sheetName.trim().toLowerCase() === SHEET);
}

const REQUIRED = ['asset', 'fund name', 'update', 'total value (ccy)'];

function headerRow(sheet: TableData): number {
  for (let i = 0; i < Math.min(sheet.rows.length, 15); i += 1) {
    const cells = sheet.rows[i].map((cell) => text(cell).toLowerCase());
    if (REQUIRED.every((name) => cells.includes(name))) return i;
  }
  return -1;
}

export function isAllocationWorkbook(sheets: TableData[]): boolean {
  const sheet = table(sheets);
  return Boolean(sheet) && headerRow(sheet!) >= 0;
}

/** The heading of the exposure column, whose bracket names the currency. */
function exposureHeading(sheets: TableData[]): string {
  const sheet = table(sheets);
  if (!sheet) return '';
  const header = headerRow(sheet);
  if (header < 0) return '';
  return sheet.rows[header]
    .map(text)
    .find((name) => /exposure/i.test(name)) ?? '';
}

function read(sheets: TableData[]): Row[] {
  const sheet = table(sheets);
  if (!sheet) return [];
  const header = headerRow(sheet);
  if (header < 0) return [];

  const at = new Map<string, number>();
  sheet.rows[header].forEach((cell, i) => {
    const name = text(cell).toLowerCase();
    if (name && !at.has(name)) at.set(name, i);
  });
  const column = (name: string) => at.get(name.toLowerCase()) ?? -1;
  // Three of the columns are named after the product — "PAS Infra exposure
  // (€)" — so they are found by what they say rather than by a name that is
  // different in every book.
  const matching = (pattern: RegExp) => {
    for (const [name, index] of at) if (pattern.test(name)) return index;
    return -1;
  };
  const str = (row: Cell[], name: string) =>
    (column(name) < 0 ? '' : text(row[column(name)]));
  const num = (row: Cell[], name: string) =>
    (column(name) < 0 ? undefined : toNumber(row[column(name)]));
  const like = (row: Cell[], pattern: RegExp) => {
    const index = matching(pattern);
    return index < 0 ? undefined : toNumber(row[index]);
  };

  const rows: Row[] = [];
  for (let i = header + 1; i < sheet.rows.length; i += 1) {
    const row = sheet.rows[i];
    const asset = str(row, 'Asset');
    if (!asset || asset.toLowerCase() === 'total') continue;
    const date = column('Update') < 0 ? undefined : toDate(row[column('Update')]);
    if (!date) continue;

    rows.push({
      line: i + 1,
      asset,
      manager: str(row, 'GP'),
      fund: str(row, 'Fund Name'),
      date,
      period: periodForDate(date),
      kind: str(row, 'Anlageart'),
      sector: str(row, 'Sektor'),
      risk: str(row, 'Risikoprofil'),
      region: str(row, 'Region'),
      country: str(row, 'Country'),
      currency: (str(row, 'CCY').toUpperCase() || 'EUR') as CurrencyCode,
      invested: like(row, /invested \(€|invested \(eur|invested \(chf|invested \(usd/i)
        ?? num(row, 'Invested (CCY)'),
      realised: num(row, 'Realized (CCY)') ?? num(row, 'Realised (CCY)'),
      ownership: like(row, /ownership/i),
      fx: num(row, 'FX'),
      exposure: like(row, /exposure/i),
      sfdr: str(row, 'SFDR'),
      sdg: str(row, 'UN SDG'),
    });
  }
  return rows;
}

export function summariseAllocation(sheets: TableData[]): AllocationSummary | undefined {
  if (!isAllocationWorkbook(sheets)) return undefined;
  const rows = read(sheets);
  const periods = [...new Set(rows.map((row) => row.period))].sort();
  const last = periods[periods.length - 1];

  const sheet = table(sheets)!;
  // The product's name is written above the table, in the second line of the
  // sheet's own heading.
  const heading = sheet.rows
    .slice(0, headerRow(sheet))
    .map((row) => row.map(text).filter(Boolean))
    .filter((cells) => cells.length === 1)
    .map((cells) => cells[0]);

  const funds = new Map<string, AllocationFund>();
  for (const row of rows) {
    if (!row.fund) continue;
    const held = funds.get(row.fund)
      ?? { name: row.fund, manager: row.manager, companies: 0 };
    held.manager = held.manager || row.manager;
    funds.set(row.fund, held);
  }
  for (const [name, fund] of funds) {
    fund.companies = new Set(
      rows.filter((row) => row.fund === name).map((row) => row.asset),
    ).size;
  }

  return {
    product: heading[1] ?? heading[0] ?? 'This sheet',
    funds: [...funds.values()],
    currency: currencyOf(exposureHeading(sheets)) ?? 'EUR',
    companies: new Set(rows.map((row) => `${row.fund}/${row.asset}`)).size,
    rows: rows.length,
    first: periods[0],
    last,
    latestExposure: rows
      .filter((row) => row.period === last)
      .reduce((total, row) => total + (row.exposure ?? 0), 0),
  };
}

/* ------------------------------------------------------------------ *
 * The plan
 * ------------------------------------------------------------------ */

export function planAllocationImport(
  sheets: TableData[], options: AllocationOptions,
): AllocationPlan {
  const rows = read(sheets);
  const currency = currencyOf(exposureHeading(sheets)) ?? 'EUR';
  const recordedAt = options.recordedAt ?? new Date().toISOString();
  const problems: string[] = [];
  const notes: string[] = [];
  const periods = new Set<PeriodId>();

  // A company split across sectors keeps one row per sleeve, and only then is
  // the sector added to its name — a company with one sector should not be
  // renamed for the sake of consistency with one that has three.
  const sleeves = new Map<string, Set<string>>();
  for (const row of rows) {
    const company = `${row.fund}/${row.asset}`;
    sleeves.set(company, (sleeves.get(company) ?? new Set()).add(row.sector));
  }

  // How the sheet's units relate to the book's, worked out by comparing the
  // exposure it files against what those holdings are worth. A round factor
  // across every matched fund is a unit; anything else is a disagreement, and
  // is reported rather than scaled away.
  const last = [...new Set(rows.map((row) => row.period))].sort().pop();
  let scale = 1;
  if (options.reference && last) {
    const filed = new Map<string, number>();
    for (const row of rows) {
      const positionId = options.holdings[row.fund];
      if (!positionId || row.period !== last || row.exposure === undefined) continue;
      filed.set(positionId, (filed.get(positionId) ?? 0) + row.exposure);
    }
    const ratios = [...filed.entries()]
      .filter(([id, sum]) => sum !== 0 && options.reference![id] !== undefined)
      .map(([id, sum]) => ({ id, ratio: options.reference![id] / sum }));

    if (ratios.length > 0) {
      // The median, not the mean: a holding whose net asset value is filed in
      // its own currency while this sheet is in the product's will differ by a
      // rate, and one such fund must not move the answer. Units are a property
      // of the sheet, so the figure most of it agrees on is the figure.
      const sorted = ratios.map((entry) => entry.ratio).sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      const rounded = Math.pow(10, Math.round(Math.log10(median)));

      if (rounded !== 1) {
        scale = rounded;
        notes.push(
          `The sheet is kept in ${rounded.toLocaleString('en-GB')}s of the book's unit, which is `
          + 'what its exposure works out to against these holdings, so its figures are brought '
          + 'onto the same scale.',
        );
      }

      const off = ratios.filter((entry) => Math.abs(entry.ratio / rounded - 1) > 0.01);
      for (const entry of off) {
        notes.push(
          `One fund's exposure is ${(entry.ratio / rounded).toFixed(3)}x what its holding is worth. `
          + 'That is what a holding reported in its own currency looks like beside a sheet kept in '
          + 'the product\u2019s, and is expected; anything else is worth checking.',
        );
      }
    }
  }

  const assets: Asset[] = [];
  const assetOf = new Map<string, Asset>();
  const valuations: AssetValuation[] = [];
  const unmapped = new Set<string>();

  for (const row of rows) {
    const positionId = options.holdings[row.fund];
    if (!positionId) {
      unmapped.add(row.fund);
      continue;
    }
    if (row.exposure === undefined) {
      problems.push(
        `Asset DB row ${row.line} (${row.asset}): no exposure figure, so the row was skipped.`,
      );
      continue;
    }

    periods.add(row.period);

    const split = (sleeves.get(`${row.fund}/${row.asset}`)?.size ?? 1) > 1;
    const sector = translate(SECTOR, row.sector);
    const name = split ? `${row.asset} — ${sector}` : row.asset;
    const id = `ast-${slug(row.fund)}-${slug(row.asset)}${split ? `-${slug(row.sector)}` : ''}`;

    let asset = assetOf.get(id);
    if (!asset) {
      const sdgs = [...row.sdg.matchAll(/\d+/g)].map((match) => Number(match[0]));
      asset = {
        id,
        positionId,
        name,
        // The exposure column is already in the product's currency, so that is
        // the currency these figures are in. Filing the fund's own would have
        // the engine translate a second time and quietly move the look-through
        // away from the portfolio it has to sum to.
        currency,
        investmentDate: row.date,
        // The exposure filed against this row is already the product's share of
        // the company, so it is not scaled again on the way out.
        ownership: 1,
        assetClass: translate(KIND, row.kind),
        subAssetClass: row.risk || undefined,
        sector,
        region: translate(REGION, row.region),
        country: translate(COUNTRY, row.country),
        status: 'Held',
        esg: row.sfdr || sdgs.length > 0
          ? { sfdr: SFDR[key(row.sfdr)], sdgs: sdgs.length > 0 ? sdgs : undefined }
          : undefined,
      };
      assets.push(asset);
      assetOf.set(id, asset);
    }
    // The earliest date this company appears under is when it was bought.
    if (row.date < asset.investmentDate) asset.investmentDate = row.date;

    // Realised is filed in the fund's own currency and on the fund's whole
    // position, so it takes the same share and rate the exposure column
    // already applied to itself.
    const share = (row.ownership ?? 1) * (row.fx ?? 1);
    const realised = (row.realised ?? 0) * share;
    valuations.push({
      id: `${id}-${row.period}`,
      assetId: id,
      period: row.period,
      recordedAt,
      invested: (row.invested ?? 0) * scale,
      realised: realised * scale,
      // The exposure column is what the product still holds — it sums, fund by
      // fund, to what those holdings are worth — so it is the unrealised value
      // rather than a total to be split. What came back is carried beside it,
      // and is deliberately not counted as exposure: money returned is not
      // capital at work in a sector any more.
      unrealised: row.exposure * scale,
      source: 'Asset allocation database',
    });
  }

  for (const fund of unmapped) {
    problems.push(
      `"${fund}" was not matched to a holding, so its companies were left out. `
      + 'Choose the holding it belongs to, or leave it out deliberately.',
    );
  }

  const split = [...sleeves.entries()].filter(([, set]) => set.size > 1);
  if (split.length > 0) {
    notes.push(
      `${split.length} company(ies) are split across sectors and are kept as one row per sector, `
      + 'which is what the allocation is built from.',
    );
  }
  if (assets.length > 0) {
    notes.push(
      'Exposure is read as filed — the column that already scales the fund’s figure by the '
      + 'share this product holds — so the totals tie to the holdings rather than to a second '
      + 'calculation of the same thing.',
    );
  }

  return {
    assets,
    assetValuations: valuations,
    problems,
    notes,
    periods: [...periods].sort(),
  };
}
