/**
 * Identifiers made from names.
 *
 * A holding, a company or an investor arrives as a name and needs an id. The id
 * has to be readable, and it has to be the same every time the same name is
 * read — importing a workbook twice must replace what it filed rather than file
 * a second copy of it.
 *
 * It also has to be distinct, which is the part that is easy to get wrong. A
 * plain truncation collides exactly where it costs most, because names in a
 * family differ at the end: two funds in the same series differ by a roman
 * numeral, and two share classes of one investor by a suffix in brackets. Both
 * have happened here. The first put two funds' figures on one holding; the
 * second put a founder's capital into a limited partner's account, and the two
 * were only found because a total came out exactly one class too high.
 *
 * So there is one of these, and everything uses it.
 */

/** FNV-1a, 32 bits. Not a security hash: a suffix that makes an id unique. */
function digest(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/**
 * A name as an identifier: lowercased, punctuation turned to hyphens, and — for
 * a name longer than `limit` — a digest of the whole of it appended, so that
 * what was cut off still tells two names apart.
 */
export function slug(value: string, limit = 40): string {
  const full = value.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!full) return 'x';
  if (full.length <= limit) return full;
  return `${full.slice(0, limit).replace(/-+$/, '')}-${digest(full)}`;
}
