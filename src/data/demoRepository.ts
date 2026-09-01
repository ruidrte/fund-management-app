import { buildDemoDataSet, DEMO_CLIENTS } from './demo';
import type { ClientSummary, Repository } from './repository';
import type { DataSet } from '../domain/types';

/**
 * In-memory repository over the sample dataset. No network, no configuration.
 *
 * The label is deliberately explicit: the vehicle names are real, so a
 * screenshot of this could otherwise be taken for a report. Every figure is
 * invented.
 */
export const demoRepository: Repository = {
  label: 'Sample data — synthetic figures',
  async listClients(): Promise<ClientSummary[]> {
    return DEMO_CLIENTS;
  },
  async loadClient(clientId: string): Promise<DataSet> {
    return buildDemoDataSet(clientId);
  },
};
