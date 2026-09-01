# Calculation methodology

The conventions the engine applies, and why. Where a choice was available, the
reasoning is recorded — a convention nobody can reconstruct becomes a
convention nobody dares change.

Conventions are configurable per client and per vehicle (`ReportingConventions`
in `src/domain/types.ts`). The defaults below are what `DEFAULT_CONVENTIONS`
sets.

---

## Periods

The canonical quarter identifier is `YYYYQn` — `2026Q1`. It sorts
lexicographically in chronological order, which is why it is what gets stored,
keyed and compared. `Q1 2026` is a display form, produced at the edge.

The engine parses the legacy `Q1 2026` form on input, so data carried over from
an earlier system loads without a migration step, but it never writes it.

## Gross and net

**Gross** is the underlying portfolio measured on its own terms: what was
committed to it, what it drew, what it returned, what it is worth. Management
fees, carried interest and vehicle-level expenses do not appear.

**Net** exists at two levels:

- *Product* — the vehicle as a whole. Its NAV is the portfolio **plus** the
  vehicle's own cash and receivables, **less** its current liabilities and
  accrued fees and expenses.
- *Investor* — one LP's capital account inside that vehicle.

The two tiers do not tie and are not meant to. Presenting them as though they
reconcile is the most common error in fund-of-funds reporting, so they are
computed separately and the bridge between them is reported explicitly.

## Currency

Rates are stored in one direction per pair — `1 base = rate quote` — and
inverted or crossed on demand, so a EUR/USD rate and a USD/EUR rate cannot
disagree in the database. A rate that exists in neither direction nor through a
bridge currency is an error, not a silent 1.0.

- **Stocks** (NAV, commitments) translate at the **period closing rate**.
- **Flows** (calls, distributions, fees) translate at the rate of **their own
  date**, or at the period average where the house convention says so.

Translating flows at the closing rate would fold currency movement into the
value change and make the NAV bridge lie about where the quarter's return came
from.

### Where a rate comes from

Rates arrive from the ECB, and are replaced by the rate the administrator's
financials imply once the trial balance for the quarter is received. So a pair
usually carries more than one row for the same quarter, and the table records
which kind of source each came from:

| Authority | Meaning |
| --- | --- |
| `market` | A published fixing — the ECB reference rate. The default when nothing says otherwise. |
| `manual` | Entered by hand, for a pair or a date no feed covers. |
| `administrator` | Implied by the administrator's financials for that period. |

**Precedence is by authority first, and only then by recency.** Within a
quarter, an administrator rate beats a manual one, which beats a market fixing,
whatever order the rows were filed in.

Recency alone would be wrong, and quietly so. Fixings get corrected and
backfilled; if the newest row simply won, a correction to the ECB series filed
weeks after the financials would move a NAV that had already been signed, and
the reported figure would stop tying to the administrator's statement it was
reconciled against. Authority first means the books hold until better books
arrive.

Rates never expire: a quarter with nothing filed falls back to the most recent
earlier one, which is what happens in practice before a quarter's fixing lands.
The fallback is reported rather than assumed — *Data quality → Rates applied*
names, for every currency in the view, the rate used, its authority and source,
what it displaced, and whether it was actually filed for that quarter. Almost
every reconciliation argument is about which rate somebody applied; answering
that from a screen rather than from the rate table is the difference between a
five-minute question and an afternoon.

**A consequence worth stating**: a multiple is *not* currency-invariant. TVPI in
EUR and TVPI in USD differ, because the numerator carries today's rate and the
denominator carries the rates that applied when the capital was drawn. That is
the euro investor's experience against the dollar investor's, not a rounding
artefact. Forcing them to agree would mean translating history at today's rate,
which nobody experienced.

### FX attribution

A period-on-period move splits into the part caused by the underlying position
and the part caused purely by translation:

```
translation = opening_local × (closing_rate − opening_rate)
local       = (closing_local − opening_local) × closing_rate
```

The two always sum to the total move in presentation currency. That is the
identity the NAV bridge checks.

## Performance

**Multiples** — TVPI, DPI and RVPI on paid-in capital. They are `undefined`
rather than zero when nothing has been drawn: a fund that has drawn nothing has
no TVPI, and `0.00x` reads as a total loss.

**IRR** — money-weighted on daily-dated cashflows, with the closing NAV as a
terminal inflow. Solved by Newton–Raphson with a bisection fallback, because
Newton alone diverges on the cashflow shapes private funds actually produce: a
long run of calls followed by one large late distribution. An unsolved IRR is
`undefined`; returning a wrong root quietly would be worse.

## Commitments

```
commitment = drawn + undrawn
open commitment = undrawn + recallable   (where the convention allows recycling)
```

`undrawn` is **not** clamped at zero. A position drawn beyond its commitment —
recycling, or an equalisation the data has not caught up with — is a real
condition. Clamping would hide it while silently breaking the identity, so it
shows as negative undrawn and the check passes honestly.

## Incomplete quarters

A quarter is almost never complete on the day it is wanted.

1. **Roll forward.** A holding with no valuation for the period is carried at its
   last reported NAV plus the net capital drawn since. Never zero.
2. **Mark, where the policy allows.** Under `valueChange: 'portfolio'` the
   rolled-forward NAV is marked with the value change the *reported cohort*
   achieved this quarter — computed on their opening NAVs adjusted for
   cashflows. This anchors the estimate to what actually happened rather than to
   a house assumption. `'fixed'` applies a stated rate; `'none'` leaves the NAV
   cost-adjusted.

   The cohort is **the holding's own vehicle**, not everything on screen. A
   climate-infrastructure fund-of-funds and a direct Swiss infrastructure
   portfolio do not inform each other's estimates. It also keeps a consolidated
   total equal to the sum of its vehicles, which is the first thing anyone
   checks. A vehicle with nothing reported at all falls back to the wider scope.
3. **Propagate.** Provenance is ordered
   `reported < stale < rolled-forward < estimated < missing`, and every derived
   figure inherits the weakest among its inputs.
4. **Refuse.** Below `minimumCoverage` of reported NAV (50% by default) the
   quarter is not publishable. A draft built on a fifth of the portfolio is not
   a draft, it is a guess.

A holding that has never been valued and has no cashflows contributes nothing
and is counted `missing`. One that has never been valued but has drawn capital
is held at net capital drawn, and marked `estimated`.

## Consolidating vehicles

A scope naming no vehicle consolidates every vehicle of the client. The
portfolio, the balance sheets and the investor flows all come from the same set,
each translated from its own currency — a vehicle reporting in CHF and one in
EUR cannot simply be added.

The consolidated figures equal the sum of the vehicles taken separately, exactly.
That is a property worth relying on, because anyone shown three vehicles and a
total will add them up.

## Point in time

Two independent axes run through the fact tables:

- `period` — which quarter a figure describes
- `recorded_at` — when the figure entered the system

Pinning `knowledgeDate` to a publication date makes every later restatement
invisible, reproducing exactly what the desk could have reported that day.
Restatements are appended; originals are never deleted or updated in place.

The as-at picker offers only instants at which the visible picture actually
changed, so a user cannot reproduce a view nobody ever saw.

## Look-through exposure

Where asset detail exists, the vehicle's economic exposure to an asset is

```
asset value × position's stake in the asset × vehicle's stake in the position
```

Holdings with no asset detail fall back to their own attributes, so a breakdown
covers the whole portfolio rather than silently dropping part of it — and the
card says which basis it used.

Asset detail seldom accounts for the whole of a portfolio's value: undeployed
capital, fund-level cash and holdings with no collected data all sit outside it.
Look-through breakdowns therefore report how much of portfolio NAV they cover.

An attribution may be a single label or a weighted split (`{Germany: 0.6,
Austria: 0.4}`); splits are normalised and distributed across their labels.

## Capital accounts

Where an investor's own flows are booked, the account is built from them and the
residual NAV is allocated on the investor's share of **net capital contributed**
— not of commitment, since the two differ whenever investors entered at
different times.

Where they are not, the whole account is allocated pro rata on commitment and
flagged. An allocated account approximates an equalised one and must not be
issued as a statement of account.

## Identity checks

Nineteen assertions run on every analysis. Each is conditional on its inputs, so
a partial quarter produces skips rather than failures — and skips are reported,
because a check that silently never ran is worse than one that failed.

| Check | Asserts |
|---|---|
| `commitments_split` | undrawn + drawn = commitments |
| `open_commitment` | open = undrawn + recallable |
| `percent_invested` | the headline ratio is the ratio it claims to be |
| `portfolio_nav_sum` | the total is the sum of its parts |
| `bridge_*` | opening + every step = closing, for each bridge |
| `nav_components` | vehicle NAV = portfolio + cash + other − liabilities − accruals |
| `net_commitment_split` | investor commitment = called + undrawn |
| `investor_nav_sum` | capital accounts sum to vehicle NAV |
| `investor_ownership` | ownership shares sum to 100% |
| `breakdown_*` | each breakdown sums to the whole |
| `coverage_floor` | reported NAV coverage meets the minimum |

Tolerance is 0.5 in the storage denomination, or 1e-6 relative for figures large
enough that an absolute tolerance is meaningless.

## Denomination

Amounts are stored in thousands of the stated currency and displayed in
millions. A quarterly report that prints nine significant figures is not read,
it is scanned past.
