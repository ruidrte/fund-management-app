/**
 * Reading a portfolio database.
 *
 * Not a document — a book. A PFDB workbook holds the whole history of several
 * programmes in five related sheets, and the difference from every other reader
 * here is one of kind rather than size: a capital call notice is a fact to
 * review, and this is a migration.
 *
 * The five sheets, and what each becomes:
 *
 *   FundDB   static data, one row per fund per programme      -> positions
 *   FundTX   one row per dated event; the column that is      -> cashflows and
 *            filled says what the event was                      valuations
 *   CompDB   the underlying companies of each fund            -> assets
 *   CompQ    those companies quarter by quarter               -> asset valuations
 *   FX       one row per date, a column per currency, EUR = 1 -> rates
 *
 * A programme is a book of its own. `ABIF` holds the funds the vehicle invests
 * in; `StA` holds the same vehicle seen from its single limited partner, whose
 * rows are the capital account. So one import fills both tiers the application
 * reports on — the portfolio, and the investor's position in it.
 *
 * Three conventions are worth stating, because getting them wrong produces
 * figures that look entirely plausible:
 *
 *  - **Units.** FundDB sizes are millions; FundTX is in thousands, which is
 *    what this application stores; CompQ is millions.
 *  - **Signs.** The workbook writes calls positive and distributions negative.
 *    This application writes flows from the vehicle's side of the account:
 *    money out negative, money in positive. That is exactly the workbook's own
 *    `DCash` column, so every converted row is checked against it and a
 *    disagreement is reported rather than absorbed.
 *  - **Whose value.** CompQ holds the *fund's* position in each company, not
 *    the company's enterprise value. So the asset's ownership is 1 and the
 *    vehicle's share comes from its commitment divided by the fund's size —
 *    scaling twice would quietly halve the look-through.
 */

import { periodForDate, type PeriodId } from '../domain/period';
import type {
  Asset, AssetValuation, Cashflow, CashflowType, CurrencyCode, FxRate, Investor,
  Position, PositionKind, PositionValuation,
} from '../domain/types';
import type { TableData } from './types';
import type { Cell } from './workbook';

const SHEETS = {
  funds: 'funddb',
  transactions: 'fundtx',
  companies: 'compdb',
  quarters: 'compq',
  rates: 'fx',
} as const;

/** True when the workbook is a portfolio database rather than a document. */
export function isPortfolioDatabase(sheets: TableData[]): boolean {
  const names = new Set(sheets.map((sheet) => sheet.sheetName.trim().toLowerCase()));
  // The two that carry the history. A workbook without them is something else,
  // whatever its other sheets are called.
  return names.has(SHEETS.funds) && names.has(SHEETS.transactions);
}

export interface ProgramSummary {
  program: string;
  funds: number;
  transactions: number;
  companies: number;
  first?: PeriodId;
  last?: PeriodId;
  /**
   * Set when this programme's rows are one fund that is itself another
   * programme's vehicle — a limited partner's own book rather than a portfolio.
   */
  investorIn?: string;
}

export interface PfdbOptions {
  /** The programme whose portfolio is being imported, e.g. `ABIF`. */
  program: string;
  /** The vehicle in the book it belongs to. */
  vehicleId: string;
  /** The programme holding that vehicle's limited partner, e.g. `StA`. */
  investorProgram?: string;
  /** What to call that investor. Defaults to the programme code. */
  investorName?: string;
  recordedAt?: string;
}

export interface ImportPlan {
  program: string;
  vehicleId: string;
  positions: Position[];
  valuations: PositionValuation[];
  cashflows: Cashflow[];
  investors: Investor[];
  assets: Asset[];
  assetValuations: AssetValuation[];
  fxRates: FxRate[];
  /** Rows that could not be read, each naming its sheet and line. */
  problems: string[];
  /** Quarters the import covers. */
  periods: PeriodId[];
  /** What the reader had to assume, stated rather than buried. */
  notes: string[];
}

/* ------------------------------------------------------------------ *
 * A sheet, addressed by column name
 * ------------------------------------------------------------------ */

interface Reader {
  name: string;
  rows: Cell[][];
  has(column: string): boolean;
  text(row: Cell[], column: string): string;
  number(row: Cell[], column: string): number | undefined;
  date(row: Cell[], column: string): string | undefined;
}

function reader(sheet: TableData): Reader {
  const header = sheet.rows[0] ?? [];
  const index = new Map<string, number>();
  header.forEach((cell, i) => {
    const key = headerKey(String(cell ?? ''));
    // A blank or repeated heading keeps the first column that claimed it.
    if (key && !index.has(key)) index.set(key, i);
  });

  const at = (row: Cell[], column: string): Cell => {
    const i = index.get(headerKey(column));
    return i === undefined ? null : row[i] ?? null;
  };

  return {
    name: sheet.sheetName,
    rows: sheet.rows.slice(1),
    has: (column) => index.has(headerKey(column)),
    text: (row, column) => String(at(row, column) ?? '').trim(),
    number: (row, column) => toNumber(at(row, column)),
    date: (row, column) => toDate(at(row, column)),
  };
}

/** Headings carry line breaks, units and spacing that vary between copies. */
function headerKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function toNumber(cell: Cell): number | undefined {
  if (typeof cell === 'number') return Number.isFinite(cell) ? cell : undefined;
  if (typeof cell !== 'string') return undefined;
  const trimmed = cell.trim().replace(/['’]/g, '');
  if (trimmed === '') return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Excel keeps dates as days since 1899-12-30. A serial in a plausible range is
 * read as a date; anything else is not one, and saying so beats turning a
 * quantity into 1970.
 */
function toDate(cell: Cell): string | undefined {
  const serial = toNumber(cell);
  if (serial !== undefined && serial > 20_000 && serial < 80_000) {
    return new Date(Date.UTC(1899, 11, 30) + serial * 86_400_000).toISOString().slice(0, 10);
  }
  if (typeof cell === 'string') {
    const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(cell.trim());
    if (iso) return iso[0];
  }
  return undefined;
}

function find(sheets: TableData[], name: string): TableData | undefined {
  return sheets.find((sheet) => sheet.sheetName.trim().toLowerCase() === name);
}

/** An id fragment. Accents become separators, which is fine for an identifier. */
function slug(value: string, limit = 40): string {
  const full = value.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!full) return 'x';
  if (full.length <= limit) return full;
  // Truncation on its own collides, and does so precisely where it costs most:
  // funds in the same family differ only in the roman numeral at the end, so
  // "Rose Affordable Housing Preservation Fund IV" and "... V" became one
  // holding carrying both funds' figures. A digest of the whole name keeps the
  // id readable and distinct, and depends on the name alone — so importing the
  // same workbook twice still produces the same id.
  return `${full.slice(0, limit).replace(/-+$/, '')}-${digest(full)}`;
}

/** FNV-1a, 32 bits. Not a security hash: a suffix that makes an id unique. */
function digest(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/* ------------------------------------------------------------------ *
 * What is in the workbook
 * ------------------------------------------------------------------ */

export function programsIn(sheets: TableData[]): ProgramSummary[] {
  const fundsSheet = find(sheets, SHEETS.funds);
  const txSheet = find(sheets, SHEETS.transactions);
  if (!fundsSheet || !txSheet) return [];

  const fdb = reader(fundsSheet);
  const tx = reader(txSheet);

  const summaries = new Map<string, ProgramSummary>();
  const fundsOf = new Map<string, Set<string>>();
  /** Every name a programme's own vehicle is known by, long and short. */
  const vehicleNames = new Map<string, string>();

  for (const row of fdb.rows) {
    const program = fdb.text(row, 'Program');
    const fund = fdb.text(row, 'Fund');
    if (!program || !fund) continue;
    const entry = summaries.get(program) ?? { program, funds: 0, transactions: 0, companies: 0 };
    entry.funds += 1;
    summaries.set(program, entry);
    const set = fundsOf.get(program) ?? new Set<string>();
    set.add(fund);
    fundsOf.set(program, set);
  }

  for (const row of tx.rows) {
    const entry = summaries.get(tx.text(row, 'Program'));
    if (!entry) continue;
    entry.transactions += 1;
    const date = tx.date(row, 'Date');
    if (!date) continue;
    const period = periodForDate(date);
    if (!entry.first || period < entry.first) entry.first = period;
    if (!entry.last || period > entry.last) entry.last = period;
  }

  const companiesSheet = find(sheets, SHEETS.companies);
  if (companiesSheet) {
    const cdb = reader(companiesSheet);
    for (const row of cdb.rows) {
      const fund = cdb.text(row, 'Fund');
      for (const [program, set] of fundsOf) {
        if (!set.has(fund)) continue;
        const entry = summaries.get(program);
        if (entry) entry.companies += 1;
      }
    }
  }

  // A programme is a limited partner's book when the fund it holds is another
  // programme's own vehicle. The workbook says which vehicle belongs to which
  // programme through the `Short` code on that programme's rows.
  for (const row of fdb.rows) {
    const short = fdb.text(row, 'Short');
    const program = fdb.text(row, 'Program');
    if (short && summaries.has(short) && short !== program) {
      vehicleNames.set(fdb.text(row, 'Fund'), short);
    }
  }
  for (const entry of summaries.values()) {
    for (const fund of fundsOf.get(entry.program) ?? []) {
      const owner = vehicleNames.get(fund);
      if (owner && owner !== entry.program) entry.investorIn = owner;
    }
  }

  return [...summaries.values()].sort((a, b) => b.transactions - a.transactions);
}

/* ------------------------------------------------------------------ *
 * The import
 * ------------------------------------------------------------------ */

const KIND: Record<string, PositionKind> = {
  primary: 'fund',
  secondary: 'secondary',
  'co-investment': 'co-investment',
  coinvestment: 'co-investment',
  direct: 'direct-investment',
  'direct investment': 'direct-investment',
};

export function planImport(sheets: TableData[], options: PfdbOptions): ImportPlan {
  const { program, vehicleId } = options;
  const recordedAt = options.recordedAt ?? new Date().toISOString();
  const problems: string[] = [];
  const notes: string[] = [];

  const fundsSheet = find(sheets, SHEETS.funds);
  const txSheet = find(sheets, SHEETS.transactions);
  if (!fundsSheet || !txSheet) {
    throw new Error('This workbook has no FundDB and FundTX sheets, so it is not a portfolio database.');
  }

  const fdb = reader(fundsSheet);
  const tx = reader(txSheet);

  /* --- positions -------------------------------------------------- */

  const positions: Position[] = [];
  const positionOf = new Map<string, Position>();
  const sizeOf = new Map<string, number>();

  fdb.rows.forEach((row, i) => {
    if (fdb.text(row, 'Program') !== program) return;
    const name = fdb.text(row, 'Fund');
    if (!name) return;

    const currency = fdb.text(row, 'CCY').toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) {
      problems.push(`FundDB row ${i + 2} (${name}): no readable currency, so the fund was skipped.`);
      return;
    }

    const size = fdb.number(row, 'Size (Mio)');
    if (size) sizeOf.set(name, size * 1000);

    const vintage = fdb.number(row, 'Vintage');
    const inception = fdb.date(row, 'First Close') ?? fdb.date(row, 'Inception');
    const position: Position = {
      id: `pos-${slug(program)}-${slug(name)}`,
      vehicleId,
      kind: KIND[fdb.text(row, 'Type').toLowerCase()] ?? 'fund',
      name,
      manager: fdb.text(row, 'Fund Manager') || undefined,
      currency: currency as CurrencyCode,
      vintage: vintage && vintage > 1900 ? vintage : new Date().getUTCFullYear(),
      commitmentDate: inception ?? `${vintage ?? new Date().getUTCFullYear()}-01-01`,
      investmentPeriodEnd: fdb.date(row, 'Inv End'),
      // Filled from the transaction sheet below: the workbook records what was
      // committed as a dated event, and the static sheet does not carry it.
      commitment: 0,
      ownership: 1,
      assetClass: fdb.text(row, 'Sector') || 'Unclassified',
      subAssetClass: fdb.text(row, 'Strategy') || undefined,
      region: fdb.text(row, 'Region') || 'Unclassified',
      strategy: fdb.text(row, 'Strategy1') || undefined,
      status: 'Investing',
    };
    positions.push(position);
    positionOf.set(name, position);
  });

  // Two holdings sharing an id do not fail: they merge, quietly, and the
  // portfolio comes up short by one fund with no row missing from any sheet.
  // That is the kind of wrong figure worth a loud line rather than a silent
  // one, so it is checked even though the ids are now built not to collide.
  const byId = new Map<string, string[]>();
  for (const position of positions) {
    byId.set(position.id, [...(byId.get(position.id) ?? []), position.name]);
  }
  for (const [, names] of byId) {
    if (names.length > 1) {
      problems.push(
        `${names.join(' and ')} produced the same identifier, so their figures would have been `
        + 'merged into one holding. Rename one of them in FundDB.',
      );
    }
  }

  /* --- transactions ------------------------------------------------ */

  const cashflows: Cashflow[] = [];
  const valuations: PositionValuation[] = [];
  const periods = new Set<PeriodId>();
  let sequence = 0;
  const id = (prefix: string) => `${prefix}-${slug(program)}-${(sequence += 1)}`;

  const emit = (
    row: Cell[], position: Position | undefined, investorId: string | undefined,
    date: string, currency: CurrencyCode, line: number,
  ) => {
    const period = periodForDate(date);
    periods.add(period);

    const flows: Array<{ type: CashflowType; amount: number; recallable?: boolean }> = [];
    const call = tx.number(row, 'Capital Calls');
    const other = tx.number(row, 'Distribs (Other)');
    const recallable = tx.number(row, 'Distribs (Recall.)');
    const expense = tx.number(row, 'Other Exp(Inc)');
    const commitment = tx.number(row, 'Commitment');

    // The workbook writes calls positive and distributions negative; this
    // application writes both from the vehicle's side of the account.
    if (call) flows.push({ type: 'Capital Call', amount: -call });
    if (other) flows.push({ type: 'Distribution', amount: -other });
    if (recallable) flows.push({ type: 'Distribution', amount: -recallable, recallable: true });
    if (expense) flows.push({ type: 'Fee', amount: -expense });

    if (commitment) {
      flows.push({ type: 'Commitment', amount: commitment });
      if (position) position.commitment += commitment;
    }

    // `DCash` is the workbook's own view of the cash that moved, on the same
    // side of the account as ours. Where the two disagree the row is reported:
    // a sign convention that holds for two thousand rows and fails for three is
    // exactly the kind of thing nobody notices afterwards.
    const dcash = tx.number(row, 'DCash');
    if (dcash !== undefined) {
      const ours = flows.filter((flow) => flow.type !== 'Commitment')
        .reduce((total, flow) => total + flow.amount, 0);
      if (Math.abs(ours - dcash) > 0.01 + Math.abs(dcash) * 1e-6) {
        problems.push(
          `FundTX row ${line}: the flows read (${ours.toFixed(2)}) do not agree with the workbook's `
          + `own cash figure (${dcash.toFixed(2)}). The row was imported as read.`,
        );
      }
    }

    for (const flow of flows) {
      cashflows.push({
        id: id('cf'),
        vehicleId,
        positionId: position?.id,
        investorId,
        type: flow.type,
        amount: flow.amount,
        currency,
        date,
        period,
        recordedAt,
        affectsCommitment: flow.type === 'Capital Call',
        recallable: flow.recallable,
        description: tx.text(row, 'Description') || undefined,
        status: 'Settled',
      });
    }

    const nav = tx.number(row, 'NAV');
    // A valuation belongs to a holding. The investor's own NAV rows are the
    // capital account statement, and turning those into portfolio valuations
    // would count the vehicle twice.
    if (nav !== undefined && position) {
      valuations.push({
        id: id('val'),
        positionId: position.id,
        period,
        recordedAt,
        nav,
        source: `${tx.name} — ${tx.text(row, 'Description') || 'NAV'}`,
      });
    }
  };

  tx.rows.forEach((row, i) => {
    const line = i + 2;
    if (tx.text(row, 'Program') !== program) return;
    const name = tx.text(row, 'Fund');
    const position = positionOf.get(name);
    if (!position) {
      if (name) {
        problems.push(`FundTX row ${line}: "${name}" is not a fund of ${program} in FundDB. Skipped.`);
      }
      return;
    }
    const date = tx.date(row, 'Date');
    if (!date) {
      problems.push(`FundTX row ${line} (${name}): no readable date, so the row was skipped.`);
      return;
    }
    const currency = (tx.text(row, 'CCY').toUpperCase() || position.currency) as CurrencyCode;
    emit(row, position, undefined, date, currency, line);
  });

  /* --- the limited partner ------------------------------------------ */

  const investors: Investor[] = [];
  if (options.investorProgram) {
    const investorId = `inv-${slug(options.investorProgram)}`;
    let commitment = 0;
    let currency: CurrencyCode | undefined;
    let entry: string | undefined;

    tx.rows.forEach((row, i) => {
      const line = i + 2;
      if (tx.text(row, 'Program') !== options.investorProgram) return;
      const date = tx.date(row, 'Date');
      if (!date) {
        problems.push(`FundTX row ${line}: the investor's row has no readable date. Skipped.`);
        return;
      }
      const rowCurrency = (tx.text(row, 'CCY').toUpperCase() || 'EUR') as CurrencyCode;
      const committed = tx.number(row, 'Commitment');
      if (committed) {
        commitment += committed;
        currency = rowCurrency;
        entry = entry && entry < date ? entry : date;
      }
      emit(row, undefined, investorId, date, rowCurrency, line);
    });

    investors.push({
      id: investorId,
      vehicleId,
      name: options.investorName ?? options.investorProgram,
      // The workbook does not say what kind of investor it is, and inventing
      // one would show up on a chart nobody could account for.
      type: 'Institution',
      country: 'Unclassified',
      currency: currency ?? 'EUR',
      commitment,
      entryDate: entry ?? new Date().toISOString().slice(0, 10),
    });
    notes.push(
      `${options.investorProgram} is the vehicle's limited partner: its rows became the capital `
      + 'account and its fees, not portfolio holdings.',
    );
  }

  /* --- ownership ----------------------------------------------------- */

  /**
   * Holdings whose share of the fund could not be worked out, and whose
   * companies are therefore left out of the look-through.
   *
   * A fund with no size in FundDB cannot be scaled, and assuming 100% is not a
   * conservative guess — on this workbook it put one fund's whole portfolio,
   * larger than the vehicle itself, into the look-through. Leaving its
   * companies out makes the engine fall back to the holding's own value and
   * attributes, which is both right and visible: the look-through page reports
   * the share of the portfolio it could not see through.
   */
  const unscalable = new Set<string>();

  for (const position of positions) {
    const size = sizeOf.get(position.name);
    if (size && position.commitment > 0) {
      // The share of the fund this vehicle holds, which is what scales every
      // look-through figure.
      position.ownership = Math.min(1, position.commitment / size);
    } else if (position.kind === 'direct-investment' || position.kind === 'co-investment') {
      // Held directly, so the vehicle's share of it is the whole of it.
      position.ownership = 1;
    } else {
      position.ownership = 1;
      unscalable.add(position.id);
      notes.push(
        `${position.name}: FundDB gives no size for it, so what share of the fund the vehicle `
        + 'holds cannot be worked out. Its companies are left out of the look-through and the '
        + 'holding is shown on its own attributes instead. Filling in Size (Mio) fixes it.',
      );
    }
  }

  /* --- look-through --------------------------------------------------- */

  const assets: Asset[] = [];
  const assetValuations: AssetValuation[] = [];
  const assetOf = new Map<string, Asset>();

  const companiesSheet = find(sheets, SHEETS.companies);
  if (companiesSheet) {
    const cdb = reader(companiesSheet);
    for (const row of cdb.rows) {
      const fund = cdb.text(row, 'Fund');
      const position = positionOf.get(fund);
      const name = cdb.text(row, 'Company');
      if (!position || !name) continue;
      // Skipped rather than scaled by a guess — see `unscalable` above.
      if (unscalable.has(position.id)) continue;

      const currency = cdb.text(row, 'CCY').toUpperCase();
      const asset: Asset = {
        id: `ast-${slug(fund)}-${slug(name)}`,
        positionId: position.id,
        name,
        currency: (/^[A-Z]{3}$/.test(currency) ? currency : position.currency) as CurrencyCode,
        investmentDate: cdb.date(row, 'Inv Date')
          ?? `${cdb.number(row, 'Vintage') ?? position.vintage}-01-01`,
        // One, deliberately: CompQ already holds the fund's own position in the
        // company rather than the company's whole value.
        ownership: 1,
        assetClass: position.assetClass,
        sector: cdb.text(row, 'Sector') || 'Unclassified',
        region: cdb.text(row, 'Region') || position.region,
        country: cdb.text(row, 'Geography') || 'Unclassified',
        status: 'Held',
      };
      assets.push(asset);
      assetOf.set(`${fund} ${name}`, asset);
    }
  }

  const quartersSheet = find(sheets, SHEETS.quarters);
  if (quartersSheet) {
    const cq = reader(quartersSheet);
    cq.rows.forEach((row, i) => {
      const fund = cq.text(row, 'Fund');
      const company = cq.text(row, 'Company');
      const asset = assetOf.get(`${fund} ${company}`);
      if (!asset) return;

      const date = cq.date(row, 'Date');
      if (!date) {
        problems.push(`CompQ row ${i + 2} (${company}): no readable date, so the row was skipped.`);
        return;
      }
      const period = periodForDate(date);
      periods.add(period);

      // Millions in the workbook, thousands here.
      assetValuations.push({
        id: `av-${asset.id}-${period}`,
        assetId: asset.id,
        period,
        recordedAt,
        invested: (cq.number(row, 'Invested (M)') ?? 0) * 1000,
        realised: (cq.number(row, 'Realized (M)') ?? 0) * 1000,
        unrealised: (cq.number(row, 'Unrealized (M)') ?? 0) * 1000,
        source: `${cq.name} — ${cq.text(row, 'Status') || 'quarterly'}`,
      });

      const status = cq.text(row, 'Status').toLowerCase();
      if (status.startsWith('realiz') || status.startsWith('realis')) asset.status = 'Realised';
      else if (status.startsWith('partially')) asset.status = 'Partially Realised';
    });
  }

  /* --- rates ----------------------------------------------------------- */

  const fxRates: FxRate[] = [];
  const ratesSheet = find(sheets, SHEETS.rates);
  if (ratesSheet) {
    const fx = reader(ratesSheet);
    const header = (ratesSheet.rows[0] ?? []).map((cell) => String(cell ?? '').trim().toUpperCase());
    const quotes = header.filter((name) => /^[A-Z]{3}$/.test(name) && name !== 'EUR');

    for (const row of fx.rows) {
      const date = fx.date(row, 'Date');
      if (!date) continue;
      const period = periodForDate(date);
      for (const quote of quotes) {
        const rate = fx.number(row, quote);
        if (!rate || rate <= 0) continue;
        fxRates.push({
          id: `fx-${quote}-${date}`,
          base: 'EUR',
          quote: quote as CurrencyCode,
          rate,
          date,
          period,
          recordedAt,
          kind: 'closing',
          // Kept in a workbook by hand rather than taken from a feed, and
          // outranked by anything the administrator's financials say.
          source: `${fx.name} sheet`,
          authority: 'manual',
        });
      }
    }
  }

  return {
    program,
    vehicleId,
    positions,
    valuations,
    cashflows,
    investors,
    assets,
    assetValuations,
    fxRates,
    problems,
    periods: [...periods].sort(),
    notes,
  };
}
