/**
 * The houses' own marks, read from the folder rather than shipped with the
 * application.
 *
 * A logo is a registered brand and belongs to the house, not to this software.
 * Committing three of them into a repository puts somebody else's asset under
 * this project's licence and freezes it at whatever version was current the day
 * it was added; drawing an approximation instead is worse, because a mark that
 * is nearly right is wrong everywhere and nobody notices until a client does.
 *
 * So they live where the data lives. Drop `brand/pam.svg` — or `.png`, or the
 * client's own slug — into the book folder and the application picks it up. The
 * file never leaves the folder: it is read into the page as bytes, and the page
 * makes no request to anybody for it.
 */

import { readBytes } from './fs';

/** What a browser will render inline, by the extension the file carries. */
const TYPES: Record<string, string> = {
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};

/**
 * A mark large enough to be a photograph is not a logo, and turning one into a
 * data URI puts the whole of it in the page's memory for every render.
 */
const LARGEST = 512 * 1024;

export const BRAND_FOLDER = 'brand';

/**
 * The mark for one client, as something an `img` can render directly.
 *
 * Undefined where the folder has none, which is the normal case: the house's
 * colour stands on its own and nothing is invented in its place.
 */
export async function brandFor(
  root: FileSystemDirectoryHandle, slug: string,
): Promise<string | undefined> {
  for (const [extension, type] of Object.entries(TYPES)) {
    let bytes: Uint8Array | undefined;
    try {
      bytes = await readBytes(root, `${BRAND_FOLDER}/${slug}.${extension}`);
    } catch {
      // A folder the browser will not read is not an error worth stopping for.
      // The mark is decoration; the figures are not.
      continue;
    }
    if (!bytes || bytes.length === 0 || bytes.length > LARGEST) continue;
    return `data:${type};base64,${base64(bytes)}`;
  }
  return undefined;
}

/**
 * Base64 without going through a string of every byte at once.
 *
 * `btoa(String.fromCharCode(...bytes))` blows the argument limit on anything
 * over about sixty kilobytes, which a logo comfortably is.
 */
function base64(bytes: Uint8Array): string {
  let binary = '';
  const size = 8192;
  for (let i = 0; i < bytes.length; i += size) {
    binary += String.fromCharCode(...bytes.subarray(i, i + size));
  }
  return btoa(binary);
}
