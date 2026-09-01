/**
 * Format drivers.
 *
 * Each turns one kind of document into candidate facts. They share the review,
 * validation and commit steps that follow, so a new format is a new driver and
 * nothing else changes.
 *
 * The honest division of labour, stated because it governs how much to trust
 * each path:
 *
 *   Spreadsheets   parsed structurally. High confidence: a cell either holds a
 *                  number under a column called "NAV" or it does not.
 *   PDFs           text is extracted reliably; *meaning* is inferred by pattern
 *                  and is not reliable. Every field lands with its locator and
 *                  a confidence, and nothing commits without a person agreeing.
 *   Manual entry   the person is the extractor. Still recorded as a document,
 *                  so a typed figure is as traceable as a parsed one.
 */

import { parsePeriodId, periodEndDate, periodForDate, type PeriodId } from '../domain/period';
import { matchEntity, CONFIDENT } from './match';
import { findHeaderRow, parseNumber, type Cell } from './workbook';
import type {
  Candidate, ExtractionInput, ExtractionResult, Extractor, FieldValue, Issue, MatchContext,
} from './types';

let counter = 0;
const nextId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(counter += 1)}`;

function field<T>(value: T, confidence: number, locator?: string): FieldValue<T> {
  return { value, confidence, locator };
}

/* ------------------------------------------------------------------ *
 * Column recognition
 *
 * Header synonyms, because every administrator and every GP names these
 * differently and the alternative is a mapping screen for every document.
 * A header that matches nothing is reported, never guessed at.
 * ------------------------------------------------------------------ */

const SYNONYMS: Record<string, string[]> = {
  name: ['fund', 'fund name', 'investment', 'holding', 'position', 'name', 'partnership', 'investment name', 'beteiligung'],
  nav: ['nav', 'net asset value', 'fair value', 'valuation', 'value', 'market value', 'ending capital', 'closing balance', 'ending balance', 'capital account balance'],
  commitment: ['commitment', 'total commitment', 'committed', 'commitment amount', 'subscription'],
  drawn: ['drawn', 'called', 'paid in', 'paid-in', 'contributions', 'contributed capital', 'cumulative calls', 'total drawn', 'capital called'],
  distributed: ['distributed', 'distributions', 'cumulative distributions', 'total distributed', 'proceeds'],
  recallable: ['recallable', 'recallable distributions', 'return of capital'],
  currency: ['currency', 'ccy', 'curr', 'währung', 'devise'],
  date: ['date', 'transaction date', 'value date', 'payment date', 'due date', 'settlement date'],
  amount: ['amount', 'transaction amount', 'total', 'net amount', 'call amount', 'distribution amount'],
  type: ['type', 'transaction type', 'transaction', 'description', 'movement'],
  period: ['period', 'quarter', 'as of', 'as at', 'reporting date', 'valuation date', 'reference date'],
  vintage: ['vintage', 'vintage year', 'year'],
  region: ['region', 'geography', 'geographic focus'],
  assetClass: ['asset class', 'strategy', 'sub strategy', 'sub-asset class', 'type of investment'],
};

export interface ColumnMap {
  /** Canonical field -> column index. */
  columns: Record<string, number>;
  /** Headers that matched nothing, reported rather than dropped. */
  unmapped: string[];
}

export function mapColumns(header: Cell[]): ColumnMap {
  const columns: Record<string, number> = {};
  const unmapped: string[] = [];

  header.forEach((cell, index) => {
    const text = String(cell ?? '').trim();
    if (text === '') return;

    const key = normaliseHeader(text);
    let matched: string | undefined;

    for (const [canonical, synonyms] of Object.entries(SYNONYMS)) {
      if (synonyms.some((synonym) => normaliseHeader(synonym) === key)) {
        matched = canonical;
        break;
      }
    }
    // Fall back to containment, so "Total Commitment (EUR)" finds `commitment`.
    if (!matched) {
      for (const [canonical, synonyms] of Object.entries(SYNONYMS)) {
        if (synonyms.some((synonym) => key.includes(normaliseHeader(synonym)))) {
          matched = canonical;
          break;
        }
      }
    }

    // First column to claim a field keeps it: a sheet with both "NAV" and
    // "NAV (prior)" should map the plain one.
    if (matched && columns[matched] === undefined) columns[matched] = index;
    else if (!matched) unmapped.push(text);
  });

  return { columns, unmapped };
}

function normaliseHeader(value: string): string {
  return value
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/* ------------------------------------------------------------------ *
 * Historical workbook -> valuations
 * ------------------------------------------------------------------ */

export const historicalWorkbookExtractor: Extractor = {
  kind: 'historical-workbook',
  label: 'Historical workbook',
  accepts: ['.xlsx', '.csv', '.tsv', 'text/csv',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  capability:
    'Reads one row per holding from a spreadsheet: name, NAV, commitment, drawn and distributed. '
    + 'Column headers are recognised across common naming; anything unrecognised is reported rather than guessed at.',

  async extract(input: ExtractionInput): Promise<ExtractionResult> {
    const { document, table, context, period, vehicleId, createMissing } = input;
    if (!table) {
      return empty(document, 'No sheet was supplied to the workbook reader.');
    }

    const headerIndex = findHeaderRow(table.rows);
    if (headerIndex === undefined) {
      return {
        document,
        candidates: [],
        unparsed: table.rows.slice(0, 8).map((row) => row.join(' | ')),
        summary:
          'Could not identify a header row. The first rows are listed above so the header can be pointed at directly — '
          + 'guessing would load a column of numbers confidently into the wrong field.',
      };
    }

    const { columns, unmapped } = mapColumns(table.rows[headerIndex]);
    if (columns.name === undefined) {
      return {
        document,
        candidates: [],
        unparsed: [table.rows[headerIndex].join(' | ')],
        summary: 'The header has no column naming the holding, so no row can be attributed to anything.',
      };
    }

    const candidates: Candidate[] = [];
    const unparsed: string[] = [];

    for (let i = headerIndex + 1; i < table.rows.length; i += 1) {
      const row = table.rows[i];
      const name = String(row[columns.name] ?? '').trim();
      if (name === '') continue;

      // Total rows are common at the bottom of these sheets and must not become
      // a holding called "Total".
      if (/^(total|sum|grand total|subtotal)\b/i.test(name)) continue;

      const rowPeriod = resolvePeriod(row, columns, period);
      if (!rowPeriod) {
        unparsed.push(`Row ${i + 1} (${name}): no period on the row and none given for the document`);
        continue;
      }

      const nav = numberAt(row, columns.nav);
      if (nav === null) {
        unparsed.push(`Row ${i + 1} (${name}): no readable net asset value`);
        continue;
      }

      const match = matchEntity(name, 'position', context);

      // Seeding a book: a name that matches nothing becomes the holding, and
      // the row's valuation waits for it. Only when the person asked for it —
      // otherwise an unmatched name stays an unmatched name.
      let creates: Candidate | undefined;
      if (createMissing && !match.id) {
        const target = vehicleId ?? context.vehicles[0]?.id;
        if (target) creates = holdingFrom(name, row, columns, i, document, target, context);
      }

      const fields: Candidate['fields'] = {
        period: field<string>(rowPeriod, 1, `row ${i + 1}`),
        nav: field<number>(nav, 0.95, cellRef(i, columns.nav)),
        source: field<string>(document.name, 1),
      };

      const drawn = numberAt(row, columns.drawn);
      if (drawn !== null) fields.drawnCumulative = field(drawn, 0.9, cellRef(i, columns.drawn));
      const distributed = numberAt(row, columns.distributed);
      if (distributed !== null) fields.distributedCumulative = field(distributed, 0.9, cellRef(i, columns.distributed));
      const recallable = numberAt(row, columns.recallable);
      if (recallable !== null) fields.recallableCumulative = field(recallable, 0.85, cellRef(i, columns.recallable));

      if (creates) candidates.push(creates);
      candidates.push({
        id: nextId('cand'),
        documentId: document.id,
        kind: 'position-valuation',
        fields,
        // A holding about to be created has no id to match to yet, so the
        // valuation carries the dependency instead of a match.
        match: creates ? undefined : match,
        dependsOn: creates?.id,
        issues: [],
        state: 'pending',
      });
    }

    return {
      document,
      candidates,
      unparsed: [
        ...unmapped.map((header) => `Unrecognised column: "${header}"`),
        ...unparsed,
      ],
      summary:
        `Read ${candidates.length} valuation(s) from "${table.sheetName}", header on row ${headerIndex + 1}.`
        + (unmapped.length > 0 ? ` ${unmapped.length} column(s) were not recognised and were ignored.` : ''),
    };
  },
};

/* ------------------------------------------------------------------ *
 * Transaction notices -> cashflows
 * ------------------------------------------------------------------ */


/**
 * A holding, read from the same row as its valuation.
 *
 * Only what the sheet actually says. Everything absent stays absent rather than
 * being defaulted to something plausible — an invented vintage or asset class
 * would come back later as an exposure chart nobody can explain, and the
 * screens already handle an unclassified holding.
 */
function holdingFrom(
  name: string,
  row: Cell[],
  columns: ColumnMap['columns'],
  rowIndex: number,
  document: ExtractionInput['document'],
  vehicleId: string,
  context: MatchContext,
): Candidate {
  const fields: Candidate['fields'] = {
    name: field<string>(name, 1, `row ${rowIndex + 1}`),
    vehicleId: field<string>(vehicleId, 1),
  };

  const currency = columns.currency === undefined
    ? undefined
    : String(row[columns.currency] ?? '').trim().toUpperCase();
  fields.currency = currency && /^[A-Z]{3}$/.test(currency)
    ? field<string>(currency, 1, cellRef(rowIndex, columns.currency))
    // The vehicle's own currency is the only defensible guess, and it is
    // marked as a guess so the reviewer is asked rather than told.
    : field<string>(
      context.vehicles.find((v) => v.id === vehicleId)?.currency ?? 'EUR',
      0.5,
      'not stated in the sheet — the vehicle\'s currency',
    );

  const commitment = numberAt(row, columns.commitment);
  if (commitment !== null) {
    fields.commitment = field<number>(commitment, 0.9, cellRef(rowIndex, columns.commitment));
  }
  const vintage = numberAt(row, columns.vintage);
  if (vintage !== null && vintage > 1900 && vintage < 2200) {
    fields.vintage = field<number>(vintage, 0.9, cellRef(rowIndex, columns.vintage));
  }
  for (const attribute of ['region', 'assetClass'] as const) {
    const index = columns[attribute];
    if (index === undefined) continue;
    const value = String(row[index] ?? '').trim();
    if (value) fields[attribute] = field<string>(value, 0.85, cellRef(rowIndex, index));
  }

  return {
    id: nextId('cand'),
    documentId: document.id,
    kind: 'position',
    fields,
    issues: [],
    state: 'pending',
  };
}

export const transactionNoticeExtractor: Extractor = {
  kind: 'transaction-notice',
  label: 'Transaction notice',
  accepts: ['.xlsx', '.csv', '.pdf', 'application/pdf'],
  capability:
    'Reads drawdown and distribution notices. From a spreadsheet, one row per movement. From a PDF, '
    + 'the fund, date, amount and currency are located by pattern and every field is presented for confirmation.',

  async extract(input: ExtractionInput): Promise<ExtractionResult> {
    const { document, table, text, context } = input;
    if (table) return tabularCashflows(input);
    if (text) return narrativeCashflow(document, text, context);
    return empty(document, 'Nothing readable was supplied to the notice reader.');
  },
};

async function tabularCashflows(input: ExtractionInput): Promise<ExtractionResult> {
  const { document, table, context } = input;
  if (!table) return empty(document, 'No sheet supplied.');

  const headerIndex = findHeaderRow(table.rows);
  if (headerIndex === undefined) {
    return empty(document, 'Could not identify a header row in the notice.');
  }

  const { columns, unmapped } = mapColumns(table.rows[headerIndex]);
  const candidates: Candidate[] = [];
  const unparsed: string[] = [];

  for (let i = headerIndex + 1; i < table.rows.length; i += 1) {
    const row = table.rows[i];
    const name = String(row[columns.name] ?? '').trim();
    const amount = numberAt(row, columns.amount);
    const dateText = String(row[columns.date] ?? '').trim();

    if (name === '' && amount === null) continue;
    if (/^(total|sum|subtotal)\b/i.test(name)) continue;

    const date = parseDate(dateText);
    if (!date || amount === null) {
      unparsed.push(`Row ${i + 1}: needs a date and an amount; found "${dateText}" and "${row[columns.amount] ?? ''}"`);
      continue;
    }

    const typeText = String(row[columns.type] ?? '').trim();
    const kind = classifyCashflow(typeText, amount);

    candidates.push({
      id: nextId('cand'),
      documentId: document.id,
      kind: 'cashflow',
      fields: {
        type: field<string>(kind.type, kind.confidence, cellRef(i, columns.type)),
        // Signed from the vehicle's perspective: a call is money out.
        amount: field<number>(kind.type === 'Capital Call' ? -Math.abs(amount) : Math.abs(amount),
          0.95, cellRef(i, columns.amount)),
        currency: field<string>(String(row[columns.currency] ?? '').trim().toUpperCase() || 'EUR',
          columns.currency === undefined ? 0.5 : 0.95, cellRef(i, columns.currency)),
        date: field<string>(date, 0.9, cellRef(i, columns.date)),
        period: field<string>(periodForDate(date), 0.9),
        affectsCommitment: field<boolean>(kind.type === 'Capital Call', 0.8),
        description: field<string>(typeText || document.name, 0.7),
      },
      match: name ? matchEntity(name, 'position', context) : undefined,
      issues: [],
      state: 'pending',
    });
  }

  return {
    document,
    candidates,
    unparsed: [...unmapped.map((h) => `Unrecognised column: "${h}"`), ...unparsed],
    summary: `Read ${candidates.length} movement(s) from "${table.sheetName}".`,
  };
}

/**
 * A single notice as prose. Every field here is a pattern match on free text
 * and is presented at a confidence that says so — this path proposes, the
 * reviewer disposes.
 */
function narrativeCashflow(
  document: ExtractionInput['document'],
  text: string,
  context: MatchContext,
): ExtractionResult {
  const amount = findAmount(text);
  const date = findDate(text);
  const currency = findCurrency(text);
  const name = findFundName(text, context);

  const isCall = /\b(capital call|drawdown|draw down|call notice|contribution)\b/i.test(text);
  const isDistribution = /\b(distribution|proceeds|return of capital|repayment)\b/i.test(text);
  const type = isCall ? 'Capital Call' : isDistribution ? 'Distribution' : 'Capital Call';

  const candidates: Candidate[] = [];
  const unparsed: string[] = [];

  if (amount && date) {
    candidates.push({
      id: nextId('cand'),
      documentId: document.id,
      kind: 'cashflow',
      fields: {
        type: field<string>(type, isCall || isDistribution ? 0.8 : 0.35, 'document wording'),
        amount: field<number>(type === 'Capital Call' ? -Math.abs(amount.value) : Math.abs(amount.value),
          0.7, amount.locator),
        currency: field<string>(currency?.value ?? 'EUR', currency ? 0.8 : 0.3, currency?.locator),
        date: field<string>(date.value, 0.7, date.locator),
        period: field<string>(periodForDate(date.value), 0.7),
        affectsCommitment: field<boolean>(type === 'Capital Call', 0.7),
        description: field<string>(document.name, 1),
      },
      match: name ? matchEntity(name, 'position', context) : undefined,
      issues: [],
      state: 'pending',
    });
  } else {
    if (!amount) unparsed.push('No amount could be located in the document text.');
    if (!date) unparsed.push('No date could be located in the document text.');
  }

  return {
    document,
    candidates,
    unparsed,
    summary: candidates.length > 0
      ? 'Located one movement by pattern. Every field is a reading of the text, not a parsed record — confirm each before committing.'
      : 'Text was extracted but no movement could be located in it. Enter the movement manually against this document.',
  };
}

/* ------------------------------------------------------------------ *
 * Administrator NAV pack -> vehicle balance sheet
 * ------------------------------------------------------------------ */

/**
 * Trial balance and balance sheet lines that separate the portfolio from the
 * vehicle's own assets and liabilities. This is what makes net NAV differ from
 * gross, so getting it from the administrator rather than deriving it is the
 * whole point.
 */
const BALANCE_LINES: Array<{ target: keyof BalanceTotals; patterns: RegExp[]; sign: 1 | -1 }> = [
  { target: 'cash', sign: 1, patterns: [/\bcash\b/i, /bank\s*(account|balance)/i, /cash\s*(and|&)\s*cash\s*equivalents/i] },
  { target: 'otherAssets', sign: 1, patterns: [/receivable/i, /prepaid/i, /other\s+assets/i, /accrued\s+income/i] },
  { target: 'currentLiabilities', sign: -1, patterns: [/payable/i, /\bloan\b/i, /borrowing/i, /other\s+liabilit/i] },
  // Broad on purpose. "Accrued management fee" is among the most common labels
  // an administrator writes, and a pattern requiring "accrued" to sit directly
  // against "fee" misses it — which drops the accrual silently and overstates
  // net asset value. Accrued *income* is caught by the receivables rule above,
  // which is evaluated first, so widening this one does not steal from it.
  { target: 'accruedExpenses', sign: -1, patterns: [/accrued/i, /management\s+fee/i, /performance\s+fee/i, /carried\s+interest/i, /provision/i] },
];

interface BalanceTotals {
  cash: number;
  otherAssets: number;
  currentLiabilities: number;
  accruedExpenses: number;
}


/* ------------------------------------------------------------------ *
 * Rates declared in the financials
 *
 * The house rule: rates come from the ECB and are replaced by whatever the
 * administrator's books used, once the trial balance for the quarter arrives.
 * The pack is the only place that rate is written down, so the reader that
 * opens the pack is the place to pick it up.
 *
 * Only an explicitly named pair is read. A line saying "USD 1.1523" could mean
 * either direction, and inverting a rate by mistake is a five per cent error
 * that ties to nothing — so an ambiguous line is reported unparsed rather than
 * guessed at.
 * ------------------------------------------------------------------ */

const CURRENCY = String.raw`[A-Z]{3}`;

/**
 * Dates, removed before anything looks for a number.
 *
 * `31.03.2026` contains `31.03`, which is a perfectly good rate as far as a
 * regular expression is concerned. Every rate misread I have seen in practice
 * was a date.
 */
const DATE_LIKE = /\d{1,4}[./-]\d{1,2}[./-]\d{2,4}/g;

/** A number that could be a rate. Rates are written with decimals; counts are not. */
const RATE_NUMBER = /\d{1,6}[.,]\d{1,8}/;

const PAIR_PATTERNS: RegExp[] = [
  // EUR/USD · EUR / USD · (EUR/CHF)
  new RegExp(String.raw`\b(${CURRENCY})\s*/\s*(${CURRENCY})\b`),
  // EUR to USD · EUR into USD
  new RegExp(String.raw`\b(${CURRENCY})\s+(?:to|into|->)\s+(${CURRENCY})\b`),
];

/** 1 EUR = 1.1523 USD — the one form that states the rate in the middle. */
const EQUATION = new RegExp(
  String.raw`\b1\s*(${CURRENCY})\s*=\s*(${RATE_NUMBER.source})\s*(${CURRENCY})\b`,
);

/** A line that talks about rates at all, so an unread one can be reported. */
const RATE_CONTEXT = /(exchange|fx|foreign currency|umrechnung|kurs|taux|translation)/i;

/**
 * Outside this, the number is not a rate. Real crosses run from roughly 0.006
 * (JPY against a major) to a few thousand; anything beyond is a balance that
 * happened to sit next to a currency pair.
 */
const RATE_RANGE = { min: 0.0001, max: 100_000 };

interface ReadRate {
  base: string;
  quote: string;
  rate: number;
  locator: string;
  line: string;
}

function readRate(line: string, locator: string): ReadRate | undefined {
  const cleaned = line.replace(DATE_LIKE, ' ');

  const equation = EQUATION.exec(cleaned);
  if (equation) {
    return build(equation[1], equation[3], equation[2], locator, line);
  }

  for (const pattern of PAIR_PATTERNS) {
    const pair = pattern.exec(cleaned);
    if (!pair) continue;
    // The rate follows the pair, not precedes it: "EUR/USD 1.1523", never
    // "1.1523 EUR/USD". Reading backwards would pick up the previous column.
    const after = cleaned.slice(pair.index + pair[0].length);
    const value = RATE_NUMBER.exec(after);
    if (!value) continue;
    return build(pair[1], pair[2], value[0], locator, line);
  }

  return undefined;
}

function build(
  base: string, quote: string, raw: string, locator: string, line: string,
): ReadRate | undefined {
  const rate = parseNumber(raw);
  if (rate === null || rate < RATE_RANGE.min || rate > RATE_RANGE.max) return undefined;
  const upperBase = base.toUpperCase();
  const upperQuote = quote.toUpperCase();
  if (upperBase === upperQuote) return undefined;
  return { base: upperBase, quote: upperQuote, rate, locator, line: line.trim() };
}

export const navPackExtractor: Extractor = {
  kind: 'nav-pack',
  label: 'Administrator NAV pack',
  accepts: ['.xlsx', '.csv', '.pdf', 'application/pdf'],
  capability:
    'Reads a trial balance or balance sheet and totals the lines that separate net asset value from the portfolio: '
    + 'cash, receivables, payables and accrued fees. Every line it classified is listed, so a misclassification is visible.',

  async extract(input: ExtractionInput): Promise<ExtractionResult> {
    const { document, table, text, context, period, vehicleId } = input;

    const lines: Array<{ label: string; amount: number; locator: string }> = [];
    // Kept alongside the classified balance-sheet lines: a declared rate is not
    // a balance-sheet line and would otherwise be discarded as noise.
    const raw: Array<{ text: string; locator: string }> = [];

    if (table) {
      const headerIndex = findHeaderRow(table.rows) ?? -1;
      for (let i = headerIndex + 1; i < table.rows.length; i += 1) {
        const row = table.rows[i];
        const label = String(row.find((cell) => typeof cell === 'string' && cell.trim() !== '') ?? '').trim();
        const amount = row.map((cell) => (typeof cell === 'number' ? cell : parseNumber(String(cell ?? ''))))
          .find((value): value is number => value !== null && value !== undefined);
        if (label && amount !== undefined) {
          lines.push({ label, amount, locator: `row ${i + 1}` });
        }
      }
      // Every row, not just the classified ones — a declared rate often sits in
      // a header block above the balance-sheet lines.
      table.rows.forEach((row, index) => {
        raw.push({ text: row.map((cell) => String(cell ?? '')).join('  '), locator: `row ${index + 1}` });
      });
    } else if (text) {
      text.split('\n').forEach((line, index) => {
        raw.push({ text: line, locator: `line ${index + 1}` });
        const match = /^(.{3,60}?)\s{2,}([-(]?[\d.,'’ ]+\)?)$/.exec(line.trim());
        if (!match) return;
        const amount = parseNumber(match[2]);
        if (amount === null) return;
        lines.push({ label: match[1].trim(), amount, locator: `line ${index + 1}` });
      });
    } else {
      return empty(document, 'Nothing readable was supplied to the NAV pack reader.');
    }

    const totals: BalanceTotals = { cash: 0, otherAssets: 0, currentLiabilities: 0, accruedExpenses: 0 };
    const classified: string[] = [];
    const ignored: Array<{ locator: string; text: string }> = [];

    for (const line of lines) {
      const rule = BALANCE_LINES.find((entry) => entry.patterns.some((pattern) => pattern.test(line.label)));
      if (!rule) {
        ignored.push({
          locator: line.locator,
          text: `${line.label} (${line.amount}) — not a balance-sheet line this reader recognises`,
        });
        continue;
      }
      // Liabilities are stored positive and subtracted by the engine, so a
      // credit balance already carrying a minus sign must not subtract twice.
      totals[rule.target] += rule.sign === -1 ? Math.abs(line.amount) : line.amount;
      classified.push(`${line.label} -> ${rule.target} (${line.amount}) at ${line.locator}`);
    }

    const resolved = period ?? document.period;
    if (!resolved) {
      return {
        document, candidates: [], unparsed: ignored.map((entry) => entry.text),
        summary: 'The pack has no period, and none was given. A balance sheet without a period cannot be filed.',
      };
    }

    // The scoped vehicle, when there is one; otherwise fall back to reading the
    // filename, which is a guess and is scored as one.
    const scoped = vehicleId
      ? context.vehicles.find((v) => v.id === vehicleId)
      : context.vehicles.length === 1 ? context.vehicles[0] : undefined;

    const vehicleMatch = scoped
      ? {
        kind: 'vehicle' as const,
        id: scoped.id,
        sourceName: document.name,
        matchedName: scoped.name,
        confidence: 1,
        alternatives: context.vehicles.map((v) => ({ id: v.id, name: v.name, score: 1 })),
      }
      : matchEntity(document.name, 'vehicle', context);

    const candidate: Candidate = {
      id: nextId('cand'),
      documentId: document.id,
      kind: 'balance-sheet',
      fields: {
        period: field<string>(resolved, 1),
        cash: field<number>(totals.cash, 0.85),
        otherAssets: field<number>(totals.otherAssets, 0.75),
        currentLiabilities: field<number>(totals.currentLiabilities, 0.75),
        accruedExpenses: field<number>(totals.accruedExpenses, 0.7),
        source: field<string>(document.name, 1),
      },
      match: vehicleMatch,
      issues: lines.length === 0
        ? [{ severity: 'error', message: 'No balance-sheet lines were found in this document.' }]
        : [],
      state: 'pending',
    };

    // Rates the pack declares, which outrank the published fixing for this
    // quarter once committed.
    const seen = new Set<string>();
    const rateCandidates: Candidate[] = [];
    const unreadableRateLines: string[] = [];
    // Locators a rate was read from, so the same line is not also reported as
    // an unrecognised balance-sheet line.
    const rateLocators = new Set<string>();

    for (const entry of raw) {
      const read = readRate(entry.text, entry.locator);
      if (!read) {
        if (RATE_CONTEXT.test(entry.text) && /\d/.test(entry.text)) {
          rateLocators.add(entry.locator);
          unreadableRateLines.push(
            `${entry.text.trim()} (${entry.locator}) — reads as a rate but names no currency pair, `
            + 'so which way round it goes is a guess. File it by hand if it matters.',
          );
        }
        continue;
      }
      rateLocators.add(read.locator);
      const key = `${read.base}/${read.quote}`;
      // A pack usually repeats the rate in every section. The first sighting is
      // the one kept; a genuinely different second rate is reported instead of
      // silently dropped.
      if (seen.has(key)) {
        const kept = rateCandidates.find((c) => c.fields.base.value === read.base
          && c.fields.quote.value === read.quote);
        if (kept && Math.abs(Number(kept.fields.rate.value) - read.rate) > 1e-9) {
          unreadableRateLines.push(
            `${key} appears again as ${read.rate} at ${read.locator}, against ${kept.fields.rate.value} `
            + 'already read. Only the first was kept — check which the books actually used.',
          );
        }
        continue;
      }
      seen.add(key);

      rateCandidates.push({
        id: nextId('cand'),
        documentId: document.id,
        kind: 'fx-rate',
        fields: {
          base: field<string>(read.base, 1, read.locator),
          quote: field<string>(read.quote, 1, read.locator),
          rate: field<number>(read.rate, 0.9, read.locator),
          period: field<string>(resolved, 1),
          date: field<string>(periodEndDate(resolved), 0.9),
          kind: field<string>('closing', 0.8),
          source: field<string>(document.name, 1),
        },
        issues: [],
        state: 'pending',
      });
    }

    const rateNote = rateCandidates.length > 0
      ? ` Read ${rateCandidates.length} exchange rate(s) declared in the pack; committing them makes `
        + 'them override the published fixing for this quarter.'
      : '';

    return {
      document,
      candidates: [...(lines.length > 0 ? [candidate] : []), ...rateCandidates],
      unparsed: [
        ...classified.map((line) => `Classified: ${line}`),
        ...ignored.filter((entry) => !rateLocators.has(entry.locator)).map((entry) => entry.text),
        ...unreadableRateLines,
      ],
      summary:
        `Classified ${classified.length} of `
        + `${lines.filter((line) => !rateLocators.has(line.locator)).length} line(s) `
        + 'into the four balance-sheet buckets. '
        + 'Every classification is listed above so a misreading is visible before it is committed.'
        + rateNote,
    };
  },
};

export const EXTRACTORS: Extractor[] = [
  historicalWorkbookExtractor,
  transactionNoticeExtractor,
  navPackExtractor,
];

export function extractorFor(kind: string): Extractor | undefined {
  return EXTRACTORS.find((extractor) => extractor.kind === kind);
}

/* ------------------------------------------------------------------ *
 * Shared helpers
 * ------------------------------------------------------------------ */

function empty(document: ExtractionInput['document'], summary: string): ExtractionResult {
  return { document, candidates: [], unparsed: [], summary };
}

function numberAt(row: Cell[], index: number | undefined): number | null {
  if (index === undefined) return null;
  const cell = row[index];
  if (typeof cell === 'number') return cell;
  if (typeof cell === 'string') return parseNumber(cell);
  return null;
}

function cellRef(rowIndex: number, columnIndex: number | undefined): string | undefined {
  if (columnIndex === undefined) return undefined;
  return `${letters(columnIndex)}${rowIndex + 1}`;
}

function letters(index: number): string {
  let out = '';
  let remaining = index;
  while (remaining >= 0) {
    out = String.fromCharCode((remaining % 26) + 65) + out;
    remaining = Math.floor(remaining / 26) - 1;
  }
  return out;
}

function resolvePeriod(
  row: Cell[], columns: Record<string, number>, fallback?: PeriodId,
): PeriodId | undefined {
  const raw = columns.period !== undefined ? String(row[columns.period] ?? '').trim() : '';
  if (raw !== '') {
    try {
      return parsePeriodId(raw).id;
    } catch {
      const date = parseDate(raw);
      if (date) return periodForDate(date);
    }
  }
  return fallback;
}

/**
 * Dates in these documents are written every way there is. Unambiguous forms
 * are parsed; an ambiguous `03/04/2026` is rejected rather than guessed, since
 * a day-month swap moves a cashflow into the wrong quarter.
 */
export function parseDate(value: string): string | null {
  const text = value.trim();
  if (text === '') return null;

  // ISO, and Excel's own serial-date rendering.
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  // A bare number is an Excel serial date, days since 1899-12-30.
  if (/^\d{5}$/.test(text)) {
    const serial = Number(text);
    const date = new Date(Date.UTC(1899, 11, 30) + serial * 86_400_000);
    return date.toISOString().slice(0, 10);
  }

  const named = /^(\d{1,2})[ -]([A-Za-z]{3,})[ -](\d{4})$/.exec(text);
  if (named) {
    const month = MONTHS.findIndex((m) => m.startsWith(named[2].toLowerCase().slice(0, 3)));
    if (month >= 0) {
      return `${named[3]}-${pad(month + 1)}-${pad(Number(named[1]))}`;
    }
  }

  const slashed = /^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/.exec(text);
  if (slashed) {
    const first = Number(slashed[1]);
    const second = Number(slashed[2]);
    // Only unambiguous when one of the two cannot be a month.
    if (first > 12 && second <= 12) return `${slashed[3]}-${pad(second)}-${pad(first)}`;
    if (second > 12 && first <= 12) return `${slashed[3]}-${pad(first)}-${pad(second)}`;
    return null;
  }

  return null;
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december'];

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

export function classifyCashflow(
  text: string, amount: number,
): { type: string; confidence: number } {
  const lower = text.toLowerCase();
  if (/capital call|drawdown|draw down|contribution/.test(lower)) return { type: 'Capital Call', confidence: 0.95 };
  if (/return of capital/.test(lower)) return { type: 'Return of Capital', confidence: 0.9 };
  if (/distribution|proceeds|realisation|realization/.test(lower)) return { type: 'Distribution', confidence: 0.95 };
  if (/equalisation|equalization/.test(lower)) return { type: 'Equalisation', confidence: 0.9 };
  if (/management fee|fee/.test(lower)) return { type: 'Fee', confidence: 0.85 };
  if (/expense|cost/.test(lower)) return { type: 'Expense', confidence: 0.8 };
  if (/income|interest|dividend/.test(lower)) return { type: 'Income', confidence: 0.8 };
  if (/commitment/.test(lower)) return { type: 'Commitment', confidence: 0.85 };

  // Nothing in the wording: fall back to the sign, at a confidence that makes
  // clear this is an inference and not something the document said.
  return { type: amount < 0 ? 'Capital Call' : 'Distribution', confidence: 0.4 };
}

/**
 * The amount a notice is actually calling for.
 *
 * Harder than it looks, and worth spelling out because the first attempt got it
 * wrong. Scanning for a number next to the word "due" matched the *date* line —
 * "Due: 14 April 2026" — and produced an amount of 14. A notice also states
 * several numbers that are not the amount due: the components of the call, and
 * the undrawn commitment left afterwards, which is usually the largest number on
 * the page. So neither "the one next to a keyword" nor "the largest" works.
 *
 * Instead: consider only tokens that are shaped like money — grouped thousands
 * or two decimal places, which excludes a bare day or year outright — then score
 * each by the line it sits on. A line saying "total" is what the reader wants; a
 * line about the remaining commitment is context, not the amount.
 */
function findAmount(text: string): { value: number; locator: string } | undefined {
  // Grouped thousands (1'000'000.00, 6,400,000.00) or a plain decimal (1234.56).
  // A bare integer is deliberately not money: it is a day, a year or a notice
  // number far more often than it is an amount.
  const MONEY = /(\d{1,3}(?:[.,'’\u00a0\u202f ]\d{3})+(?:[.,]\d{2})?|\d+[.,]\d{2})/g;

  const WANTED = /\b(total|amount due|payable|call amount|distribution amount|net amount)\b/i;
  const CONTEXT = /\b(undrawn|remaining|unfunded|commitment|balance|to date|cumulative|after this)\b/i;
  const MONTH = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i;

  const candidates: Array<{ value: number; score: number; locator: string }> = [];

  for (const line of text.split(String.fromCharCode(10))) {
    for (const match of line.matchAll(MONEY)) {
      const value = parseNumber(match[1]);
      if (value === null || value === 0) continue;

      let score = 0;
      if (WANTED.test(line)) score += 10;
      // The remaining commitment is usually the biggest figure on the page and
      // is never what is being called.
      if (CONTEXT.test(line)) score -= 8;
      // A number sitting inside a date is not an amount.
      if (MONTH.test(line.slice(match.index ?? 0, (match.index ?? 0) + 24))) score -= 6;
      if (/[.,]\d{2}$/.test(match[1])) score += 1;

      candidates.push({
        value,
        score,
        locator: `"${line.trim().slice(0, 48)}"`,
      });
    }
  }

  if (candidates.length === 0) return undefined;

  // Highest score wins; among equals, the largest amount — a total exceeds the
  // components it is made of.
  const best = candidates.reduce((winner, entry) => {
    if (entry.score !== winner.score) return entry.score > winner.score ? entry : winner;
    return Math.abs(entry.value) > Math.abs(winner.value) ? entry : winner;
  });

  return { value: best.value, locator: best.locator };
}

function findDate(text: string): { value: string; locator: string } | undefined {
  const patterns = [
    /\b(\d{4}-\d{2}-\d{2})\b/,
    /\b(\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4})\b/,
    /\b(\d{1,2}[/.]\d{1,2}[/.]\d{4})\b/,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (!match) continue;
    const parsed = parseDate(match[1]);
    if (parsed) return { value: parsed, locator: `"${match[1]}"` };
  }
  return undefined;
}

function findCurrency(text: string): { value: string; locator: string } | undefined {
  const match = /\b(EUR|USD|GBP|CHF|SEK|NOK|DKK|JPY|CAD|AUD)\b/.exec(text);
  return match ? { value: match[1], locator: `"${match[1]}"` } : undefined;
}

/** The known fund whose name appears most convincingly in the text. */
function findFundName(text: string, context: MatchContext): string | undefined {
  const haystack = text.toLowerCase();
  let best: { name: string; score: number } | undefined;

  for (const position of context.positions) {
    const needle = position.name.toLowerCase();
    if (haystack.includes(needle)) return position.name;
    // A distinctive leading word or two is often all a notice prints.
    const lead = needle.split(' ').slice(0, 2).join(' ');
    if (lead.length >= 6 && haystack.includes(lead)) {
      const score = lead.length;
      if (!best || score > best.score) best = { name: position.name, score };
    }
  }

  return best?.name;
}

export { CONFIDENT };
export type { Issue };
