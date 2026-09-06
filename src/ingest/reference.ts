/**
 * Which reference records an import supersedes.
 *
 * Holdings, companies and investors are reference data: the file that holds
 * them is rewritten whole on every import rather than appended to, so that
 * importing the same programme twice leaves one set of holdings and not two.
 *
 * Replacing only the records whose identifier collides was not enough, and the
 * gap is the same one that let a fund report twice the capital it drew. A
 * reader that changes how it names things — as the mandate reader did when it
 * stopped taking a holding's identity from a column heading — files the same
 * investor under a new identifier. Nothing collides with the old record, so it
 * stays, and the book holds two Pensionskasse Thurgaus with one commitment
 * counted twice between them.
 *
 * A record is therefore superseded when the import restates the group it
 * belongs to, whatever it is called. The group is only cleared when the import
 * actually speaks about it: an allocation workbook files companies against
 * holdings it never read and says nothing about the holdings themselves, so it
 * must not delete them by silence.
 */

/**
 * The records to keep, given what the import brought.
 *
 * `owner` names the group a record belongs to — the vehicle for a holding or
 * an investor, the holding for a company. Groups the import said nothing about
 * are left exactly as they were.
 */
export function supersede<T extends { id: string }>(
  existing: T[], incoming: T[], owner: (row: T) => string,
): T[] {
  const replaced = new Set(incoming.map((row) => row.id));
  const restated = new Set(incoming.map(owner));
  return [
    ...existing.filter((row) => !replaced.has(row.id) && !restated.has(owner(row))),
    ...incoming,
  ];
}
