import { buildDemoDataSet, DEMO_CLIENTS } from './demo';
import type { ClientSummary, Repository } from './repository';
import type { DataSet } from '../domain/types';

/** In-memory repository over the demo dataset. No network, no configuration. */
export const demoRepository: Repository = {
  label: 'Demo dataset',
  async listClients(): Promise<ClientSummary[]> {
    return DEMO_CLIENTS;
  },
  async loadClient(clientId: string): Promise<DataSet> {
    return buildDemoDataSet(clientId);
  },
};
