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
import { buildMandateWorkbook } from './mandateWorkbook';
import { buildSupportWorkbook } from './supportWorkbook';

export interface WrittenWorkbook {
  sheets: TableData[];
  filename: string;
  problems: string[];
}

export interface WorkbookShape {
  id: 'mandate' | 'support';
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
];

/** The shape a product's quarter arrives in, and is written back out in. */
export function shapeFor(vehicle: Vehicle | undefined): WorkbookShape | undefined {
  if (!vehicle) return undefined;
  return WORKBOOK_SHAPES.find(
    (shape) => shape.id === (vehicle.kind === 'mandate' ? 'mandate' : 'support'),
  );
}
