# Fund Reporting & Monitoring

Quarterly reporting and monitoring for fund-of-funds structures, and for direct
funds through the same code path.

The application answers four questions about a portfolio, at any quarter, as at
any date:

- **What comes in?** Historical workbooks, transaction notices and administrator
  NAV packs are read, matched, validated and reviewed before anything is filed.
  A portfolio database — funds, movements, companies and their quarterly values
  in one workbook — is recognised as a book rather than a document and imported
  whole, filling the portfolio and the look-through together.
  Exchange rates are taken from the ECB and replaced by the rates the
  administrator's financials declare, once those arrive.
- **What goes out?** Any quarter, range, or the whole history since inception,
  as an Excel workbook or a zipped CSV bundle.
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
npm run dev            # http://localhost:5173
npm test               # 193 tests over the engine, permissions, ingestion, storage and export
npm run build          # dist/ — deploy anywhere static (netlify.toml included)
npm run build:single   # dist-single/index.html — the whole app in one file
```

`build:single` inlines every asset into one HTML document, so the application
opens from a link, an email attachment or a local disk with no server at all.
Everything works in that build except reading PDFs, which needs the pdf.js
worker as a separate file; it says so rather than failing obscurely.

`samples/` holds documents for exercising the intake pipeline. They are
deliberately awkward in the ways real documents are awkward — four number
conventions in one column, an ambiguous date, a fund that matches nothing, a
total row — and `samples/README.md` says what each row should do.

With no configuration it runs against a built-in sample dataset. From the
**Storage** screen you can point it at a folder on your own disk instead — real
data, no server, no account, and the files stay yours, encrypted under a
passphrase if you choose; `docs/STORAGE.md`
describes what is written there and what a folder does not give you. Setting
`VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` runs it against a database. The
engine and the screens are the same in all three.

### The sample dataset

The **structure** is real — three clients and the seven vehicles they run. Every
**figure** is synthetic, and so is every holding name. Real vehicle names make
the application recognisable to the people who will use it; invented figures
make it impossible for a screenshot to be mistaken for a report.

| Client | Vehicle | Kind | Currency | Inception | Status |
|---|---|---|---|---|---|
| PAM | Patrimonium Climate Infrastructure Opportunity Fund I | fund-of-funds | EUR | 2021-06-30 | Investing |
| PAM | Patrimonium Climate Infrastructure Opportunity Fund II | fund-of-funds | EUR | 2024-09-30 | Fundraising |
| PAM | PAS Infra | fund-of-funds | CHF | 2019-12-31 | Harvesting |
| EBG | Abendrot Impulse Fund | fund-of-funds | CHF | 2020-03-31 | Investing |
| EBG | Planetary Health Fund I | fund-of-funds | EUR | 2022-06-30 | Investing |
| EBG | PK TG | fund-of-funds | CHF | 2018-09-30 | Harvesting |
| UT | Una Terra Early Growth Fund | direct-fund | EUR | 2022-03-31 | Investing |

Only Una Terra Early Growth Fund is a direct fund. The other six are
fund-of-funds structures, and each holds a mix: fund commitments, secondaries,
co-investments and assets held outright. That mix is a property of the holding,
not of the vehicle — the `positionKind` exposure breakdown shows it.

**Currency, inception and status are assumptions**, inferred from each vehicle's
strategy rather than supplied. Correcting them means editing the one table at the
top of `src/data/demo.ts`.

The dataset is deliberately awkward in the ways real data is awkward: four
currencies, vehicles at different stages of life, a latest quarter where part of
several portfolios has not reported, and a prior quarter restated after
publication. PK TG is the one vehicle that is complete and final; the rest are
drafts.

The schema is in `supabase/migrations/`. It has been applied to a clean
PostgreSQL 16 and its constraints and row-level-security policies verified.

## The four ideas the design rests on

### Scope is explicit

Every figure is derived from six selections — client, product, holding, quarter,
as-at date and presentation currency. They are arguments to
`analyse(dataset, scope)`, never ambient state, and they are visible at the top
of every screen. A client is the tenant boundary; changing it clears every
narrower selection.

Client and product are tabs, because there are few of each and people move
between them constantly. **The client row appears only for someone who can reach
more than one client**: a client's own team sees their products and no
indication that other clients exist, which is what their membership already
entitles them to — showing a disabled row of other people's names would leak the
client list.

A consolidated view across a client's products is a product view of its own, not
the absence of one, and its totals equal the sum of the products exactly.

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

### Nothing enters unreviewed

Everything that arrives — a spreadsheet, a PDF notice, a typed correction — goes
through one pipeline: document, extraction, candidates, review, commit. Every
candidate carries what it was read from (down to the cell reference), how
confident the reader was, what it was matched to, and what validation found.

The review step is not a formality. An extracted figure is a *claim about* a
document, and a wrong claim that lands silently is indistinguishable from a
correct one six months later. So the readers refuse rather than guess: a
workbook whose header cannot be identified is reported, not interpreted; an
ambiguous `03/04/2026` is rejected because a day-month swap moves a cashflow
into the wrong quarter; a fund name matching nothing blocks its row instead of
attaching to the nearest.

A manual entry is recorded as a document too, so a typed figure is as traceable
as a parsed one.

### Identities are checked, not assumed

A green recalculation does not prove a number is right. A failing identity
proves one is wrong — loudly, early, and for free. Nineteen assertions run on
every analysis: bridge closure, commitment splits, NAV composition, capital
accounts summing to the vehicle, each breakdown summing to the whole. Checks
are conditional on their inputs, so a partial quarter produces skips rather than
failures, and the skips are reported.

## Security, and the questions still open

`docs/SECURITY.md` sets out what is enforced — tenancy in the database rather
than the application, insert-only fact tables, spreadsheet-formula and HTML
injection defences, a hardened PDF parser, zero dependency advisories — and what
is not: data residency, `created_by`, MFA, document storage, export auditing.
Those are decisions to take before real investor data goes in, and the document
lists them in the order they depend on each other.

`docs/PERMISSIONS.md` sets out the seven roles and what each permits. The
distinction that matters: one investor must never see another's commitment, so
that restriction is a database policy rather than a filtered screen, and an
investor login is bound to exactly one account by a check constraint.

`docs/SHAREPOINT.md` separates the four different things "SharePoint
compatibility" turns out to mean, and recommends two of them.

`docs/STORAGE.md` sets out the three places a book can live — the sample data,
a folder on the user's own disk, or Supabase — what each does and does not
guarantee, and what is written where.

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
  ingest/      document intake: format drivers, entity matching, validation
  export/      historical extract, and the CSV and XLSX writers
  reports/     layout declarations and the self-contained HTML renderer
supabase/migrations/
tests/
```

The engine has no dependency on React or on Supabase, which is why the
arithmetic can be tested directly rather than through a rendered screen.

## Reports

A layout declares which sections appear in what order; it is never a bespoke
renderer. Output is one self-contained HTML file: inline styles, hand-emitted
SVG, no CDN, no network at render time or view time. It opens from a local disk
or an email attachment, and will keep doing so.

Four built-in layouts come with the application — quarterly investor report,
internal monitoring pack, investor capital accounts, direct fund quarterly — and
they are the desk's. **The pack that goes to a limited partner belongs to the
client**: its layout and its branding (house, accent, cover note, standing
footer text) live in that client's own book, beside its figures, and are edited
on the Reports screen. A new client is a new profile rather than a new build.

The accent colours the cover rule and the eyebrow and nothing else. It never
reaches a data mark: the categorical palette is chosen for separation and
contrast, and a brand colour dropped into it produces two series that no longer
read apart.

If a fund needs something the layouts cannot express, the fix is a new section
type, not a special case in the renderer.

## The close

One screen for the question that comes before every other one: across every
product a person is responsible for, what is ready, what is waiting, and on
what. Coverage, failing checks and standing for each product in a quarter, the
outstanding holdings that would have to arrive for it to be final, and one
button that generates every selected product's own pack into a single zip,
foldered by client, with an index recording the standing each was generated at.

The work is not "produce a report" — it is "produce seven reports, in the same
fortnight, from data that arrives at seven different times". Opening each
product in turn to find out which are short is the part that does not scale.

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
- **Capital account statements and financial statements** — no structural
  reader. Their text extracts, but the layouts share nothing between GPs. Enter
  the figures through the manual event form, which records them against the
  document exactly as a parsed figure would be.
- **PDF reading in the single-file build.** `npm run build:single` cannot load
  the pdf.js worker, which is a separate file. It says so rather than failing as
  though the document were corrupt. The normal build reads PDFs.
- **Scanned PDFs** — no OCR. A scan with no text layer is reported as such
  rather than appearing to succeed with nothing in it.
- **Writing to Supabase** — reading from the database is implemented; the
  inserts from the intake screen are not. Against a folder, intake writes: the
  facts are appended and the document is kept beside them. Against the sample
  data nothing is persisted, and the screen says so rather than reporting a
  successful commit.
- **Hedging** — currency exposure is shown before hedging. Hedge instruments are
  not modelled, so a hedged vehicle's reported exposure overstates what it
  actually carries.
- **Carried interest** — modelled only as a cashflow, not as a waterfall.
