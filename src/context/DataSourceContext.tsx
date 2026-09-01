/**
 * Where the book of record lives.
 *
 * Three possibilities, in this order of precedence:
 *
 *   Supabase   configured by environment variables. A shared database with
 *              row-level security; the folder is not offered alongside it,
 *              because two books of record is how they diverge.
 *   A folder   chosen by the user, on their own disk. Real data, no server,
 *              no account — and no row-level security either, so it is exactly
 *              as private as the folder is.
 *   Sample     the built-in dataset. Real structure, invented figures.
 *
 * The application above this is identical in all three. What changes is who is
 * responsible for the data, which is why the current source is named in the
 * header rather than left to be inferred.
 */

import {
  createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode,
} from 'react';
import { isSupabaseConfigured } from '../lib/supabase';
import { demoRepository } from '../data/demoRepository';
import { supabaseRepository } from '../data/supabaseRepository';
import type { Repository } from '../data/repository';
import {
  forgetWorkspace, looksLikeRepository, permissionState, pickWorkspace, rememberWorkspace,
  rememberedWorkspace, requestWrite, supportsWorkspaceFolders, whyUnsupported,
} from '../data/workspace/fs';
import {
  createClient as createClientFolder, initialiseBook, summarise, vaultFor,
  type BookManifest, type BookSummary,
} from '../data/workspace/store';
import { unlock, WrongPassphrase, type Cipher } from '../data/workspace/crypto';
import { manifestOf, openBook, type LocalBook } from '../data/workspace/repository';
import { buildClientStructure } from '../data/demo';

export type SourceKind = 'supabase' | 'folder' | 'sample';

export type FolderStatus =
  /** Looking for a folder this browser already knows about. */
  | 'checking'
  /** The browser cannot do this at all. */
  | 'unsupported'
  /** Supported, nothing connected. */
  | 'idle'
  /** A folder is remembered but the grant is not — needs one click. */
  | 'needs-permission'
  /** Connected, but there is no book in it yet. */
  | 'empty'
  /** A protected book, waiting for its passphrase. */
  | 'locked'
  /** Connected and readable. */
  | 'open'
  | 'error';

interface DataSourceValue {
  kind: SourceKind;
  repository: Repository;

  folderStatus: FolderStatus;
  folderName?: string;
  folderError?: string;
  /** Something worth saying about the folder that is not an error. */
  folderWarning?: string;
  /** Why folders are unavailable in this browser, when they are. */
  unsupportedReason?: string;

  /** The open book, when a folder is the source. */
  book?: LocalBook;
  summary?: BookSummary;
  /** True while a protected book is waiting for its passphrase. */
  locked: boolean;

  connect(): Promise<void>;
  reconnect(): Promise<void>;
  disconnect(): Promise<void>;
  /** Opens a protected book. The passphrase is held in memory and never stored. */
  unlockWith(passphrase: string): Promise<void>;
  /**
   * Starts a book for one of the known clients in the connected folder. A
   * passphrase, given the first time, protects the book from the first byte.
   */
  startBook(clientId: string, passphrase?: string): Promise<void>;
  /** Re-reads the folder listing after something was written. */
  rescan(): Promise<void>;
}

const DataSourceContext = createContext<DataSourceValue | undefined>(undefined);

export function DataSourceProvider({ children }: { children: ReactNode }) {
  const backend = isSupabaseConfigured();

  const [status, setStatus] = useState<FolderStatus>(backend ? 'idle' : 'checking');
  const [handle, setHandle] = useState<FileSystemDirectoryHandle>();
  const [book, setBook] = useState<LocalBook>();
  const [summary, setSummary] = useState<BookSummary>();
  const [folderError, setFolderError] = useState<string>();
  const [folderWarning, setFolderWarning] = useState<string>();
  // The key lives here and nowhere else: not in localStorage, not in the
  // handle store, not on disk. Closing the tab forgets it, which is the
  // property that makes a protected folder worth protecting.
  const [cipher, setCipher] = useState<Cipher>();
  const [sealed, setSealed] = useState<BookManifest>();

  /** Reads the manifest and opens the book, or reports what is in the way. */
  const adopt = useCallback(async (
    directory: FileSystemDirectoryHandle, key?: Cipher,
  ) => {
    setFolderError(undefined);
    const manifest = await manifestOf(directory);
    setHandle(directory);
    setSummary(await summarise(directory));

    if (!manifest) {
      setBook(undefined);
      setSealed(undefined);
      setStatus('empty');
      return;
    }

    if (manifest.encryption && !key) {
      setBook(undefined);
      setSealed(manifest);
      setStatus('locked');
      return;
    }

    setSealed(manifest);
    setCipher(key);
    setBook(await openBook(directory, manifest, `Folder — ${directory.name}`, key));
    setStatus('open');
  }, []);

  useEffect(() => {
    if (backend) return;
    if (!supportsWorkspaceFolders()) {
      setStatus('unsupported');
      return;
    }
    let cancelled = false;
    (async () => {
      const remembered = await rememberedWorkspace();
      if (cancelled) return;
      if (!remembered) {
        setStatus('idle');
        return;
      }
      const state = await permissionState(remembered);
      if (cancelled) return;
      if (state !== 'granted') {
        // The handle survives a reload; the grant does not. Asking again needs
        // a click, so the folder is shown as remembered rather than opened.
        setHandle(remembered);
        setStatus('needs-permission');
        return;
      }
      try {
        await adopt(remembered);
      } catch (cause) {
        if (!cancelled) {
          setFolderError(describe(cause));
          setStatus('error');
        }
      }
    })();
    return () => { cancelled = true; };
  }, [backend, adopt]);

  const connect = useCallback(async () => {
    try {
      const picked = await pickWorkspace();
      if (!picked) return;
      if (await requestWrite(picked) !== 'granted') {
        setFolderError('Write permission was not granted, so the folder cannot hold a book.');
        setStatus('error');
        return;
      }
      await rememberWorkspace(picked);
      setFolderWarning(await looksLikeRepository(picked)
        ? `${picked.name} looks like a source repository. A book kept inside a working copy is one `
          + '"git add ." away from being pushed — put it somewhere else.'
        : undefined);
      await adopt(picked);
    } catch (cause) {
      setFolderError(describe(cause));
      setStatus('error');
    }
  }, [adopt]);

  const reconnect = useCallback(async () => {
    if (!handle) return;
    try {
      if (await requestWrite(handle) !== 'granted') {
        setFolderError('Permission was declined. The folder stays remembered; nothing was read.');
        return;
      }
      await adopt(handle);
    } catch (cause) {
      setFolderError(describe(cause));
      setStatus('error');
    }
  }, [handle, adopt]);

  const disconnect = useCallback(async () => {
    await forgetWorkspace();
    setHandle(undefined);
    setBook(undefined);
    setSummary(undefined);
    setFolderError(undefined);
    setCipher(undefined);
    setSealed(undefined);
    setStatus(supportsWorkspaceFolders() ? 'idle' : 'unsupported');
  }, []);

  const unlockWith = useCallback(async (passphrase: string) => {
    if (!handle || !sealed?.encryption) return;
    try {
      await adopt(handle, await unlock(passphrase, sealed.encryption));
    } catch (cause) {
      // A wrong passphrase is a typo, not a broken folder, and the difference
      // is worth saying — otherwise the first reaction is to look for a backup.
      setFolderError(cause instanceof WrongPassphrase ? cause.message : describe(cause));
    }
  }, [handle, sealed, adopt]);

  const startBook = useCallback(async (clientId: string, passphrase?: string) => {
    if (!handle) throw new Error('No folder is connected.');
    const { client, vehicles } = buildClientStructure(clientId);

    let key = cipher;
    if (!await manifestOf(handle)) {
      const started = await initialiseBook(handle, passphrase || undefined);
      key = started.cipher;
    }
    await createClientFolder(vaultFor(handle, key), client, vehicles, key);
    await adopt(handle, key);
  }, [handle, cipher, adopt]);

  const rescan = useCallback(async () => {
    if (!handle) return;
    setSummary(await summarise(handle));
  }, [handle]);

  const kind: SourceKind = backend ? 'supabase' : book ? 'folder' : 'sample';

  const value = useMemo<DataSourceValue>(() => ({
    kind,
    repository: backend ? supabaseRepository : book ?? demoRepository,
    folderStatus: status,
    locked: status === 'locked',
    folderName: handle?.name,
    folderError,
    folderWarning,
    unsupportedReason: status === 'unsupported' ? whyUnsupported() : undefined,
    book,
    summary,
    connect,
    reconnect,
    disconnect,
    unlockWith,
    startBook,
    rescan,
  }), [
    kind, backend, book, status, handle, folderError, folderWarning, summary,
    connect, reconnect, disconnect, unlockWith, startBook, rescan,
  ]);

  return <DataSourceContext.Provider value={value}>{children}</DataSourceContext.Provider>;
}

export function useDataSource(): DataSourceValue {
  const value = useContext(DataSourceContext);
  if (!value) throw new Error('useDataSource must be used inside a DataSourceProvider');
  return value;
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
