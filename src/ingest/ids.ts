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

/**
 * An identifier for a fact, derived from the fact itself.
 *
 * A counter is the obvious way to number rows as a reader walks a file, and it
 * is wrong for the same reason a row number is a poor primary key: it depends
 * on everything that came before it. Change what the reader emits — stop
 * turning a negative call into a distribution, say — and every identifier after
 * that row shifts by one. Import the corrected file and the book gains a second
 * copy of the same movement under a new name instead of replacing the first,
 * which is how a fund ends up reporting twice the capital it drew.
 *
 * Derived from what the row says instead, the same row is the same fact
 * whichever version of the reader read it, and re-importing a file replaces
 * what it filed last time. Two genuinely identical movements on one day — a
 * fund can call the same amount from two investors — are told apart by what
 * distinguishes them, so everything that does is passed in.
 */
export function factId(prefix: string, ...parts: Array<string | number | undefined>): string {
  const said = parts.map((part) => (part === undefined ? '' : String(part))).join('|');
  return `${prefix}-${slug(said, 56)}`;
}
