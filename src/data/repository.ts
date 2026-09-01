/**
 * The data boundary.
 *
 * Everything above this line works on a `DataSet` and knows nothing about where
 * it came from. That is what lets the whole application — engine, dashboards and
 * reports alike — run against the demo dataset with no backend, and against
 * Supabase with no code change.
 */

import type { DataSet } from '../domain/types';

export interface ClientSummary {
  id: string;
  name: string;
  shortName: string;
}

export interface Repository {
  /** Clients the signed-in user may see. */
  listClients(): Promise<ClientSummary[]>;
  /** Everything for one client. Scoping below this happens in the engine. */
  loadClient(clientId: string): Promise<DataSet>;
  /** A label for the source, shown in the footer of every report. */
  readonly label: string;
}
