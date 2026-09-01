/**
 * Ingestion.
 *
 * Everything that enters this system arrives as one of four things: a
 * historical spreadsheet, a capital account statement, a transaction notice, or
 * an administrator's NAV pack. They differ in format and in nothing else — each
 * is a document that somebody received, that asserts some facts, that need
 * checking before they become numbers a report is built on.
 *
 * So there is one pipeline, and the format only decides how the first step is
 * performed:
 *
 *   document -> extraction -> candidate facts -> review -> commit
 *
 * The review step is not optional and is not a formality. An extracted figure
 * is a *claim about* a document, not the document; a wrong claim that lands
 * silently in the fact tables is indistinguishable from a correct one six
 * months later. Every candidate therefore carries what it was read from, how
 * confident the extractor was, and — once committed — the document it came
 * from, so any figure on any report can be traced back to the page it was read
 * off.
 */

import type { PeriodId } from '../domain/period';
import type { CashflowType, CurrencyCode } from '../domain/types';

/* ------------------------------------------------------------------ *
 * Documents
 * ------------------------------------------------------------------ */

export type DocumentKind =
  /** A historical database or position listing, usually one row per holding. */
  | 'historical-workbook'
  /** A GP's capital account statement for one investor in one fund. */
  | 'capital-account-statement'
  /** A drawdown or distribution notice. */
  | 'transaction-notice'
  /** Audited or unaudited financial statements. */
  | 'financial-statements'
  /** An administrator's pack: trial balance, balance sheet, profit and loss. */
  | 'nav-pack'
  /** Somebody typed it in. Still a document, so it is still traceable. */
  | 'manual-entry';

export const DOCUMENT_KIND_LABEL: Record<DocumentKind, string> = {
  'historical-workbook': 'Historical workbook',
  'capital-account-statement': 'Capital account statement',
  'transaction-notice': 'Transaction notice',
  'financial-statements': 'Financial statements',
  'nav-pack': 'Administrator NAV pack',
  'manual-entry': 'Manual entry',
};

export interface SourceDocument {
  id: string;
  clientId: string;
  kind: DocumentKind;
  /** Original filename, or a description for a manual entry. */
  name: string;
  mimeType: string;
  sizeBytes: number;
  /**
   * SHA-256 of the file. Two purposes: detecting a re-upload of something
   * already processed, and proving years later that the file on the shared
   * drive is the one the numbers were read from.
   */
  contentHash: string;
  /** Where the file itself lives. A pointer, not the bytes. */
  storageRef?: string;
  /** Period the document is understood to describe, once known. */
  period?: PeriodId;
  uploadedAt: string;
  uploadedBy?: string;
  status: 'uploaded' | 'extracted' | 'in-review' | 'committed' | 'rejected';
  note?: string;
}

/* ------------------------------------------------------------------ *
 * Candidate facts
 * ------------------------------------------------------------------ */

/**
 * What a candidate would become. Each maps onto exactly one fact table, so a
 * committed candidate is a single insert and nothing has to be reconciled
 * afterwards.
 */
export type CandidateKind =
  | 'position-valuation'
  | 'cashflow'
  | 'balance-sheet'
  | 'fx-rate'
  | 'position'
  | 'asset-valuation';

export interface FieldValue<T> {
  value: T;
  /**
   * What this was read from — a cell reference, a page and line, a column
   * header. A reviewer checking a figure needs to find it in the original
   * without reading the whole document.
   */
  locator?: string;
  /**
   * 0..1. Below `REVIEW_THRESHOLD` the field is flagged for attention rather
   * than presented as settled.
   */
  confidence: number;
}

/** A candidate below this is surfaced for explicit confirmation. */
export const REVIEW_THRESHOLD = 0.9;

export interface Candidate {
  id: string;
  documentId: string;
  kind: CandidateKind;
  /** Populated fields, keyed by the target column. */
  fields: Record<string, FieldValue<string | number | boolean | null>>;
  /**
   * Resolved target. Entity matching happens at extraction time and is
   * reviewable, because a valuation posted to the wrong fund is worse than one
   * not posted at all.
   */
  match?: EntityMatch;
  /** Problems found by validation. A candidate with an error cannot commit. */
  issues: Issue[];
  /** Set when this candidate duplicates something already in the fact tables. */
  duplicateOf?: string;
  state: 'pending' | 'accepted' | 'rejected';
}

export interface EntityMatch {
  kind: 'position' | 'investor' | 'vehicle' | 'asset';
  id?: string;
  /** The name as written in the document. */
  sourceName: string;
  /** The name it was matched to. */
  matchedName?: string;
  confidence: number;
  /** Other plausible targets, so a reviewer can correct without searching. */
  alternatives: Array<{ id: string; name: string; score: number }>;
}

export interface Issue {
  severity: 'error' | 'warning';
  field?: string;
  message: string;
}

export interface ExtractionResult {
  document: SourceDocument;
  candidates: Candidate[];
  /** Anything the extractor could not interpret, kept for the reviewer. */
  unparsed: string[];
  /** One line on what the extractor did and how far it got. */
  summary: string;
}

/* ------------------------------------------------------------------ *
 * Extractors
 * ------------------------------------------------------------------ */

/**
 * A format driver. Adding a new document format means adding one of these; the
 * review, validation and commit steps are unchanged.
 */
export interface Extractor {
  kind: DocumentKind;
  label: string;
  /** File extensions and MIME types this driver handles. */
  accepts: string[];
  /** What this driver can and cannot do, shown to the user before they upload. */
  capability: string;
  extract(input: ExtractionInput): Promise<ExtractionResult>;
}

export interface ExtractionInput {
  document: SourceDocument;
  /** Raw bytes, for a driver that parses a binary format. */
  bytes?: Uint8Array;
  /** Decoded text, for a driver that works on text. */
  text?: string;
  /** Tabular content, for a driver handed an already-parsed sheet. */
  table?: TableData;
  /** Known entities, for matching. */
  context: MatchContext;
  /** Period the user says the document describes, when they have told us. */
  period?: PeriodId;
}

export interface TableData {
  sheetName: string;
  rows: Array<Array<string | number | null>>;
}

export interface MatchContext {
  clientId: string;
  vehicles: Array<{ id: string; name: string; shortName: string; currency: CurrencyCode }>;
  positions: Array<{ id: string; vehicleId: string; name: string; currency: CurrencyCode }>;
  investors: Array<{ id: string; vehicleId: string; name: string; currency: CurrencyCode }>;
  assets: Array<{ id: string; positionId: string; name: string }>;
}

/* ------------------------------------------------------------------ *
 * The shapes a candidate commits into
 * ------------------------------------------------------------------ */

export interface ValuationDraft {
  positionId: string;
  period: PeriodId;
  nav: number;
  drawnCumulative?: number;
  distributedCumulative?: number;
  recallableCumulative?: number;
  source: string;
}

export interface CashflowDraft {
  vehicleId: string;
  positionId?: string;
  investorId?: string;
  type: CashflowType;
  amount: number;
  currency: CurrencyCode;
  date: string;
  period: PeriodId;
  affectsCommitment: boolean;
  recallable?: boolean;
  description?: string;
}

export interface BalanceSheetDraft {
  vehicleId: string;
  period: PeriodId;
  cash: number;
  otherAssets: number;
  currentLiabilities: number;
  accruedExpenses: number;
  source: string;
}
