/**
 * The workbook shapes this system can both read and write.
 *
 * A shape is a reader and a writer of the same file, kept in one place because
 * the two only mean anything together: a reader with no writer strands the book
 * inside the application, and a writer with no reader cannot be checked. Adding
 * a shape is adding a row here, and the round trip that comes with it.
 *
 * Which shape a product's quarter arrives in is a property of the product, not
 * of the file — an adviser's mandate arrives in one shape whoever sends it —
 * so it is chosen by what the product is.
 */

import type { DataSet, Vehicle } from '../domain/types';
import type { PeriodId } from '../domain/period';
import type { TableData } from '../ingest/types';
import type { ImportPlan } from '../ingest/pfdb';
import { planMandateImport } from '../ingest/mandate';
import { planSupportImport } from '../ingest/support';
import { planAccountsImport } from '../ingest/accounts';
import { buildMandateWorkbook } from './mandateWorkbook';
import { buildSupportWorkbook } from './supportWorkbook';
import { buildAccountsWorkbook } from './accountsWorkbook';

export interface WrittenWorkbook {
  sheets: TableData[];
  filename: string;
  problems: string[];
}

export interface WorkbookShape {
  id: 'mandate' | 'support' | 'accounts';
  /** What the file is called, on the screen that offers it. */
  label: string;
  /** One line on what it is for, and what it deliberately leaves out. */
  note: string;
  write(options: {
    dataset: DataSet; vehicleId: string; period: PeriodId; knowledgeDate?: string;
  }): WrittenWorkbook;
  read(sheets: TableData[], vehicleId: string): ImportPlan;
}

export const WORKBOOK_SHAPES: WorkbookShape[] = [
  {
    id: 'mandate',
    label: 'Advisory monitoring workbook',
    note:
      'The book an adviser keeps about funds somebody else runs: the register, the quarter, the '
      + 'histories and the holder’s own capital account. Sheet 05 names every figure that was '
      + 'not reported for its own quarter, because a workbook that looks hand-kept must not pass '
      + 'an estimate off as a reported number.',
    write: buildMandateWorkbook,
    read: (sheets, vehicleId) => planMandateImport(sheets, { vehicleId }),
  },
  {
    id: 'support',
    label: 'Quarterly reporting workbook',
    note:
      'The control panel, the transaction log, the balance sheet, the income statement and the '
      + 'investors’ own ledger — everything a person types. The internal rate of return, the '
      + 'expense ratio and the tables behind the charts are not written: this application '
      + 'computes them, and a copy of somebody else’s formulas is how two answers to the same '
      + 'question start to disagree.',
    write: buildSupportWorkbook,
    read: (sheets, vehicleId) => planSupportImport(sheets, { vehicleId }),
  },
  {
    id: 'accounts',
    label: 'Investment accounts workbook',
    note:
      'The ledger of every movement with every holding, the administrator’s statements quarter '
      + 'by quarter, and the register feed the capital accounts are written from — with the '
      + 'snapshot as the desk published it and the two bases side by side. The multiples, the '
      + 'rates of return and the charts are not written: this application computes them.',
    write: buildAccountsWorkbook,
    read: (sheets, vehicleId) => planAccountsImport(sheets, { vehicleId }),
  },
];

/**
 * The shape a product's quarter arrives in, and is written back out in.
 *
 * A product whose shape has a reader but not yet a writer gets nothing rather
 * than the nearest one: writing an LP capital master into a quarterly reporting
 * workbook would produce a file that opens, reads back, and is not the fund's
 * record.
 */
export function shapeFor(vehicle: Vehicle | undefined, dataset?: DataSet): WorkbookShape | undefined {
  if (!vehicle) return undefined;
  // Two funds of funds arrive in two shapes, and the book says which: only the
  // investment accounts workbook files the administrator's statements as
  // `fs.` figures, so a product whose book carries them arrived that way.
  const fromAccounts = dataset?.metrics.some(
    (m) => m.scope.kind === 'vehicle' && m.scope.id === vehicle.id && m.metric.startsWith('fs.'),
  ) ?? false;
  const id = vehicle.kind === 'mandate' ? 'mandate'
    : vehicle.kind === 'fund-of-funds' ? (fromAccounts ? 'accounts' : 'support')
      : undefined;
  return id ? WORKBOOK_SHAPES.find((shape) => shape.id === id) : undefined;
}
