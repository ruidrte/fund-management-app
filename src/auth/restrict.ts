/**
 * Narrowing a dataset to what a principal may see.
 *
 * Applied where the data enters the application rather than where it is
 * displayed. An investor login must not have other people's capital accounts
 * reach the engine at all — if they did, a chart, a total or an export could
 * reintroduce them without anybody writing a bug.
 */

import type { DataSet } from '../domain/types';

export function restrictToInvestor(dataset: DataSet, investorId: string | undefined): DataSet {
  if (!investorId) return dataset;
  return {
    ...dataset,
    investors: dataset.investors.filter((i) => i.id === investorId),
    cashflows: dataset.cashflows.filter(
      (c) => c.investorId === undefined || c.investorId === investorId,
    ),
  };
}
