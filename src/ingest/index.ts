/**
 * The ingestion pipeline.
 *
 *   file -> hash -> parse -> extract -> validate -> review -> commit
 *
 * One path, whatever the format. The format only decides which driver performs
 * the parse and extract steps.
 */

import type { DataSet } from '../domain/types';
import type { PeriodId } from '../domain/period';
import {
  detectDelimiter, parseCsv, parseXlsx, type Cell,
} from './workbook';
import { extractorFor } from './extractors';
import { validateAll } from './validate';
import type {
  Candidate, DocumentKind, ExtractionResult, MatchContext, SourceDocument, TableData,
} from './types';

export * from './types';
export { matchEntity, similarity, normalise } from './match';
export { EXTRACTORS, extractorFor, mapColumns, parseDate } from './extractors';
export { validateAll, canCommit, stringField, numberField, booleanField } from './validate';
export { parseCsv, parseXlsx, parseNumber, findHeaderRow, detectDelimiter } from './workbook';
export type { Cell } from './workbook';

/** Everything the pipeline needs about one uploaded file. */
export interface IngestRequest {
  file: File;
  kind: DocumentKind;
  clientId: string;
  /** Period the user says the document describes, when they know. */
  period?: PeriodId;
  /** Vehicle currently in scope, used as the target for vehicle-level documents. */
  vehicleId?: string;
  /** Sheet to read, for a multi-sheet workbook. */
  sheetName?: string;
  uploadedBy?: string;
}

export interface IngestOutcome extends ExtractionResult {
  /** Sheets found, so the caller can offer a choice when there are several. */
  availableSheets?: string[];
}

/** 25 MB. Larger than any statement, small enough not to hang a browser tab. */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;

const ALLOWED_EXTENSIONS = ['.csv', '.tsv', '.txt', '.xlsx', '.pdf'];

export async function ingest(
  request: IngestRequest,
  dataset: DataSet,
): Promise<IngestOutcome> {
  const { file, kind, clientId, period } = request;

  if (file.size > MAX_FILE_BYTES) {
    throw new Error(
      `${file.name} is ${(file.size / 1024 / 1024).toFixed(1)} MB, above the ${MAX_FILE_BYTES / 1024 / 1024} MB limit.`,
    );
  }

  const extension = fileExtension(file.name);
  if (!ALLOWED_EXTENSIONS.includes(extension)) {
    throw new Error(
      `${extension || 'This file type'} is not accepted. Supported: ${ALLOWED_EXTENSIONS.join(', ')}.`,
    );
  }

  const bytes = new Uint8Array(await file.arrayBuffer());

  const document: SourceDocument = {
    id: `doc-${await shortHash(bytes)}`,
    clientId,
    kind,
    name: file.name,
    mimeType: file.type || guessMime(extension),
    sizeBytes: file.size,
    // The full hash proves years later that the file on the shared drive is the
    // one these numbers were read from.
    contentHash: await sha256(bytes),
    period,
    uploadedAt: new Date().toISOString(),
    uploadedBy: request.uploadedBy,
    status: 'uploaded',
  };

  const extractor = extractorFor(kind);
  if (!extractor) {
    throw new Error(`No reader is registered for ${kind}.`);
  }

  const context = buildMatchContext(dataset);

  // Parse into whichever shape the driver wants.
  let table: TableData | undefined;
  let text: string | undefined;
  let availableSheets: string[] | undefined;

  if (extension === '.pdf') {
    const { extractPdfText } = await import('./pdf');
    const parsed = await extractPdfText(bytes);
    if (parsed.needsOcr) {
      return {
        document: { ...document, status: 'extracted' },
        candidates: [],
        unparsed: [],
        summary:
          `${file.name} has ${parsed.pageCount} page(s) but no text layer — it is a scan. `
          + 'Nothing can be read from it without OCR. Enter the figures manually against this document, '
          + 'which keeps them just as traceable.',
      };
    }
    text = parsed.text;
  } else if (extension === '.xlsx') {
    const workbook = parseXlsx(bytes);
    availableSheets = workbook.sheets.map((sheet) => sheet.sheetName);
    table = request.sheetName
      ? workbook.sheets.find((sheet) => sheet.sheetName === request.sheetName)
      : pickSheet(workbook.sheets);
    if (!table) throw new Error(`The workbook has no sheet named "${request.sheetName}".`);
  } else {
    const decoded = new TextDecoder('utf-8').decode(bytes);
    const rows = parseCsv(decoded, detectDelimiter(decoded));
    table = { sheetName: file.name, rows };
  }

  const result = await extractor.extract({
    document, bytes, text, table, context, period, vehicleId: request.vehicleId,
  });

  return {
    ...result,
    document: { ...result.document, status: result.candidates.length > 0 ? 'in-review' : 'extracted' },
    candidates: validateAll(result.candidates, dataset),
    availableSheets,
  };
}

/**
 * The sheet most likely to hold the data: the one with the most rows that look
 * tabular. A workbook's first sheet is often a cover page.
 */
function pickSheet(sheets: TableData[]): TableData | undefined {
  return [...sheets].sort((a, b) => score(b) - score(a))[0];
}

function score(sheet: TableData): number {
  const populated = sheet.rows.filter((row) => row.filter(nonEmpty).length >= 2);
  return populated.length;
}

function nonEmpty(cell: Cell): boolean {
  return cell !== null && String(cell).trim() !== '';
}

export function buildMatchContext(dataset: DataSet): MatchContext {
  return {
    clientId: dataset.client.id,
    vehicles: dataset.vehicles.map((v) => ({
      id: v.id, name: v.name, shortName: v.shortName, currency: v.currency,
    })),
    positions: dataset.positions.map((p) => ({
      id: p.id, vehicleId: p.vehicleId, name: p.name, currency: p.currency,
    })),
    investors: dataset.investors.map((i) => ({
      id: i.id, vehicleId: i.vehicleId, name: i.name, currency: i.currency,
    })),
    assets: dataset.assets.map((a) => ({ id: a.id, positionId: a.positionId, name: a.name })),
  };
}

/**
 * Applies accepted candidates to an in-memory dataset.
 *
 * Facts are appended, never edited: a correction is a new observation with a
 * later `recordedAt`, which is what keeps an already-published quarter
 * reproducible. Against a real backend this is the same set of inserts.
 */
export function applyCandidates(
  dataset: DataSet,
  candidates: Candidate[],
  document: SourceDocument,
): DataSet {
  const recordedAt = new Date().toISOString();
  const next: DataSet = {
    ...dataset,
    positionValuations: [...dataset.positionValuations],
    cashflows: [...dataset.cashflows],
    balanceSheets: [...dataset.balanceSheets],
  };

  let sequence = 0;
  const id = (prefix: string) => `${prefix}-${document.id}-${(sequence += 1)}`;

  for (const candidate of candidates) {
    if (candidate.state !== 'accepted') continue;
    const value = <T>(name: string): T | undefined => candidate.fields[name]?.value as T | undefined;

    if (candidate.kind === 'position-valuation' && candidate.match?.id) {
      next.positionValuations.push({
        id: id('val'),
        positionId: candidate.match.id,
        period: value<string>('period')!,
        recordedAt,
        nav: value<number>('nav')!,
        drawnCumulative: value<number>('drawnCumulative'),
        distributedCumulative: value<number>('distributedCumulative'),
        recallableCumulative: value<number>('recallableCumulative'),
        source: value<string>('source') ?? document.name,
      });
      continue;
    }

    if (candidate.kind === 'cashflow') {
      const positionId = candidate.match?.kind === 'position' ? candidate.match.id : undefined;
      const investorId = candidate.match?.kind === 'investor' ? candidate.match.id : undefined;
      const vehicleId = positionId
        ? dataset.positions.find((p) => p.id === positionId)?.vehicleId
        : investorId
          ? dataset.investors.find((i) => i.id === investorId)?.vehicleId
          : dataset.vehicles[0]?.id;
      if (!vehicleId) continue;

      next.cashflows.push({
        id: id('cf'),
        vehicleId,
        positionId,
        investorId,
        type: value<string>('type') as never,
        amount: value<number>('amount')!,
        currency: value<string>('currency')!,
        date: value<string>('date')!,
        period: value<string>('period')!,
        recordedAt,
        affectsCommitment: value<boolean>('affectsCommitment') ?? false,
        recallable: value<boolean>('recallable'),
        description: value<string>('description'),
        status: 'Settled',
      });
      continue;
    }

    if (candidate.kind === 'balance-sheet' && candidate.match?.id) {
      next.balanceSheets.push({
        vehicleId: candidate.match.id,
        period: value<string>('period')!,
        recordedAt,
        cash: value<number>('cash') ?? 0,
        otherAssets: value<number>('otherAssets') ?? 0,
        currentLiabilities: value<number>('currentLiabilities') ?? 0,
        accruedExpenses: value<number>('accruedExpenses') ?? 0,
        source: value<string>('source') ?? document.name,
      });
    }
  }

  return next;
}

/* ------------------------------------------------------------------ *
 * Hashing
 * ------------------------------------------------------------------ */

export async function sha256(bytes: Uint8Array): Promise<string> {
  // Available in browsers over HTTPS and in Node 18+.
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function shortHash(bytes: Uint8Array): Promise<string> {
  return (await sha256(bytes)).slice(0, 12);
}

function fileExtension(name: string): string {
  const index = name.lastIndexOf('.');
  return index >= 0 ? name.slice(index).toLowerCase() : '';
}

function guessMime(extension: string): string {
  switch (extension) {
    case '.pdf': return 'application/pdf';
    case '.xlsx': return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    case '.csv': return 'text/csv';
    default: return 'application/octet-stream';
  }
}
