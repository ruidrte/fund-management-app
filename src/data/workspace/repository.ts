/**
 * A repository over a folder on the user's own disk.
 *
 * The same interface the Supabase repository implements, so nothing above the
 * data boundary knows the difference — the engine, the screens and the reports
 * are identical whether the book lives in Postgres or in a folder.
 *
 * What is different, and worth being clear about, is who is responsible for it:
 * a folder has no row-level security and no locking. Encrypting it moves the
 * confidentiality of the data onto a passphrase the user holds rather than onto
 * the account the drive belongs to — but it is still one writer at a time, and
 * anyone who has both the folder and the passphrase has everything.
 */

import type { DataSet } from '../../domain/types';
import type { SourceDocument } from '../../ingest/types';
import type { ClientSummary, Repository } from '../repository';
import type { Cipher } from './crypto';
import {
  appendFacts, clientsIn, readClient, readManifest, replaceReference, storeDocument,
  vaultFor, type BookManifest, type ClientEntry, type FactBatch, type ReferenceUpdate, type Vault,
} from './store';

export interface LocalBook extends Repository {
  readonly vault: Vault;
  readonly manifest: BookManifest;
  readonly clients: ClientEntry[];
  readonly encrypted: boolean;
  /** Lines the last load could not read, per client. Never swallowed. */
  problems(clientId: string): string[];
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

/**
 * Opens a book. The client list is resolved once — for a protected book that
 * means decrypting it — so every later call is a plain lookup.
 */
export async function openBook(
  root: FileSystemDirectoryHandle,
  manifest: BookManifest,
  label: string,
  cipher?: Cipher,
): Promise<LocalBook> {
  const vault = vaultFor(root, cipher);
  const clients = await clientsIn(manifest, cipher);
  const problems = new Map<string, string[]>();

  const slugOf = (clientId: string): string => {
    const entry = clients.find((c) => c.id === clientId);
    if (!entry) throw new Error(`This folder holds no client with id ${clientId}.`);
    return entry.slug;
  };

  return {
    vault,
    manifest,
    clients,
    encrypted: vault.encrypted,
    label,

    async listClients(): Promise<ClientSummary[]> {
      return clients.map((c) => ({ id: c.id, name: c.name, shortName: c.shortName }));
    },

    async loadClient(clientId: string): Promise<DataSet> {
      const slug = slugOf(clientId);
      const read = await readClient(vault, slug);
      if (!read) {
        throw new Error(
          `The folder lists this client in book.json but clients/${slug}/client.json is missing. `
          + 'The folder has been moved or partly deleted.',
        );
      }
      problems.set(clientId, read.problems);
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
        await storeDocument(vault, slug, change.document, change.bytes);
      }
      if (change.reference) {
        await replaceReference(vault, slug, change.reference);
      }
      return change.facts ? appendFacts(vault, slug, change.facts) : {};
    },
  };
}

/** Reads the manifest, so a folder can be inspected before it is unlocked. */
export async function manifestOf(
  root: FileSystemDirectoryHandle,
): Promise<BookManifest | undefined> {
  return readManifest(root);
}
