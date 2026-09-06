/**
 * The houses' own marks, read from the folder.
 *
 * What is pinned is that a mark is optional, that the page renders it directly
 * rather than asking anybody for it, and that a file which is not a mark — too
 * large, or an extension the browser will not render — is passed over rather
 * than turned into a broken image where a client's identity should be.
 */

import { describe, expect, it } from 'vitest';
import { brandFor, BRAND_FOLDER } from '../src/data/workspace/brand';

/** A folder handle, as much of one as the reader actually uses. */
function folder(files: Record<string, Uint8Array>): FileSystemDirectoryHandle {
  const directories = new Map<string, Map<string, Uint8Array>>();
  for (const [path, bytes] of Object.entries(files)) {
    const [dir, name] = path.split('/');
    if (!directories.has(dir)) directories.set(dir, new Map());
    directories.get(dir)!.set(name, bytes);
  }

  const fileHandle = (bytes: Uint8Array) => ({
    kind: 'file' as const,
    getFile: async () => ({
      arrayBuffer: async () => bytes.buffer.slice(
        bytes.byteOffset, bytes.byteOffset + bytes.byteLength,
      ),
    }),
  });

  return {
    kind: 'directory',
    async getDirectoryHandle(name: string) {
      const held = directories.get(name);
      if (!held) throw new Error('NotFoundError');
      return {
        kind: 'directory',
        async getFileHandle(file: string) {
          const bytes = held.get(file);
          if (!bytes) throw new Error('NotFoundError');
          return fileHandle(bytes);
        },
      };
    },
  } as unknown as FileSystemDirectoryHandle;
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);

describe('reading a mark out of the folder', () => {
  it('renders it inline, so the page asks nobody for it', async () => {
    const mark = await brandFor(folder({ [`${BRAND_FOLDER}/pam.png`]: PNG }), 'pam');
    expect(mark).toBe(`data:image/png;base64,${Buffer.from(PNG).toString('base64')}`);
  });

  it('takes whichever kind of file the house happens to have', async () => {
    const svg = new TextEncoder().encode('<svg/>');
    const mark = await brandFor(folder({ [`${BRAND_FOLDER}/ebg.svg`]: svg }), 'ebg');
    expect(mark?.startsWith('data:image/svg+xml;base64,')).toBe(true);
  });

  it('has none for a house whose folder holds none', async () => {
    // The ordinary case. The house's colour stands on its own and nothing is
    // invented in its place.
    expect(await brandFor(folder({ [`${BRAND_FOLDER}/pam.png`]: PNG }), 'ut')).toBeUndefined();
    expect(await brandFor(folder({}), 'pam')).toBeUndefined();
  });

  it('passes over a file too large to be a mark', async () => {
    const huge = new Uint8Array(600 * 1024);
    expect(await brandFor(folder({ [`${BRAND_FOLDER}/pam.png`]: huge }), 'pam')).toBeUndefined();
  });

  it('passes over an empty file rather than rendering nothing at all', async () => {
    expect(await brandFor(folder({ [`${BRAND_FOLDER}/pam.png`]: new Uint8Array() }), 'pam'))
      .toBeUndefined();
  });

  it('encodes a mark larger than an argument list', async () => {
    // `btoa(String.fromCharCode(...bytes))` throws above about sixty kilobytes,
    // which a logo comfortably is.
    const big = new Uint8Array(120 * 1024).fill(0x41);
    const mark = await brandFor(folder({ [`${BRAND_FOLDER}/pam.png`]: big }), 'pam');
    expect(mark).toBeDefined();
    expect(mark!.length).toBeGreaterThan(150_000);
  });
});
