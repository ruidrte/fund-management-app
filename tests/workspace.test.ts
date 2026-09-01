/**
 * The folder book.
 *
 * The File System Access API only exists in a browser, so these run against an
 * in-memory stand-in that behaves the way the real one does in the ways this
 * code depends on: create-on-demand directories, writables that replace a file
 * on close, and `keepExistingData` plus `seek` for appending.
 */

import { describe, expect, it } from 'vitest';
import {
  appendFacts, clientsIn, createClient, initialiseBook, readClient, readDocuments,
  readManifest, slugFor, storeDocument, summarise, vaultFor, writeManifest,
} from '../src/data/workspace/store';
import { unlock, WrongPassphrase } from '../src/data/workspace/crypto';
import { openBook } from '../src/data/workspace/repository';
import { buildClientStructure } from '../src/data/demo';
import { factsFrom } from '../src/ingest';
import type { Candidate, SourceDocument } from '../src/ingest/types';
import type { DataSet, PositionValuation } from '../src/domain/types';

/* ------------------------------------------------------------------ *
 * An in-memory directory that behaves like the browser's
 * ------------------------------------------------------------------ */

interface MemoryFile { data: Uint8Array; lastModified: number }

function memoryDirectory(name = 'book'): FileSystemDirectoryHandle {
  const files = new Map<string, MemoryFile>();
  const dirs = new Map<string, FileSystemDirectoryHandle>();

  const handle = {
    kind: 'directory' as const,
    name,

    async getDirectoryHandle(child: string, options?: { create?: boolean }) {
      const existing = dirs.get(child);
      if (existing) return existing;
      if (!options?.create) throw new DOMException('not found', 'NotFoundError');
      const created = memoryDirectory(child);
      dirs.set(child, created);
      return created;
    },

    async getFileHandle(child: string, options?: { create?: boolean }) {
      if (!files.has(child)) {
        if (!options?.create) throw new DOMException('not found', 'NotFoundError');
        files.set(child, { data: new Uint8Array(), lastModified: Date.now() });
      }
      return fileHandle(child);
    },

    async *[Symbol.asyncIterator]() {
      for (const [child, dir] of dirs) yield [child, dir] as [string, FileSystemHandle];
      for (const child of files.keys()) yield [child, await fileHandle(child)] as [string, FileSystemHandle];
    },
  };

  async function fileHandle(child: string) {
    return {
      kind: 'file' as const,
      name: child,
      async getFile() {
        const stored = files.get(child)!;
        return {
          size: stored.data.byteLength,
          lastModified: stored.lastModified,
          async text() { return new TextDecoder().decode(stored.data); },
          async arrayBuffer() { return stored.data.slice().buffer; },
        } as unknown as File;
      },
      async createWritable(options?: { keepExistingData?: boolean }) {
        const stored = files.get(child)!;
        let buffer = options?.keepExistingData ? [...stored.data] : [];
        let position = 0;
        return {
          async write(chunk: string | Uint8Array) {
            const bytes = typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk;
            const next = [...buffer];
            for (let i = 0; i < bytes.length; i += 1) next[position + i] = bytes[i];
            buffer = next;
            position += bytes.length;
          },
          async seek(offset: number) { position = offset; },
          async close() {
            files.set(child, { data: Uint8Array.from(buffer), lastModified: Date.now() });
          },
        } as unknown as FileSystemWritableFileStream;
      },
    } as unknown as FileSystemFileHandle;
  }

  return handle as unknown as FileSystemDirectoryHandle;
}

/** A folder with one client in it, plaintext unless a passphrase is given. */
async function bookWith(clientId: string, passphrase?: string) {
  const root = memoryDirectory();
  const started = await initialiseBook(root, passphrase);
  const vault = vaultFor(root, started.cipher);
  const { client, vehicles } = buildClientStructure(clientId);
  const manifest = await createClient(vault, client, vehicles, started.cipher);
  const [entry] = await clientsIn(manifest, started.cipher);
  return { root, vault, cipher: started.cipher, manifest, client, vehicles, slug: entry.slug };
}

const doc = (over: Partial<SourceDocument> = {}): SourceDocument => ({
  id: 'doc-1', clientId: 'client-ebg', kind: 'historical-workbook',
  name: 'AbIF Q1 2026.xlsx', mimeType: 'application/vnd.ms-excel', sizeBytes: 12,
  contentHash: 'a1b2c3', uploadedAt: '2026-04-20T09:00:00Z', status: 'uploaded', ...over,
});

const valuation = (id: string, nav: number): PositionValuation => ({
  id, positionId: 'pos-1', period: '2026Q1', recordedAt: '2026-04-20T09:00:00Z', nav,
  source: 'GP report',
});

describe('naming a folder for a client', () => {
  it('survives accents, punctuation and length', () => {
    expect(slugFor('EBG Investment Solutions')).toBe('ebg-investment-solutions');
    expect(slugFor('Patrimónium / Asset')).toBe('patrimonium-asset');
    expect(slugFor('!!!')).toBe('client');
  });
});

describe('starting a book', () => {
  it('writes the structure and nothing measured', async () => {
    const { vault, slug, vehicles, client, manifest } = await bookWith('client-ebg');

    expect(manifest.clients).toHaveLength(1);
    expect(manifest.clients![0].id).toBe(client.id);

    const read = await readClient(vault, slug);
    expect(read!.dataset.vehicles.map((v) => v.shortName)).toEqual(vehicles.map((v) => v.shortName));
    // A new book has the real structure and not one figure.
    expect(read!.dataset.positions).toHaveLength(0);
    expect(read!.dataset.positionValuations).toHaveLength(0);
  });

  it('refuses to add the same client twice', async () => {
    const { vault, client, vehicles } = await bookWith('client-pam');
    await expect(createClient(vault, client, vehicles)).rejects.toThrow(/already in this folder/);
  });

  it('refuses a folder written by a newer version', async () => {
    const root = memoryDirectory();
    await writeManifest(root, {
      version: 99, createdAt: 'x', updatedAt: 'x', clients: [],
    });
    await expect(readManifest(root)).rejects.toThrow(/newer version/);
  });
});

describe('facts are appended, never rewritten', () => {
  it('keeps what was already there', async () => {
    const { vault, slug } = await bookWith('client-ebg');

    await appendFacts(vault, slug, { positionValuations: [valuation('v1', 100)] });
    await appendFacts(vault, slug, { positionValuations: [valuation('v2', 110)] });

    const read = await readClient(vault, slug);
    expect(read!.dataset.positionValuations.map((v) => v.id)).toEqual(['v1', 'v2']);
    // The restatement sits alongside the original rather than replacing it,
    // which is what lets the first quarter still be reproduced as published.
    expect(read!.dataset.positionValuations.map((v) => v.nav)).toEqual([100, 110]);
  });

  it('skips a line it cannot read, reports it, and keeps the rest', async () => {
    const { root, vault, slug } = await bookWith('client-ut');

    await appendFacts(vault, slug, { positionValuations: [valuation('v1', 100)] });
    // As if somebody had edited the file by hand and broken a line.
    const facts = await root.getDirectoryHandle('clients');
    const dir = await (await facts.getDirectoryHandle(slug)).getDirectoryHandle('facts');
    const handle = await dir.getFileHandle('position_valuations.jsonl');
    const existing = await (await handle.getFile()).text();
    const writable = await handle.createWritable();
    await writable.write(`${existing}{"broken":\n`);
    await writable.close();

    const read = await readClient(vault, slug);
    expect(read!.dataset.positionValuations).toHaveLength(1);
    expect(read!.problems.join(' ')).toMatch(/position_valuations.jsonl line 2/);
  });

  it('reports history that has been edited or removed behind its back', async () => {
    const { root, vault, slug } = await bookWith('client-ebg');
    await appendFacts(vault, slug, {
      positionValuations: [valuation('v1', 100), valuation('v2', 110), valuation('v3', 120)],
    });

    // Somebody deletes the middle line in a text editor. Without the chain this
    // is invisible: the file still parses and the quarter is simply short.
    const handle = await factFile(root, slug);
    const lines = (await (await handle.getFile()).text()).trim().split('\n');
    const writable = await handle.createWritable();
    await writable.write(`${[lines[0], lines[2]].join('\n')}\n`);
    await writable.close();

    const read = await readClient(vault, slug);
    expect(read!.problems.join(' ')).toMatch(/breaks the chain/);
    // The surviving facts are still returned — the point is that the gap is
    // reported, not that the book becomes unreadable.
    expect(read!.dataset.positionValuations.map((v) => v.id)).toEqual(['v1', 'v3']);
  });

  it('continues one chain across separate appends', async () => {
    const { vault, slug } = await bookWith('client-ebg');
    await appendFacts(vault, slug, { positionValuations: [valuation('v1', 100)] });
    await appendFacts(vault, slug, { positionValuations: [valuation('v2', 110)] });
    await appendFacts(vault, slug, { positionValuations: [valuation('v3', 120)] });

    const read = await readClient(vault, slug);
    expect(read!.problems).toEqual([]);
    expect(read!.dataset.positionValuations).toHaveLength(3);
  });
});

describe('a book encrypted with a passphrase', () => {
  const PASSPHRASE = 'correct horse battery staple';

  it('leaves nothing readable on disk but how the key is derived', async () => {
    const { root, vault, slug } = await bookWith('client-ebg', PASSPHRASE);
    await appendFacts(vault, slug, { positionValuations: [valuation('v1', 100)] });

    const manifest = (await readManifest(root))!;
    expect(manifest.encryption?.algorithm).toBe('AES-GCM');
    // The client list is data too — a folder called "ebg" would say who this is.
    expect(manifest.clients).toBeUndefined();
    expect(manifest.clientsSealed).toBeTypeOf('string');
    expect(slug).toMatch(/^[0-9a-f]{16}$/);

    const files = (await summarise(root)).files.map((f) => f.path);
    for (const path of files.filter((f) => f !== 'book.json')) {
      const text = await readRaw(root, path);
      // Distinctive strings only — random base64 hits any three-letter word.
      expect(text).not.toMatch(/Abendrot|Impulse|positionId|GP report|2026Q1/i);
    }
  });

  it('reads back exactly what was written', async () => {
    const { root, vault, slug, cipher } = await bookWith('client-ebg', PASSPHRASE);
    await appendFacts(vault, slug, {
      positionValuations: [valuation('v1', 100), valuation('v2', 110)],
    });
    await storeDocument(vault, slug, doc(), new TextEncoder().encode('workbook bytes'));

    // A fresh unlock, as if the tab had been closed and reopened.
    const manifest = (await readManifest(root))!;
    const reopened = vaultFor(root, await unlock(PASSPHRASE, manifest.encryption!));
    const read = await readClient(reopened, slug);

    expect(read!.problems).toEqual([]);
    expect(read!.dataset.positionValuations.map((v) => v.nav)).toEqual([100, 110]);
    expect(read!.dataset.vehicles.length).toBeGreaterThan(0);
    expect((await readDocuments(reopened, slug))[0].name).toBe('AbIF Q1 2026.xlsx');
    expect(cipher).toBeDefined();
  });

  it('tells a wrong passphrase from a damaged folder', async () => {
    const { root } = await bookWith('client-ebg', PASSPHRASE);
    const manifest = (await readManifest(root))!;
    await expect(unlock('not the passphrase', manifest.encryption!))
      .rejects.toBeInstanceOf(WrongPassphrase);
  });

  it('reports a line that was altered, rather than reading it as something else', async () => {
    const { root, vault, slug } = await bookWith('client-ut', PASSPHRASE);
    await appendFacts(vault, slug, { positionValuations: [valuation('v1', 100)] });

    // One byte of ciphertext flipped. AES-GCM authenticates, so this cannot
    // decrypt to a plausible different number — it cannot decrypt at all.
    const handle = await factFile(root, slug);
    const line = (await (await handle.getFile()).text()).trim();
    const flipped = `${line.slice(0, 20)}${line[20] === 'A' ? 'B' : 'A'}${line.slice(21)}`;
    const writable = await handle.createWritable();
    await writable.write(`${flipped}\n`);
    await writable.close();

    const read = await readClient(vault, slug);
    expect(read!.dataset.positionValuations).toHaveLength(0);
    expect(read!.problems.join(' ')).toMatch(/did not decrypt/);
  });
});

describe('documents are kept with the figures they produced', () => {
  it('stores the file under its hash and indexes the original name', async () => {
    const { root, vault, slug } = await bookWith('client-ebg');

    await storeDocument(vault, slug, doc(), new TextEncoder().encode('workbook bytes'));

    const index = await readDocuments(vault, slug);
    expect(index).toHaveLength(1);
    expect(index[0].name).toBe('AbIF Q1 2026.xlsx');

    const summary = await summarise(root);
    expect(summary.files.map((f) => f.path))
      .toContain(`clients/${slug}/documents/files/a1b2c3.xlsx`);
  });
});

describe('the book behaves like any other repository', () => {
  it('lists clients, loads one, and takes a commit', async () => {
    const { root, manifest, client, vehicles } = await bookWith('client-ebg');
    const book = await openBook(root, manifest, 'Folder — test');

    expect((await book.listClients()).map((c) => c.id)).toEqual([client.id]);

    const empty = await book.loadClient(client.id);
    expect(empty.positions).toHaveLength(0);

    // A workbook row that creates its own holding, which is how a real book
    // starts: nothing exists yet for a name to match against.
    const candidates: Candidate[] = [
      {
        id: 'cand-pos', documentId: 'doc-1', kind: 'position', state: 'accepted', issues: [],
        fields: {
          name: { value: 'Nordic Growth Partners IV', confidence: 1 },
          vehicleId: { value: vehicles[0].id, confidence: 1 },
          currency: { value: 'EUR', confidence: 1 },
          commitment: { value: 5_000, confidence: 1 },
          vintage: { value: 2021, confidence: 1 },
        },
      },
      {
        id: 'cand-val', documentId: 'doc-1', kind: 'position-valuation', state: 'accepted',
        issues: [], dependsOn: 'cand-pos',
        fields: {
          period: { value: '2026Q1', confidence: 1 },
          nav: { value: 4_200, confidence: 1 },
          source: { value: 'AbIF Q1 2026.xlsx', confidence: 1 },
        },
      },
    ];

    const facts = factsFrom(empty, candidates, doc());
    await book.commit(client.id, {
      facts,
      reference: { positions: [...empty.positions, ...facts.positions] },
      document: doc(),
      bytes: new TextEncoder().encode('bytes'),
    });

    const reloaded: DataSet = await book.loadClient(client.id);
    expect(reloaded.positions).toHaveLength(1);
    expect(reloaded.positions[0].name).toBe('Nordic Growth Partners IV');
    expect(reloaded.positionValuations).toHaveLength(1);
    // The valuation found the holding that was created in the same batch.
    expect(reloaded.positionValuations[0].positionId).toBe(reloaded.positions[0].id);
    expect(reloaded.positionValuations[0].nav).toBe(4_200);
  });
});

/** The fact file every test in here pokes at. */
async function factFile(root: FileSystemDirectoryHandle, slug: string) {
  const clients = await root.getDirectoryHandle('clients');
  const facts = await (await clients.getDirectoryHandle(slug)).getDirectoryHandle('facts');
  return facts.getFileHandle('position_valuations.jsonl');
}

/** A file's bytes as text, without going through the vault. */
async function readRaw(root: FileSystemDirectoryHandle, path: string): Promise<string> {
  const segments = path.split('/');
  const name = segments.pop()!;
  let dir = root;
  for (const segment of segments) dir = await dir.getDirectoryHandle(segment);
  return (await (await dir.getFileHandle(name)).getFile()).text();
}
