/**
 * The shape of a book on disk.
 *
 * One folder per client, plain files, nothing binary except the source
 * documents themselves:
 *
 *   book.json                     what this folder is, and how it is protected
 *   clients/<slug>/
 *     client.json                 the client and its conventions
 *     reporting.json              this client's report layouts and branding
 *     vehicles.json               reference data — rewritten when it changes
 *     positions.json
 *     assets.json
 *     investors.json
 *     facts/*.jsonl               one fact per line, appended, never edited
 *     documents/index.jsonl       every file ever loaded, with its hash
 *     documents/files/<hash>.<ext>  the file itself
 *
 * Three decisions worth stating.
 *
 * **Facts are appended, reference data is rewritten.** A valuation is an
 * observation: filing a correction adds a line, and the old line stays because
 * reproducing last quarter as it was published depends on it. A vehicle's name
 * is not an observation; correcting it should not leave two vehicles behind.
 *
 * **JSON Lines, not one big JSON array.** Appending a line to a synced folder
 * uploads the line. Rewriting a 40 MB array every time somebody files a NAV
 * uploads 40 MB, and a sync conflict then costs the whole history rather than
 * one quarter.
 *
 * **Each fact line carries the hash of the one before it.** Editing, deleting
 * or reordering history in a text editor is otherwise invisible; with the chain
 * it is reported, and named down to the line. It costs one hash per fact.
 */

import type {
  Asset, AssetValuation, Cashflow, Client, DataSet, EsgMetric, FxRate, Investor,
  Position, PositionValuation, Vehicle, VehicleBalanceSheet,
} from '../../domain/types';
import type { ReportingProfile } from '../../domain/report';
import type { SourceDocument } from '../../ingest/types';
import {
  appendLines, listFiles, readBytes as readFileBytes, readText as readFileText, writeFile,
  type FileSummary,
} from './fs';
import { protectWith, toBase64, type Cipher, type EncryptionHeader } from './crypto';

/** Bumped only when an older folder would be read wrongly by newer code. */
export const SCHEMA_VERSION = 1;

export interface ClientEntry {
  id: string;
  slug: string;
  name: string;
  shortName: string;
}

export interface BookManifest {
  version: number;
  createdAt: string;
  updatedAt: string;
  /**
   * Present when the book is protected. Read before anything else and never
   * encrypted itself — opening the book depends on it, and it describes only
   * how the key is derived, never what the book holds.
   */
  encryption?: EncryptionHeader;
  /** Plaintext books only. */
  clients?: ClientEntry[];
  /** Protected books: the same list, encrypted. Client names are data too. */
  clientsSealed?: string;
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
  /** How this client's reports look and read. */
  reporting: ReportingProfile;
}>;

const REPORTING_FILE = 'reporting.json';

/* ------------------------------------------------------------------ *
 * The vault
 *
 * Every read and write goes through here, so encryption is one decision made
 * once rather than a flag checked in twenty places — which is how half a book
 * ends up in clear.
 * ------------------------------------------------------------------ */

export interface Vault {
  readonly root: FileSystemDirectoryHandle;
  readonly encrypted: boolean;
  readText(path: string): Promise<string | undefined>;
  writeText(path: string, text: string): Promise<void>;
  readBytes(path: string): Promise<Uint8Array | undefined>;
  writeBytes(path: string, bytes: Uint8Array): Promise<void>;
  /** Fact lines, chain-verified. Problems are reported, never thrown away. */
  readLines(path: string): Promise<{ rows: unknown[]; problems: string[] }>;
  appendRows(path: string, rows: unknown[]): Promise<void>;
}

export function vaultFor(root: FileSystemDirectoryHandle, cipher?: Cipher): Vault {
  const encrypted = cipher !== undefined;

  return {
    root,
    encrypted,

    async readText(path) {
      const text = await readFileText(root, path);
      if (text === undefined || !cipher) return text;
      return cipher.decryptText(text.trim());
    },

    async writeText(path, text) {
      await writeFile(root, path, cipher ? `${await cipher.encryptText(text)}\n` : text);
    },

    async readBytes(path) {
      const bytes = await readFileBytes(root, path);
      if (!bytes || !cipher) return bytes;
      return cipher.decryptBytes(bytes);
    },

    async writeBytes(path, bytes) {
      await writeFile(root, path, cipher ? await cipher.encryptBytes(bytes) : bytes);
    },

    async readLines(path) {
      const text = await readFileText(root, path);
      if (text === undefined) return { rows: [], problems: [] };

      const file = path.slice(path.lastIndexOf('/') + 1);
      const rows: unknown[] = [];
      const problems: string[] = [];
      let previous = '';

      const lines = text.split('\n');
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index].trim();
        if (line === '') continue;
        const at = `${file} line ${index + 1}`;

        let body: string;
        if (cipher) {
          try {
            body = await cipher.decryptText(line);
          } catch {
            problems.push(
              `${at} did not decrypt. The passphrase opened the book, so this line has been altered `
              + 'or truncated. It was skipped; nothing was deleted.',
            );
            continue;
          }
        } else {
          body = line;
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(body);
        } catch {
          problems.push(`${at} is not readable JSON and was skipped.`);
          continue;
        }

        const linked = parsed as { h?: unknown; v?: unknown };
        if (typeof linked?.h === 'string' && linked.v !== undefined) {
          const expected = await chainHash(previous, linked.v);
          if (expected !== linked.h) {
            problems.push(
              `${at} breaks the chain: history before it has been edited, reordered or removed. `
              + 'Every line from here on is suspect.',
            );
          }
          previous = linked.h;
          rows.push(linked.v);
        } else {
          // A line written before the chain existed. Accepted, and the chain
          // restarts from it rather than reporting every later line as broken.
          previous = '';
          rows.push(parsed);
        }
      }

      return { rows, problems };
    },

    async appendRows(path, rows) {
      if (rows.length === 0) return;
      // The chain continues from what is already on disk, so a book written by
      // two machines in turn stays one chain.
      let previous = await lastHash(root, path, cipher);
      const lines: string[] = [];
      for (const row of rows) {
        previous = await chainHash(previous, row);
        const line = JSON.stringify({ h: previous, v: row });
        lines.push(cipher ? await cipher.encryptText(line) : line);
      }
      await appendLines(root, path, lines);
    },
  };
}

/** The chain value for one row, given the one before it. */
async function chainHash(previous: string, row: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(previous + JSON.stringify(row)) as unknown as BufferSource,
  );
  return toBase64(new Uint8Array(digest));
}

async function lastHash(
  root: FileSystemDirectoryHandle, path: string, cipher?: Cipher,
): Promise<string> {
  const text = await readFileText(root, path);
  if (!text) return '';
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  const last = lines[lines.length - 1];
  if (!last) return '';
  try {
    const body = cipher ? await cipher.decryptText(last) : last;
    const parsed = JSON.parse(body) as { h?: unknown };
    return typeof parsed.h === 'string' ? parsed.h : '';
  } catch {
    // An unreadable last line cannot continue a chain. Starting a new one is
    // honest — the break is reported on the next read rather than hidden by a
    // hash computed over something nobody can see.
    return '';
  }
}

/**
 * A folder name for a client.
 *
 * Readable from the client's own name, unless the book is protected — then it
 * is random, because a folder called `ebg` tells anyone holding the drive which
 * clients exist, which is the one thing encryption would otherwise still leak.
 */
export function slugFor(value: string, opaque = false): string {
  if (opaque) return [...crypto.getRandomValues(new Uint8Array(8))]
    .map((byte) => byte.toString(16).padStart(2, '0')).join('');
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
 * The manifest
 * ------------------------------------------------------------------ */

export async function readManifest(
  root: FileSystemDirectoryHandle,
): Promise<BookManifest | undefined> {
  const text = await readFileText(root, MANIFEST);
  if (text === undefined) return undefined;
  const parsed = JSON.parse(text) as BookManifest;
  if (typeof parsed.version !== 'number') {
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

/** The client list, decrypted when the book is protected. */
export async function clientsIn(
  manifest: BookManifest, cipher?: Cipher,
): Promise<ClientEntry[]> {
  if (manifest.clientsSealed) {
    if (!cipher) throw new Error('This book is protected. It cannot be listed without the passphrase.');
    return JSON.parse(await cipher.decryptText(manifest.clientsSealed)) as ClientEntry[];
  }
  return manifest.clients ?? [];
}

async function withClients(
  manifest: BookManifest, clients: ClientEntry[], cipher?: Cipher,
): Promise<BookManifest> {
  const next: BookManifest = { ...manifest, updatedAt: new Date().toISOString() };
  if (cipher) {
    next.clientsSealed = await cipher.encryptText(JSON.stringify(clients));
    delete next.clients;
  } else {
    next.clients = clients;
    delete next.clientsSealed;
  }
  return next;
}

/**
 * Writes the manifest for a folder that has no book yet.
 *
 * A passphrase makes it a protected book from the first byte written. There is
 * deliberately no way to protect a book afterwards: the plaintext would already
 * be in the folder's history, and on a synced drive in the service's version
 * history too, so "encrypt it now" would be a claim the files do not support.
 */
export async function initialiseBook(
  root: FileSystemDirectoryHandle, passphrase?: string,
): Promise<{ manifest: BookManifest; cipher?: Cipher }> {
  const existing = await readManifest(root);
  if (existing) throw new Error('This folder already holds a book.');

  const now = new Date().toISOString();
  const manifest: BookManifest = {
    version: SCHEMA_VERSION, createdAt: now, updatedAt: now, clients: [],
  };
  let cipher: Cipher | undefined;
  if (passphrase) {
    const protection = await protectWith(passphrase);
    manifest.encryption = protection.header;
    delete manifest.clients;
    manifest.clientsSealed = await protection.cipher.encryptText('[]');
    cipher = protection.cipher;
  }
  await writeManifest(root, manifest);
  return { manifest, cipher };
}

/* ------------------------------------------------------------------ *
 * Reading and writing a client
 * ------------------------------------------------------------------ */

/**
 * Reads one client's whole book.
 *
 * A line that cannot be read — bad JSON, a failed decryption, a broken chain —
 * is skipped and reported rather than thrown. One damaged line should cost that
 * fact, not the quarter, and a silent skip would be the worst of both.
 */
export async function readClient(
  vault: Vault, slug: string,
): Promise<{ dataset: DataSet; problems: string[] } | undefined> {
  const dir = clientDir(slug);
  const clientText = await vault.readText(`${dir}/client.json`);
  if (clientText === undefined) return undefined;

  const problems: string[] = [];
  const client = JSON.parse(clientText) as Client;

  const reference = {} as Record<ReferenceKey, unknown[]>;
  for (const [key, file] of Object.entries(REFERENCE_FILES) as [ReferenceKey, string][]) {
    const text = await vault.readText(`${dir}/${file}`);
    reference[key] = text === undefined ? [] : (JSON.parse(text) as unknown[]);
  }

  const reportingText = await vault.readText(`${dir}/${REPORTING_FILE}`);

  const facts = {} as Record<FactKey, unknown[]>;
  for (const [key, file] of Object.entries(FACT_FILES) as [FactKey, string][]) {
    const read = await vault.readLines(`${dir}/facts/${file}`);
    facts[key] = read.rows;
    problems.push(...read.problems);
  }

  return {
    dataset: {
      client,
      reporting: reportingText === undefined
        ? undefined
        : (JSON.parse(reportingText) as ReportingProfile),
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
    problems,
  };
}

/** Creates the folder for a client that is not in the book yet. */
export async function createClient(
  vault: Vault, client: Client, vehicles: Vehicle[], cipher?: Cipher,
): Promise<BookManifest> {
  const now = new Date().toISOString();
  const existing = await readManifest(vault.root);
  const held = existing ? await clientsIn(existing, cipher) : [];

  if (held.some((entry) => entry.id === client.id)) {
    throw new Error(`${client.name} is already in this folder.`);
  }

  const slug = slugFor(client.shortName || client.name, vault.encrypted);
  const base: BookManifest = existing
    ?? { version: SCHEMA_VERSION, createdAt: now, updatedAt: now };

  const dir = clientDir(slug);
  await vault.writeText(`${dir}/client.json`, JSON.stringify(client, null, 2));
  await replaceReference(vault, slug, { vehicles, positions: [], assets: [], investors: [] });

  const manifest = await withClients(base, [
    ...held,
    { id: client.id, slug, name: client.name, shortName: client.shortName },
  ], cipher);
  await writeManifest(vault.root, manifest);
  return manifest;
}

/** Replaces reference data. Anything not named is left as it is. */
export async function replaceReference(
  vault: Vault, slug: string, update: ReferenceUpdate,
): Promise<void> {
  const dir = clientDir(slug);
  if (update.client) {
    await vault.writeText(`${dir}/client.json`, JSON.stringify(update.client, null, 2));
  }
  if (update.reporting) {
    await vault.writeText(`${dir}/${REPORTING_FILE}`, JSON.stringify(update.reporting, null, 2));
  }
  for (const [key, file] of Object.entries(REFERENCE_FILES) as [ReferenceKey, string][]) {
    const rows = update[key];
    if (!rows) continue;
    await vault.writeText(`${dir}/${file}`, JSON.stringify(rows, null, 2));
  }
}

/** Appends facts. Returns how many lines were written, per file. */
export async function appendFacts(
  vault: Vault, slug: string, batch: FactBatch,
): Promise<Record<string, number>> {
  const written: Record<string, number> = {};
  for (const [key, file] of Object.entries(FACT_FILES) as [FactKey, string][]) {
    const rows = batch[key];
    if (!rows || rows.length === 0) continue;
    await vault.appendRows(`${clientDir(slug)}/facts/${file}`, rows);
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
  vault: Vault,
  slug: string,
  document: SourceDocument,
  bytes?: Uint8Array,
): Promise<void> {
  const dir = `${clientDir(slug)}/documents`;
  if (bytes) {
    const extension = document.name.includes('.')
      ? document.name.slice(document.name.lastIndexOf('.')).toLowerCase()
      : '';
    await vault.writeBytes(`${dir}/files/${document.contentHash}${extension}`, bytes);
  }
  await vault.appendRows(`${dir}/index.jsonl`, [document]);
}

export async function readDocuments(vault: Vault, slug: string): Promise<SourceDocument[]> {
  const read = await vault.readLines(`${clientDir(slug)}/documents/index.jsonl`);
  return read.rows as SourceDocument[];
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
