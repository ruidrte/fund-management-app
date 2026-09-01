/**
 * A repository over a folder on the user's own disk.
 *
 * The same interface the Supabase repository implements, so nothing above the
 * data boundary knows the difference — the engine, the screens and the reports
 * are identical whether the book lives in Postgres or in a synced folder.
 *
 * What is different, and worth being clear about, is who is responsible for it:
 * a folder has no row-level security, no audit trail beyond the file dates, and
 * no locking. It is exactly as private as the folder is, and one writer at a
 * time.
 */

import type { DataSet } from '../../domain/types';
import type { SourceDocument } from '../../ingest/types';
import type { ClientSummary, Repository } from '../repository';
import {
  appendFacts, readClient, readManifest, replaceReference, storeDocument,
  type BookManifest, type FactBatch, type ReferenceUpdate,
} from './store';

export interface LocalBook extends Repository {
  readonly root: FileSystemDirectoryHandle;
  readonly manifest: BookManifest;
  /** Lines skipped as unreadable on the last load, per client. */
  problems(clientId: string): string[];
  /** Files a load could not parse are surfaced, never swallowed. */
  commit(clientId: string, change: BookChange): Promise<Record<string, number>>;
}

export interface BookChange {
  facts?: FactBatch;
  reference?: ReferenceUpdate;
  /** The document the facts were read from, recorded alongside them. */
  document?: SourceDocument;
  /** The document's own bytes, kept so the figures can be traced to the file. */
  bytes?: Uint8Array;
}

export function openBook(
  root: FileSystemDirectoryHandle, manifest: BookManifest, label: string,
): LocalBook {
  const problems = new Map<string, string[]>();

  const slugOf = (clientId: string): string => {
    const entry = manifest.clients.find((c) => c.id === clientId);
    if (!entry) throw new Error(`This folder holds no client with id ${clientId}.`);
    return entry.slug;
  };

  return {
    root,
    manifest,
    label,

    async listClients(): Promise<ClientSummary[]> {
      return manifest.clients.map((c) => ({ id: c.id, name: c.name, shortName: c.shortName }));
    },

    async loadClient(clientId: string): Promise<DataSet> {
      const slug = slugOf(clientId);
      const read = await readClient(root, slug);
      if (!read) {
        throw new Error(
          `The folder lists ${clientId} in book.json but clients/${slug}/client.json is missing. `
          + 'The folder has been moved or partly deleted.',
        );
      }
      problems.set(clientId, read.skipped);
      return read.dataset;
    },

    problems(clientId: string): string[] {
      return problems.get(clientId) ?? [];
    },

    async commit(clientId: string, change: BookChange): Promise<Record<string, number>> {
      const slug = slugOf(clientId);
      // The document goes down first. If the write of the facts then fails, the
      // folder holds a file nobody used, which is inert; the other order would
      // leave figures whose source is not there.
      if (change.document) {
        await storeDocument(root, slug, change.document, change.bytes);
      }
      if (change.reference) {
        await replaceReference(root, slug, change.reference);
      }
      return change.facts ? appendFacts(root, slug, change.facts) : {};
    },
  };
}

/** Reads the manifest, so a folder can be opened before anything is committed. */
export async function manifestOf(
  root: FileSystemDirectoryHandle,
): Promise<BookManifest | undefined> {
  return readManifest(root);
}
