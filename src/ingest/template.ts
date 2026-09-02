/**
 * The template.
 *
 * Nothing here requires it: the readers work by recognising column headings,
 * so an existing sheet usually loads as it is. But "no template needed" is a
 * poor answer to "what should I send you", and the person filling a sheet in
 * for the first time deserves a shape to fill rather than a list of synonyms to
 * read. So the template is a convenience, never a contract.
 *
 * Every sheet here is one the readers already understand, and each carries two
 * example rows written in a different convention from each other — a reminder
 * that the reader does not care which one is used.
 */

import type { Extract, Sheet } from '../export/extract';

export function buildTemplate(): Extract {
  return {
    sheets: [notes(), holdings(), transactions(), balanceSheet(), rates()],
    manifest: MANIFEST,
    filename: 'reporting_template',
    periods: [],
  };
}

const MANIFEST = [
  'Reporting template',
  '',
  'A convenience, not a requirement. Every reader in the application works by',
  'recognising column headings, so a sheet you already keep will usually load as',
  'it is — including one with a title row above the header, several sheets, or',
  'four number conventions in the same column.',
  '',
  'Use one sheet per kind of thing. Fill what you have; leave the rest empty.',
  'Column order does not matter, extra columns are reported rather than guessed',
  'at, and a row that cannot be read is listed instead of being silently dropped.',
  '',
  'Amounts are in thousands of the stated currency, which is the convention the',
  'application stores and displays. Dates may be written 2026-03-31, 31 March',
  '2026 or 31/03/2026; 03/04/2026 is refused, because a day-month swap moves a',
  'figure into the wrong quarter.',
].join('\n');

function notes(): Sheet {
  return {
    name: 'Read me',
    description: 'What each sheet is for, and what is required.',
    columns: ['Sheet', 'What it carries', 'Required', 'Loaded as'],
    rows: [
      ['Holdings', 'One row per holding, per quarter: value and cumulative amounts',
        'A name and a value. Everything else optional', 'Data intake -> Historical workbook'],
      ['Transactions', 'One row per movement: calls, distributions, fees',
        'A holding, a date, an amount', 'Data intake -> Transaction notice'],
      ['Balance sheet', 'The vehicle’s own assets and liabilities, per quarter',
        'A period and at least one line', 'Data intake -> Administrator NAV pack'],
      ['FX', 'Rates, if you keep your own rather than taking the published ones',
        'Base, quote, rate, date', 'Data intake -> Administrator NAV pack'],
      ['—', 'Look-through assets and their quarterly values',
        'Not yet readable from a sheet', 'Enter through the event form for now'],
    ],
  };
}

function holdings(): Sheet {
  return {
    name: 'Holdings',
    description: 'One row per holding per quarter. Cumulative figures are as at that quarter.',
    columns: [
      'Fund', 'Currency', 'Period', 'Commitment', 'Drawn', 'Distributed',
      'Recallable', 'NAV', 'Vintage', 'Region', 'Asset class',
    ],
    rows: [
      ['Baltic Wind Partners II', 'EUR', '2026Q1', 8000, 5600, 1200, 300, 6400, 2021,
        'Europe', 'Infrastructure'],
      // Deliberately a different convention: the quarter as a date, and Swiss
      // grouping. Both read identically.
      ['Nordic Growth Partners IV', 'CHF', '31.03.2026', "12'000.00", "9'000.00", '0.00',
        null, "11'400.00", 2019, 'Europe', 'Private equity'],
    ],
  };
}

function transactions(): Sheet {
  return {
    name: 'Transactions',
    description: 'One row per movement. Amounts positive; the type decides the direction.',
    columns: ['Fund', 'Date', 'Type', 'Amount', 'Currency', 'Description'],
    rows: [
      ['Baltic Wind Partners II', '2026-02-15', 'Capital Call', 1250, 'EUR', 'Drawdown 7'],
      ['Nordic Growth Partners IV', '31 March 2026', 'Distribution', 800, 'CHF', 'Partial realisation'],
    ],
  };
}

function balanceSheet(): Sheet {
  return {
    name: 'Balance sheet',
    description:
      'The vehicle’s own balance sheet, which is what separates the portfolio from the '
      + 'net asset value. Liabilities and accruals positive; the engine subtracts them.',
    columns: ['Period', 'Cash', 'Other assets', 'Current liabilities', 'Accrued expenses'],
    rows: [
      ['2026Q1', 1850, 300, 310, 230],
      ['2025Q4', 2100, 280, 260, 215],
    ],
  };
}

function rates(): Sheet {
  return {
    name: 'FX',
    description:
      'Quoted as 1 base = rate quote. Rates taken from the administrator’s financials '
      + 'outrank published fixings for the same quarter.',
    columns: ['Base', 'Quote', 'Rate', 'Kind', 'Date', 'Period', 'Source'],
    rows: [
      ['EUR', 'USD', 1.1523, 'closing', '2026-03-31', '2026Q1', 'Administrator trial balance'],
      ['EUR', 'CHF', 0.9323, 'closing', '2026-03-31', '2026Q1', 'Administrator trial balance'],
    ],
  };
}
