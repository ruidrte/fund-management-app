# Fund Reporting & Monitoring

Quarterly reporting and monitoring for fund-of-funds structures, and for direct
funds through the same code path.

The application answers four questions about a portfolio, at any quarter, as at
any date:

- **What is it worth, gross and net?** The portfolio measured on its own terms,
  and the investor's position after everything the vehicle charges — kept
  separate, because they are different questions.
- **Where is the money?** Allocation and exposure by asset class, region,
  sector, country, currency, vintage and manager, on look-through assets where
  they exist and on holding attributes where they do not.
- **What moved, and why?** NAV and commitments bridges that split a quarter into
  cashflow, value change and currency translation, and must close exactly.
- **How much of this is actually reported?** Coverage, provenance and identity
  checks, so a draft is never mistaken for a final quarter.

## Running it

```bash
npm install
npm run dev      # http://localhost:5173
npm test         # 55 tests over the calculation engine
npm run build
```

With no configuration it runs against a built-in demo dataset — two clients, a
EUR fund-of-funds and a USD direct fund, three currencies, an incomplete latest
quarter and a restated prior one. Set `VITE_SUPABASE_URL` and
`VITE_SUPABASE_ANON_KEY` to run against a database instead; the engine and the
screens are the same either way.

The schema is in `supabase/migrations/`. It has been applied to a clean
PostgreSQL 16 and its constraints and row-level-security policies verified.

## The four ideas the design rests on

### Scope is explicit

Every figure is derived from six selections — client, vehicle, holding,
quarter, as-at date and presentation currency. They are arguments to
`analyse(dataset, scope)`, never ambient state, and they are visible in the bar
at the top of every screen. A client is the tenant boundary; changing it clears
every narrower selection.

### Facts are bitemporal

Every observation records both the period it describes and the instant it was
learned. A quarterly report is a slice of the first; reproducing what was
*published* for that quarter is a slice of both. Without the second axis a
historical quarter silently drifts as corrections arrive, and the report you
re-run in March no longer matches the one you signed in January.

Restatements are new rows. The originals stay.

### A missing figure is never a zero

Underlying funds report on their own timetables. Waiting for the last one means
the desk has no number for six weeks, so the engine produces one from what has
arrived and states plainly what it did for the rest:

- A holding with no valuation for the period is rolled forward from its last
  reported NAV, adjusted for the cashflows since, and labelled.
- Where the policy allows, the roll-forward is marked with the value change the
  holdings that *did* report actually achieved — an estimate anchored to this
  quarter's experience rather than to a house assumption.
- The weakest provenance among the inputs propagates to every derived figure.
  One estimated holding makes the portfolio total an estimate, and it is badged
  as one everywhere it appears.
- Below a configurable share of reported NAV the quarter is refused rather than
  published.

### Identities are checked, not assumed

A green recalculation does not prove a number is right. A failing identity
proves one is wrong — loudly, early, and for free. Nineteen assertions run on
every analysis: bridge closure, commitment splits, NAV composition, capital
accounts summing to the vehicle, each breakdown summing to the whole. Checks
are conditional on their inputs, so a partial quarter produces skips rather than
failures, and the skips are reported.

## Layout

```
src/
  domain/      the model and quarter arithmetic; no behaviour
  engine/      pure calculation, no React and no database
    asof            bitemporal selection
    fx              currency treatment and translation attribution
    metrics         XIRR, multiples
    completeness    the draft calculation
    gross           portfolio tier
    net             product tier and per-investor capital accounts
    bridge          NAV and commitments waterfalls
    exposure        allocation and look-through
    checks          identity assertions
    index           analyse(dataset, scope) -> QuarterView
  data/        repository boundary; demo and Supabase implementations
  context/     scope and theme
  components/  layout, shared UI, charts
  pages/       one per section
  reports/     layout declarations and the self-contained HTML renderer
supabase/migrations/
tests/
```

The engine has no dependency on React or on Supabase, which is why the
arithmetic can be tested directly rather than through a rendered screen.

## Reports

Four predefined layouts — quarterly investor report, internal monitoring pack,
investor capital accounts, direct fund quarterly. A layout declares which
sections appear in what order; it is never a bespoke renderer. Output is one
self-contained HTML file: inline styles, hand-emitted SVG, no CDN, no network at
render time or view time. It opens from a local disk or an email attachment, and
will keep doing so.

If a fund needs something the layouts cannot express, the fix is a new section
type, not a special case in the renderer.

## Charts

The categorical order, the diverging pair and the status steps are the validated
defaults from the data-visualisation reference palette, run through the
colourblind-separation, chroma, lightness and contrast gates in both light and
dark mode. Three light-mode series sit below 3:1 against the surface, so every
chart ships direct labels and a table view — that relief is not optional. Sign
is never carried by colour alone: a bridge step is placed relative to its
baseline and prints a signed value; provenance carries an icon and a word.

## What is not built yet

- **ESG** — the schema, the scope model and the coverage discipline are in
  place. The PAI indicator library, look-through metric aggregation, taxonomy
  alignment and period-on-period comparatives are not. `src/pages/Esg.tsx` lists
  the specific gaps.
- **Data entry** — the application reads. Loading a quarter means writing to the
  fact tables directly or through an import that has yet to be built.
- **Hedging** — currency exposure is shown before hedging. Hedge instruments are
  not modelled, so a hedged vehicle's reported exposure overstates what it
  actually carries.
- **Carried interest** — modelled only as a cashflow, not as a waterfall.
