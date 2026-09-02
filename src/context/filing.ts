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
import { factsFrom, type Candidate, type ImportPlan, type SourceDocument } from '../ingest';
import { NO_PROFILE, type ReportingProfile } from '../domain/report';
import { DEFAULT_CONVENTIONS, type ReportingConventions } from '../domain/types';

export interface FilingResult {
  /** How many facts were written, or would have been. */
  count: number;
  /** What to tell the person who pressed the button. */
  message: string;
  /** False when the facts went nowhere but memory. */
  persisted: boolean;
}

/**
 * Saving a client's reporting profile.
 *
 * Layouts and branding belong to the client, so they live in the client's book
 * beside the figures — a new client is a new profile rather than a new build.
 * There is nowhere to put them without a book, and the interface says so rather
 * than accepting an edit that will not survive the reload.
 */
export function useReportingProfile() {
  const { kind, book, folderName } = useDataSource();
  const { clientId, dataset, refresh } = useScope();

  const profile = dataset?.reporting ?? NO_PROFILE;
  const canSave = kind === 'folder' && Boolean(book);

  const save = useCallback(async (next: ReportingProfile) => {
    if (!book || kind !== 'folder') {
      throw new Error(
        kind === 'supabase'
          ? 'Writing to the database is not built yet, so a profile cannot be saved.'
          : 'The sample dataset is not persisted. Connect a folder under Storage to keep a profile.',
      );
    }
    await book.commit(clientId, { reference: { reporting: next } });
    refresh();
  }, [book, kind, clientId, refresh]);

  return {
    profile,
    save,
    canSave,
    destination: folderName,
    reason: canSave ? undefined : kind === 'supabase'
      ? 'Writing to the database is not built yet.'
      : 'Nothing is persisted in the sample dataset — connect a folder under Storage.',
  };
}

/**
 * Filing a whole book at once.
 *
 * A portfolio database is a migration rather than a document: thousands of rows
 * that belong together and are worth nothing apart. So it commits as one write
 * — reference data replaced, facts appended, the workbook itself kept beside
 * them — instead of passing through a review list built for a dozen candidates.
 */
export function useImport() {
  const { kind, book, folderName, rescan } = useDataSource();
  const { clientId, dataset, refresh } = useScope();

  const canImport = kind === 'folder' && Boolean(book);

  const apply = useCallback(async (
    plan: ImportPlan, document: SourceDocument, bytes?: Uint8Array,
  ): Promise<string> => {
    if (!dataset) throw new Error('No client is loaded.');
    if (!book || kind !== 'folder') {
      throw new Error(
        kind === 'supabase'
          ? 'Writing to the database is not built yet, so a book cannot be imported.'
          : 'The sample dataset is not persisted. Connect a folder under Storage to import into it.',
      );
    }

    // Reference data is replaced rather than appended: importing the same
    // programme twice should leave one set of holdings, not two.
    const keep = <T extends { id: string; vehicleId?: string; positionId?: string }>(
      existing: T[], incoming: T[],
    ): T[] => {
      const replaced = new Set(incoming.map((row) => row.id));
      return [...existing.filter((row) => !replaced.has(row.id)), ...incoming];
    };

    await book.commit(clientId, {
      reference: {
        positions: keep(dataset.positions, plan.positions),
        assets: keep(dataset.assets, plan.assets),
        investors: keep(dataset.investors, plan.investors),
      },
      facts: {
        positionValuations: plan.valuations,
        assetValuations: plan.assetValuations,
        cashflows: plan.cashflows,
        fxRates: plan.fxRates,
      },
      document: { ...document, status: 'committed' },
      bytes,
    });

    await rescan();
    refresh();

    const counts = [
      `${plan.positions.length} holding(s)`,
      `${plan.valuations.length} valuation(s)`,
      `${plan.cashflows.length} cashflow(s)`,
      plan.assets.length > 0 ? `${plan.assets.length} company(ies)` : '',
      plan.assetValuations.length > 0 ? `${plan.assetValuations.length} company valuation(s)` : '',
      plan.fxRates.length > 0 ? `${plan.fxRates.length} rate(s)` : '',
    ].filter(Boolean);

    return `${plan.program} written to ${folderName}: ${counts.join(', ')}.`;
  }, [dataset, book, kind, clientId, folderName, rescan, refresh]);

  return { apply, canImport, destination: folderName };
}

/**
 * The house conventions, saved with the client they belong to.
 *
 * These are not preferences. Whether a holding that has not reported is
 * carried flat or marked with the cohort's value change moved one real
 * quarter's net asset value by six thousand euros — a rounding error on a
 * hundred and twenty million, and still a number somebody would have to
 * explain. A house that carries flat should be able to say so without a
 * rebuild.
 */
export function useConventions() {
  const { kind, book, folderName } = useDataSource();
  const { clientId, dataset, refresh } = useScope();

  const conventions = dataset?.client.conventions ?? DEFAULT_CONVENTIONS;
  const canSave = kind === 'folder' && Boolean(book);

  const save = useCallback(async (next: ReportingConventions) => {
    if (!dataset) throw new Error('No client is loaded.');
    if (!book || kind !== 'folder') {
      throw new Error(
        kind === 'supabase'
          ? 'Writing to the database is not built yet, so conventions cannot be saved.'
          : 'The sample dataset is not persisted. Connect a folder under Storage to keep them.',
      );
    }
    await book.commit(clientId, {
      reference: { client: { ...dataset.client, conventions: next } },
    });
    refresh();
  }, [book, kind, clientId, dataset, refresh]);

  return {
    conventions,
    save,
    canSave,
    destination: folderName,
    reason: canSave ? undefined : kind === 'supabase'
      ? 'Writing to the database is not built yet.'
      : 'Nothing is persisted in the sample dataset — connect a folder under Storage.',
  };
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
