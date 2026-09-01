/**
 * The shape of a book on disk.
 *
 * One folder per client, plain files, nothing binary except the source
 * documents themselves:
 *
 *   book.json                     what this folder is, and which schema
 *   clients/<slug>/
 *     client.json                 the client and its conventions
 *     vehicles.json               reference data — rewritten when it changes
 *     positions.json
 *     assets.json
 *     investors.json
 *     facts/*.jsonl               one fact per line, appended, never edited
 *     documents/index.jsonl       every file ever loaded, with its hash
 *     documents/files/<hash>.<ext>  the file itself
 *
 * Two decisions worth stating.
 *
 * **Facts are appended, reference data is rewritten.** A valuation is an
 * observation: filing a correction adds a line, and the old line stays because
 * reproducing last quarter as it was published depends on it. A vehicle's name
 * is not an observation; correcting it should not leave two vehicles behind.
 *
 * **JSON Lines, not one big JSON array.** Appending a line to a synced folder
 * uploads the line. Rewriting a 40 MB array every time somebody files a NAV
 * uploads 40 MB, and a sync conflict then costs the whole history rather than
 * one quarter. It is also readable in any text editor, and a corrupted line is
 * one bad fact rather than an unopenable book.
 */

import type {
  Asset, AssetValuation, Cashflow, Client, DataSet, EsgMetric, FxRate, Investor,
  Position, PositionValuation, Vehicle, VehicleBalanceSheet,
} from '../../domain/types';
import type { SourceDocument } from '../../ingest/types';
import { appendLines, listFiles, readText, writeFile, type FileSummary } from './fs';

/** Bumped only when an older folder would be read wrongly by newer code. */
export const SCHEMA_VERSION = 1;

export interface BookManifest {
  version: number;
  createdAt: string;
  updatedAt: string;
  clients: Array<{ id: string; slug: string; name: string; shortName: string }>;
}

const MANIFEST = 'book.json';

/** Fact files, keyed by the `DataSet` property they fill. */
const FACT_FILES = {
  positionValuations: 'position_valuations.jsonl',
  assetValuations: 'asset_valuations.jsonl',
  cashflows: 'cashflows.jsonl',
  balanceSheets: 'balance_sheets.jsonl',
  fxRates: 'fx_rates.jsonl',
  esgMetrics: 'esg_metrics.jsonl',
} as const;

type FactKey = keyof typeof FACT_FILES;

const REFERENCE_FILES = {
  vehicles: 'vehicles.json',
  positions: 'positions.json',
  assets: 'assets.json',
  investors: 'investors.json',
} as const;

type ReferenceKey = keyof typeof REFERENCE_FILES;

/** Facts that can be appended to a book, in one call. */
export type FactBatch = Partial<{
  positionValuations: PositionValuation[];
  assetValuations: AssetValuation[];
  cashflows: Cashflow[];
  balanceSheets: VehicleBalanceSheet[];
  fxRates: FxRate[];
  esgMetrics: EsgMetric[];
}>;

/** Reference data that can be replaced wholesale. */
export type ReferenceUpdate = Partial<{
  client: Client;
  vehicles: Vehicle[];
  positions: Position[];
  assets: Asset[];
  investors: Investor[];
}>;

/**
 * A folder name for a client id. Windows, macOS and a synced drive all have
 * opinions about characters in file names; the intersection is small.
 */
export function slugFor(value: string): string {
  const slug = value.toLowerCase().normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || 'client';
}

function clientDir(slug: string): string {
  return `clients/${slug}`;
}

/* ------------------------------------------------------------------ *
 * Reading
 * ------------------------------------------------------------------ */

export async function readManifest(
  root: FileSystemDirectoryHandle,
): Promise<BookManifest | undefined> {
  const text = await readText(root, MANIFEST);
  if (text === undefined) return undefined;
  const parsed = JSON.parse(text) as BookManifest;
  if (typeof parsed.version !== 'number' || !Array.isArray(parsed.clients)) {
    throw new Error(`${MANIFEST} is not a book manifest.`);
  }
  if (parsed.version > SCHEMA_VERSION) {
    throw new Error(
      `This folder was written by a newer version of the application (schema ${parsed.version}, `
      + `this build reads ${SCHEMA_VERSION}). Update before opening it, or the figures may be read wrongly.`,
    );
  }
  return parsed;
}

export async function writeManifest(
  root: FileSystemDirectoryHandle, manifest: BookManifest,
): Promise<void> {
  await writeFile(root, MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
}

/**
 * Reads one client's whole book.
 *
 * A malformed line is skipped and counted rather than thrown: one bad line in a
 * hand-edited file should cost that fact, not the quarter. What was skipped
 * comes back with the data so the interface can say so — a silent skip would be
 * the worst of both.
 */
export async function readClient(
  root: FileSystemDirectoryHandle, slug: string,
): Promise<{ dataset: DataSet; skipped: string[] } | undefined> {
  const dir = clientDir(slug);
  const clientText = await readText(root, `${dir}/client.json`);
  if (clientText === undefined) return undefined;

  const skipped: string[] = [];
  const client = JSON.parse(clientText) as Client;

  const reference = {} as Record<ReferenceKey, unknown[]>;
  for (const [key, file] of Object.entries(REFERENCE_FILES) as [ReferenceKey, string][]) {
    const text = await readText(root, `${dir}/${file}`);
    reference[key] = text === undefined ? [] : (JSON.parse(text) as unknown[]);
  }

  const facts = {} as Record<FactKey, unknown[]>;
  for (const [key, file] of Object.entries(FACT_FILES) as [FactKey, string][]) {
    const text = await readText(root, `${dir}/facts/${file}`);
    facts[key] = text === undefined ? [] : parseLines(text, file, skipped);
  }

  return {
    dataset: {
      client,
      vehicles: reference.vehicles as Vehicle[],
      positions: reference.positions as Position[],
      assets: reference.assets as Asset[],
      investors: reference.investors as Investor[],
      positionValuations: facts.positionValuations as PositionValuation[],
      assetValuations: facts.assetValuations as AssetValuation[],
      cashflows: facts.cashflows as Cashflow[],
      balanceSheets: facts.balanceSheets as VehicleBalanceSheet[],
      fxRates: facts.fxRates as FxRate[],
      esgMetrics: facts.esgMetrics as EsgMetric[],
    },
    skipped,
  };
}

function parseLines(text: string, file: string, skipped: string[]): unknown[] {
  const rows: unknown[] = [];
  text.split('\n').forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed === '') return;
    try {
      rows.push(JSON.parse(trimmed));
    } catch {
      skipped.push(`${file} line ${index + 1} is not readable JSON and was skipped.`);
    }
  });
  return rows;
}

/* ------------------------------------------------------------------ *
 * Writing
 * ------------------------------------------------------------------ */

/** Creates the folder for a client that is not in the book yet. */
export async function createClient(
  root: FileSystemDirectoryHandle, client: Client, vehicles: Vehicle[],
): Promise<BookManifest> {
  const slug = slugFor(client.shortName || client.name);
  const now = new Date().toISOString();
  const existing = await readManifest(root);

  if (existing?.clients.some((entry) => entry.id === client.id)) {
    throw new Error(`${client.name} is already in this folder.`);
  }

  const manifest: BookManifest = existing
    ? { ...existing, updatedAt: now }
    : { version: SCHEMA_VERSION, createdAt: now, updatedAt: now, clients: [] };
  manifest.clients = [
    ...manifest.clients,
    { id: client.id, slug, name: client.name, shortName: client.shortName },
  ];

  const dir = clientDir(slug);
  await writeFile(root, `${dir}/client.json`, `${JSON.stringify(client, null, 2)}\n`);
  await replaceReference(root, slug, { vehicles, positions: [], assets: [], investors: [] });
  await writeManifest(root, manifest);
  return manifest;
}

/** Replaces reference data. Anything not named is left as it is. */
export async function replaceReference(
  root: FileSystemDirectoryHandle, slug: string, update: ReferenceUpdate,
): Promise<void> {
  const dir = clientDir(slug);
  if (update.client) {
    await writeFile(root, `${dir}/client.json`, `${JSON.stringify(update.client, null, 2)}\n`);
  }
  for (const [key, file] of Object.entries(REFERENCE_FILES) as [ReferenceKey, string][]) {
    const rows = update[key];
    if (!rows) continue;
    await writeFile(root, `${dir}/${file}`, `${JSON.stringify(rows, null, 2)}\n`);
  }
}

/** Appends facts. Returns how many lines were written, per file. */
export async function appendFacts(
  root: FileSystemDirectoryHandle, slug: string, batch: FactBatch,
): Promise<Record<string, number>> {
  const written: Record<string, number> = {};
  for (const [key, file] of Object.entries(FACT_FILES) as [FactKey, string][]) {
    const rows = batch[key];
    if (!rows || rows.length === 0) continue;
    await appendLines(
      root,
      `${clientDir(slug)}/facts/${file}`,
      rows.map((row) => JSON.stringify(row)),
    );
    written[file] = rows.length;
  }
  return written;
}

/**
 * Records a loaded document and keeps the file itself.
 *
 * Named by content hash: the same file loaded twice is one file on disk, and
 * the name is the proof that the figures came from it. The original name is in
 * the index line, because a hash tells a person nothing.
 */
export async function storeDocument(
  root: FileSystemDirectoryHandle,
  slug: string,
  document: SourceDocument,
  bytes?: Uint8Array,
): Promise<void> {
  const dir = `${clientDir(slug)}/documents`;
  if (bytes) {
    const extension = document.name.includes('.')
      ? document.name.slice(document.name.lastIndexOf('.')).toLowerCase()
      : '';
    await writeFile(root, `${dir}/files/${document.contentHash}${extension}`, bytes);
  }
  await appendLines(root, `${dir}/index.jsonl`, [JSON.stringify(document)]);
}

export async function readDocuments(
  root: FileSystemDirectoryHandle, slug: string,
): Promise<SourceDocument[]> {
  const text = await readText(root, `${clientDir(slug)}/documents/index.jsonl`);
  if (text === undefined) return [];
  return parseLines(text, 'index.jsonl', []) as SourceDocument[];
}

/* ------------------------------------------------------------------ *
 * Describing what is there
 * ------------------------------------------------------------------ */

export interface BookSummary {
  manifest?: BookManifest;
  files: FileSummary[];
  bytes: number;
  lastWrite?: number;
}

export async function summarise(root: FileSystemDirectoryHandle): Promise<BookSummary> {
  const files = await listFiles(root);
  return {
    manifest: await readManifest(root).catch(() => undefined),
    files,
    bytes: files.reduce((total, file) => total + file.bytes, 0),
    lastWrite: files.reduce<number | undefined>(
      (latest, file) => (latest === undefined || file.modified > latest ? file.modified : latest),
      undefined,
    ),
  };
}
