# Where the data lives

Three possible homes for a book, in the order the application prefers them.

| | Sample data | A folder | Supabase |
|---|---|---|---|
| Configuration | none | pick a folder | two environment variables |
| Survives a reload | no | yes | yes |
| Shared between people | no | no | yes |
| Access control | none | the folder's | row-level security, per client |
| Writing from intake | in memory only | **yes** | not built yet |
| Documents kept | no | yes, by content hash | not built yet |

The application above the data boundary is identical in all three: the engine,
the screens and the reports do not know which one they are reading. What differs
is who is responsible for the data, which is why the current source is named in
the header and set out on the **Storage** screen rather than left to be
inferred.

## A folder

The browser can hold a handle to a folder the user picked and read and write
inside it. That is enough for a real book of record on the user's own disk — in
files they can open, back up and hand to somebody else — with no server
anywhere.

Two properties of the browser API shape the design:

- **The page reaches exactly one folder.** There is no traversal out of it, and
  no way to reach another without a fresh prompt the user answers.
- **Permission is not permanent.** The folder is remembered across reloads; the
  grant is not. Reopening the tab asks again. That is a feature — a tab left
  open overnight cannot quietly rewrite the folder — but it is why the Storage
  screen has a *Reconnect* button rather than silently failing.

Chrome and Edge implement it. Firefox and Safari do not, and nothing here is
polyfilled: a folder that silently dropped writes would be far worse than an
honest refusal. It also needs a secure context, so a single-file build opened
from disk over `file://` cannot ask for a folder — run the served build.

### What is in it

```
book.json                          what this folder is, and which schema
clients/<slug>/
  client.json                      the client and its reporting conventions
  vehicles.json                    reference data — rewritten when it changes
  positions.json
  assets.json
  investors.json
  facts/
    position_valuations.jsonl      one fact per line, appended, never edited
    cashflows.jsonl
    balance_sheets.jsonl
    fx_rates.jsonl
    asset_valuations.jsonl
    esg_metrics.jsonl
  documents/
    index.jsonl                    every file ever loaded, with its hash
    files/<hash>.<ext>             the file itself
```

**Facts are appended; reference data is rewritten.** A valuation is an
observation — filing a correction adds a line and the old line stays, because
reproducing last quarter as it was published depends on it. A vehicle's name is
not an observation, and correcting it should not leave two vehicles behind.

**JSON Lines rather than one large array.** Appending a line to a synced folder
uploads the line; rewriting a single large file uploads all of it, and a sync
conflict then costs the whole history instead of one quarter. It is also
readable in any text editor, and a corrupted line costs one fact rather than the
book — a line that will not parse is skipped, counted, and reported on the
Storage screen rather than swallowed.

### What a folder is not

- **It has no permissions.** The roles still shape what the interface offers,
  but a folder cannot enforce them: anyone who can open it can read every file.
  Confidentiality is the folder's, not the application's.
- **One writer at a time.** Two people with the folder synced and the app open
  overwrite each other, and a synced drive resolves that with a conflicted copy
  rather than a merge.
- **A synced drive is a copy, not a backup.** A deletion syncs too. The export
  is the portable copy, and it reads back in.

## Starting a book

A new folder holds nothing. Starting a book writes one client and its vehicles —
the real structure, and not one figure. Everything measured arrives afterwards
through intake.

The first workbook then hits a deliberate wall: a holding that matches nothing
is normally **blocked**, because a valuation filed against a holding invented
from a typo is worse than a row that refused to load. For the first load there
is a switch on the intake screen — *create holdings this book does not have* —
which turns each unmatched row into two candidates: the holding, and the
valuation that waits for it. Both are shown for confirmation, each new holding
carries a warning naming what is being created, and a name close to one already
in the book is refused outright rather than quietly splitting a fund's history
across two records.

Only what the sheet says is used. An attribute the workbook does not carry is
left `Unclassified` rather than guessed at: an invented asset class comes back
later as an exposure chart nobody can account for.

Turn the switch off once the book is seeded. From then on, a name that matches
nothing is a typo, not a new fund.
