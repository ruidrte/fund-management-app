/**
 * Filing accepted candidates, wherever the book happens to live.
 *
 * One place, because the difference between what a screen thinks it filed and
 * what actually reached the disk is the kind of gap nobody notices until a
 * quarter is short. The message this returns is the truth about what happened,
 * including when the answer is "nothing was persisted".
 */

import { useCallback } from 'react';
import { useDataSource } from './DataSourceContext';
import { useScope } from './ScopeContext';
import { factsFrom, type Candidate, type SourceDocument } from '../ingest';

export interface FilingResult {
  /** How many facts were written, or would have been. */
  count: number;
  /** What to tell the person who pressed the button. */
  message: string;
  /** False when the facts went nowhere but memory. */
  persisted: boolean;
}

export function useFiling() {
  const { kind, book, folderName, rescan } = useDataSource();
  const { clientId, dataset, refresh } = useScope();

  const persistent = kind === 'folder' && Boolean(book);

  const file = useCallback(async (
    candidates: Candidate[],
    document: SourceDocument,
    bytes?: Uint8Array,
  ): Promise<FilingResult> => {
    if (!dataset) throw new Error('No client is loaded.');

    const accepted = candidates.filter((c) => c.state === 'accepted');
    const facts = factsFrom(dataset, accepted, document);
    const count = Object.values(facts).reduce((total, rows) => total + rows.length, 0);

    if (book && kind === 'folder') {
      await book.commit(clientId, {
        facts,
        // Holdings are reference data, not facts, so the file is rewritten with
        // the new ones appended rather than a line added to a fact log.
        reference: facts.positions.length > 0
          ? { positions: [...dataset.positions, ...facts.positions] }
          : undefined,
        document: { ...document, status: 'committed' },
        bytes,
      });
      await rescan();
      refresh();
      return {
        count,
        persisted: true,
        message:
          `${count} record(s) written to ${folderName}`
          + (facts.positions.length > 0 ? `, including ${facts.positions.length} new holding(s)` : '')
          + `, and "${document.name}" kept alongside them.`,
      };
    }

    // Nothing else has a write path yet. Saying so is the whole point: a
    // "filed" message over a dataset that resets on reload is how somebody
    // ends up believing a quarter is loaded when it is not.
    refresh();
    return {
      count,
      persisted: false,
      message: kind === 'supabase'
        ? `${count} record(s) validated against "${document.name}". Writing to the database is not built yet, `
          + 'so nothing was inserted.'
        : `${count} record(s) filed against "${document.name}" in the sample dataset, which is not persisted — `
          + 'connect a folder under Storage to keep them.',
    };
  }, [dataset, book, kind, clientId, folderName, rescan, refresh]);

  return { file, persistent };
}
