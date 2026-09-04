/**
 * What the application reads before a book is connected.
 *
 * The clients and their products, and nothing measured. There is deliberately
 * no built-in dataset behind this: a screen of plausible figures nobody filed
 * is worse than an empty one, because it can be screenshotted, sent, and
 * believed. Every number in this application comes from a document somebody
 * loaded.
 */

import { buildClientStructure, KNOWN_CLIENTS } from './structure';
import type { ClientSummary, Repository } from './repository';
import type { DataSet } from '../domain/types';

export const unopenedRepository: Repository = {
  label: 'No book connected',
  async listClients(): Promise<ClientSummary[]> {
    return KNOWN_CLIENTS;
  },
  async loadClient(clientId: string): Promise<DataSet> {
    const { client, vehicles, reporting } = buildClientStructure(clientId);
    return {
      client,
      vehicles,
      reporting,
      positions: [],
      assets: [],
      investors: [],
      positionValuations: [],
      assetValuations: [],
      cashflows: [],
      balanceSheets: [],
      fxRates: [],
      esgMetrics: [],
    };
  },
};
