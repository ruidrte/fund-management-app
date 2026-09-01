# Sample documents

Files for exercising the intake pipeline. They are deliberately awkward in the
ways real documents are awkward, so the review step has something to catch.

## 01_historical_positions.csv — Historical workbook

Two title rows before the header, four different number conventions in the same
sheet, and four rows that must not load cleanly:

| Row | What should happen |
|---|---|
| Nordic Growth Partners IV **SCSp** | Matches "Nordic Growth Partners IV" — the legal form is stripped |
| Thames Venture Fund **3** | Matches "Thames Venture Fund III" — roman and arabic numerals are the same |
| Iberia Real Estate Partners | NAV reads `n/a`; listed under **Not read** rather than loaded as zero |
| Unknown Vehicle SA | Matches no holding; **blocked**, Accept is disabled |
| Total | Skipped — a total row must not become a holding |

Numbers are written Swiss (`15'000.00`), UK (`15,700.00`) and German
(`9.300,00`) in the same column, and all three should read identically.

## 02_transaction_notices.csv — Transaction notice

| Row | What should happen |
|---|---|
| `31/03/2026` | Read as 31 March — 31 cannot be a month |
| `15 March 2026` | Read |
| `2026-03-31` | Read |
| `03/04/2026` | **Rejected** — 3 April or 4 March depending on where it was written, and the wrong guess moves the flow into another quarter |
| `(400.00)` | Accounting negative |

The currency column is missing on the first row, which should drop that field's
confidence rather than silently defaulting.

## 03_administrator_trial_balance.csv — Administrator NAV pack

Classifies into the four buckets that separate net asset value from the
portfolio. Expect: cash 1,850, other assets 300, current liabilities 310,
accrued expenses 230.

The two lines it should *not* classify — "Investments at fair value" and
"Partners' capital" — appear under **Not read**, with every classification it
did make listed alongside them. A misreading has to be visible before it is
committed, not after.

## Testing the rest

- **Historical view** — set *As at* to a date before a quarter's data arrived.
  Q4 2025 pinned to November 2025 has 0% coverage and is refused as
  unpublishable, which is correct.
- **Draft calculation** — Q1 2026 has two holdings that have not reported. See
  Portfolio, or Data quality for the full treatment.
- **Export** — any window, as Excel or a CSV bundle. Open the workbook and check
  `recorded_at` is on every fact sheet.
- **Reports** — four layouts, previewed inline and downloaded as one
  self-contained HTML file.
