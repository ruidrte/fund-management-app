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
  appendFacts, createClient, readClient, readDocuments, readManifest, slugFor,
  storeDocument, summarise, writeManifest,
} from '../src/data/workspace/store';
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
    const root = memoryDirectory();
    const { client, vehicles } = buildClientStructure('client-ebg');
    const manifest = await createClient(root, client, vehicles);

    expect(manifest.clients).toHaveLength(1);
    expect(manifest.clients[0].id).toBe(client.id);

    const read = await readClient(root, manifest.clients[0].slug);
    expect(read!.dataset.vehicles.map((v) => v.shortName)).toEqual(vehicles.map((v) => v.shortName));
    // A new book has the real structure and not one figure.
    expect(read!.dataset.positions).toHaveLength(0);
    expect(read!.dataset.positionValuations).toHaveLength(0);
  });

  it('refuses to add the same client twice', async () => {
    const root = memoryDirectory();
    const { client, vehicles } = buildClientStructure('client-pam');
    await createClient(root, client, vehicles);
    await expect(createClient(root, client, vehicles)).rejects.toThrow(/already in this folder/);
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
    const root = memoryDirectory();
    const { client, vehicles } = buildClientStructure('client-ebg');
    const manifest = await createClient(root, client, vehicles);
    const slug = manifest.clients[0].slug;

    await appendFacts(root, slug, { positionValuations: [valuation('v1', 100)] });
    await appendFacts(root, slug, { positionValuations: [valuation('v2', 110)] });

    const read = await readClient(root, slug);
    expect(read!.dataset.positionValuations.map((v) => v.id)).toEqual(['v1', 'v2']);
    // The restatement sits alongside the original rather than replacing it,
    // which is what lets the first quarter still be reproduced as published.
    expect(read!.dataset.positionValuations.map((v) => v.nav)).toEqual([100, 110]);
  });

  it('skips a line it cannot read, reports it, and keeps the rest', async () => {
    const root = memoryDirectory();
    const { client, vehicles } = buildClientStructure('client-ut');
    const manifest = await createClient(root, client, vehicles);
    const slug = manifest.clients[0].slug;

    await appendFacts(root, slug, { positionValuations: [valuation('v1', 100)] });
    // As if somebody had edited the file by hand and broken a line.
    const facts = await root.getDirectoryHandle('clients');
    const dir = await (await facts.getDirectoryHandle(slug)).getDirectoryHandle('facts');
    const handle = await dir.getFileHandle('position_valuations.jsonl');
    const existing = await (await handle.getFile()).text();
    const writable = await handle.createWritable();
    await writable.write(`${existing}{"broken":\n`);
    await writable.close();

    const read = await readClient(root, slug);
    expect(read!.dataset.positionValuations).toHaveLength(1);
    expect(read!.skipped.join(' ')).toMatch(/position_valuations.jsonl line 2/);
  });
});

describe('documents are kept with the figures they produced', () => {
  it('stores the file under its hash and indexes the original name', async () => {
    const root = memoryDirectory();
    const { client, vehicles } = buildClientStructure('client-ebg');
    const manifest = await createClient(root, client, vehicles);
    const slug = manifest.clients[0].slug;

    await storeDocument(root, slug, doc(), new TextEncoder().encode('workbook bytes'));

    const index = await readDocuments(root, slug);
    expect(index).toHaveLength(1);
    expect(index[0].name).toBe('AbIF Q1 2026.xlsx');

    const summary = await summarise(root);
    expect(summary.files.map((f) => f.path))
      .toContain(`clients/${slug}/documents/files/a1b2c3.xlsx`);
  });
});

describe('the book behaves like any other repository', () => {
  it('lists clients, loads one, and takes a commit', async () => {
    const root = memoryDirectory();
    const { client, vehicles } = buildClientStructure('client-ebg');
    const manifest = await createClient(root, client, vehicles);
    const book = openBook(root, manifest, 'Folder — test');

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
