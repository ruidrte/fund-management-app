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
  // The parts are joined and then slugged, and slugging collapses every run of
  // punctuation into one hyphen — so the joins themselves do not survive. A
  // part that is absent and a part that is present but says nothing a slug can
  // keep ("—", say, as a note) would otherwise both contribute nothing and give
  // one identifier to two facts. Present-and-empty is marked, absent is not:
  // most optional parts are simply absent, and those identifiers stay as they
  // are.
  const said = parts
    .map((part) => {
      if (part === undefined) return '';
      const written = String(part);
      return slug(written, 56) === 'x' && !/[a-z0-9]/i.test(written) ? 'x' : written;
    })
    .join('|');
  return `${prefix}-${slug(said, 56)}`;
}

/**
 * Keeps genuinely identical facts apart, without numbering the rest.
 *
 * A ledger can state the same thing twice and mean it: two calls of the same
 * amount, from the same investor, on the same day, described the same way. They
 * are two facts, and an identity derived from what they say cannot tell them
 * apart — so the second one gets a suffix, and the first is left as it is.
 *
 * This is the only place order still enters an identifier, and it enters it
 * narrowly: deleting one of a pair of identical rows renumbers the other, while
 * everything not duplicated is untouched by anything happening elsewhere in the
 * file. A sequence over every row had the opposite property.
 */
export function distinctly(): (id: string) => string {
  const seen = new Map<string, number>();
  return (id) => {
    const count = (seen.get(id) ?? 0) + 1;
    seen.set(id, count);
    return count === 1 ? id : `${id}-${count}`;
  };
}
