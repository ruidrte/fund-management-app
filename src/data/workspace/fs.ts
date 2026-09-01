/**
 * The browser's file-system access, wrapped.
 *
 * Chromium browsers let a page hold a handle to a folder the user picked, read
 * and write inside it, and — with the handle kept in IndexedDB — reconnect to
 * the same folder after a reload. That is enough to keep a real book of record
 * on the user's own disk, in files they can open, back up and hand to somebody
 * else, with no server anywhere.
 *
 * Two properties of the API are load-bearing here:
 *
 *  - The page can only ever reach the one folder the user chose. There is no
 *    path traversal out of it and no way to ask for another without a fresh
 *    prompt the user has to answer.
 *  - Permission is not permanent. After a reload the handle is remembered but
 *    the grant is not, so writing again needs a click. That is a feature — it
 *    means a tab left open overnight cannot quietly rewrite the folder — but it
 *    has to be handled explicitly rather than looking like a failure.
 *
 * Firefox and Safari do not implement it. Nothing here is polyfilled: a
 * half-working folder that silently drops writes would be far worse than an
 * honest refusal.
 */

/* The DOM lib types the handles but not the picker or the permission calls. */
interface PermissionCapableHandle extends FileSystemHandle {
  queryPermission?(descriptor: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
  requestPermission?(descriptor: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
}

interface PickerWindow {
  showDirectoryPicker?(options?: {
    id?: string;
    mode?: 'read' | 'readwrite';
    startIn?: string;
  }): Promise<FileSystemDirectoryHandle>;
}

export function supportsWorkspaceFolders(): boolean {
  if (typeof window === 'undefined') return false;
  if (typeof (window as unknown as PickerWindow).showDirectoryPicker !== 'function') return false;
  // The picker exists in a frame and in an insecure context, and throws when
  // called. Checking here means the button is never offered where pressing it
  // can only fail — a review build embedded in a page is exactly that case.
  if (!window.isSecureContext) return false;
  return window.top === window.self;
}

/**
 * Why folders are unavailable, phrased for the person reading it rather than
 * for a bug report.
 */
export function whyUnsupported(): string {
  if (typeof window === 'undefined') return 'No browser environment.';
  if (!window.isSecureContext) {
    return 'The page is not in a secure context. Folder access needs https, or localhost — '
      + 'a build opened straight from disk with file:// cannot ask for a folder.';
  }
  if (window.top !== window.self) {
    return 'The page is running inside a frame, which is not allowed to open a folder picker. '
      + 'Open it in its own tab.';
  }
  return 'This browser does not implement the File System Access API. '
    + 'Chrome and Edge do; Firefox and Safari do not.';
}

/** Asks the user for a folder. Undefined when they cancel. */
export async function pickWorkspace(): Promise<FileSystemDirectoryHandle | undefined> {
  const picker = (window as unknown as PickerWindow).showDirectoryPicker;
  if (!picker) throw new Error(whyUnsupported());
  try {
    // `id` makes the browser reopen where it was last time, which matters when
    // the folder is several levels into a synced drive.
    return await picker({ id: 'fund-book', mode: 'readwrite' });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') return undefined;
    throw cause;
  }
}

export type PermissionOutcome = 'granted' | 'prompt' | 'denied';

export async function permissionState(
  handle: FileSystemDirectoryHandle,
): Promise<PermissionOutcome> {
  const query = (handle as PermissionCapableHandle).queryPermission;
  if (!query) return 'granted';
  const state = await query.call(handle, { mode: 'readwrite' });
  return state === 'granted' ? 'granted' : state === 'denied' ? 'denied' : 'prompt';
}

/**
 * Asks for write permission. Must be called from a user gesture — the browser
 * refuses otherwise, and the refusal looks like a denial.
 */
export async function requestWrite(
  handle: FileSystemDirectoryHandle,
): Promise<PermissionOutcome> {
  const current = await permissionState(handle);
  if (current === 'granted') return 'granted';
  const request = (handle as PermissionCapableHandle).requestPermission;
  if (!request) return 'granted';
  const state = await request.call(handle, { mode: 'readwrite' });
  return state === 'granted' ? 'granted' : 'denied';
}

/* ------------------------------------------------------------------ *
 * Remembering the folder across reloads
 *
 * A directory handle survives structured cloning, so IndexedDB can hold it.
 * localStorage cannot — it only stores strings — which is the whole reason for
 * the few lines of IndexedDB below.
 * ------------------------------------------------------------------ */

const DB_NAME = 'fund-workspace';
const STORE = 'handles';
const KEY = 'current';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not open the handle store'));
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = action(db.transaction(STORE, mode).objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('Handle store failed'));
    });
  } finally {
    db.close();
  }
}

export async function rememberWorkspace(handle: FileSystemDirectoryHandle): Promise<void> {
  await withStore('readwrite', (store) => store.put(handle, KEY) as IDBRequest<unknown>);
}

export async function rememberedWorkspace(): Promise<FileSystemDirectoryHandle | undefined> {
  if (!supportsWorkspaceFolders()) return undefined;
  try {
    const handle = await withStore<FileSystemDirectoryHandle | undefined>(
      'readonly', (store) => store.get(KEY),
    );
    return handle ?? undefined;
  } catch {
    // A private window, or storage cleared. Not being able to remember is not
    // an error worth stopping for; the user picks the folder again.
    return undefined;
  }
}

export async function forgetWorkspace(): Promise<void> {
  try {
    await withStore('readwrite', (store) => store.delete(KEY) as IDBRequest<unknown>);
  } catch {
    // Nothing to forget.
  }
}

/* ------------------------------------------------------------------ *
 * Files
 *
 * Paths are given as "a/b/c.json" and resolved segment by segment. Directories
 * are created on write and never on read, so a missing file reads as absent
 * rather than quietly creating an empty one.
 * ------------------------------------------------------------------ */

async function resolveDir(
  root: FileSystemDirectoryHandle, segments: string[], create: boolean,
): Promise<FileSystemDirectoryHandle | undefined> {
  let dir = root;
  for (const segment of segments) {
    try {
      dir = await dir.getDirectoryHandle(segment, { create });
    } catch {
      return undefined;
    }
  }
  return dir;
}

async function fileHandle(
  root: FileSystemDirectoryHandle, path: string, create: boolean,
): Promise<FileSystemFileHandle | undefined> {
  const segments = path.split('/').filter(Boolean);
  const name = segments.pop();
  if (!name) return undefined;
  const dir = await resolveDir(root, segments, create);
  if (!dir) return undefined;
  try {
    return await dir.getFileHandle(name, { create });
  } catch {
    return undefined;
  }
}

export async function readText(
  root: FileSystemDirectoryHandle, path: string,
): Promise<string | undefined> {
  const handle = await fileHandle(root, path, false);
  if (!handle) return undefined;
  return (await handle.getFile()).text();
}

export async function readBytes(
  root: FileSystemDirectoryHandle, path: string,
): Promise<Uint8Array | undefined> {
  const handle = await fileHandle(root, path, false);
  if (!handle) return undefined;
  return new Uint8Array(await (await handle.getFile()).arrayBuffer());
}

export async function writeFile(
  root: FileSystemDirectoryHandle, path: string, data: string | Uint8Array,
): Promise<void> {
  const handle = await fileHandle(root, path, true);
  if (!handle) throw new Error(`Could not create ${path} in the folder.`);
  const stream = await handle.createWritable();
  // A writable stream replaces the file only when it closes, so a crash
  // mid-write leaves the previous version intact rather than a truncated one.
  await stream.write(data as FileSystemWriteChunkType);
  await stream.close();
}

/**
 * Appends a line to a file, creating it if needed.
 *
 * Facts are append-only, and appending is also what keeps a synced folder
 * cheap: OneDrive uploads the change, not a rewritten history.
 */
export async function appendLines(
  root: FileSystemDirectoryHandle, path: string, lines: string[],
): Promise<void> {
  if (lines.length === 0) return;
  const handle = await fileHandle(root, path, true);
  if (!handle) throw new Error(`Could not create ${path} in the folder.`);
  const existing = await handle.getFile();
  const stream = await handle.createWritable({ keepExistingData: true });
  await stream.seek(existing.size);
  await stream.write(`${lines.join('\n')}\n`);
  await stream.close();
}

export interface FileSummary {
  path: string;
  bytes: number;
  modified: number;
}

/** Every file under a folder, for showing the user what is actually on disk. */
export async function listFiles(
  root: FileSystemDirectoryHandle, prefix = '',
): Promise<FileSummary[]> {
  const entries: FileSummary[] = [];
  const iterable = root as unknown as AsyncIterable<[string, FileSystemHandle]>;
  for await (const [name, handle] of iterable) {
    const path = prefix ? `${prefix}/${name}` : name;
    if (handle.kind === 'directory') {
      entries.push(...await listFiles(handle as FileSystemDirectoryHandle, path));
    } else {
      const file = await (handle as FileSystemFileHandle).getFile();
      entries.push({ path, bytes: file.size, modified: file.lastModified });
    }
  }
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

/** True when the folder holds nothing at all. */
export async function isEmpty(root: FileSystemDirectoryHandle): Promise<boolean> {
  const iterable = root as unknown as AsyncIterable<[string, FileSystemHandle]>;
  for await (const _entry of iterable) return false;
  return true;
}
