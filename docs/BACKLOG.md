# What is not done yet

Kept here rather than in a conversation, because a conversation ends and a
container is reclaimed. Each entry says what it is and why it is worth doing, so
picking one up later needs nothing else.

Nothing here is a defect. Defects get fixed; this is work that has not started.

## Group the thirteen sections into four

The left-hand navigation is a flat list of thirteen, in the order they happened
to be built. Somebody looking for a figure has to know which one it is under.
Four groups, and every section belongs to exactly one:

| Group | Sections |
| --- | --- |
| Performance | The close, Dashboard, Investors |
| Portfolio | Portfolio, Exposure, ESG |
| Reporting | Reports, Export |
| Data | Data intake, What is loaded, Data quality, Storage, Access |

`src/components/layout/Navigation.tsx` holds the list and both renderings of it,
the wide one and the narrow one. A group whose every section is closed to the
role should disappear with them, the way a section already does.

## The workbook, for every product

This is the near-term goal, and the deck below waits for it. Each product's
quarter arrives in a shape of its own, and for each shape there are two pieces:
a reader that keeps everything the file states, and a writer that puts it back.
Neither is done until the round trip is: write the book out, read it back, and
the facts must be the same.

| Shape | Reader keeps everything | Writer | Round trip |
| --- | --- | --- | --- |
| Advisory monitoring workbook (PK TG) | yes | yes | yes |
| Quarterly reporting workbook (PAS Infra) | yes | yes | yes |
| LP capital master (UT) | yes | no | no |
| Report support model (AbIF) | yes | no | no |
| Portfolio database (AbIF, PHF) | no | no | no |
| Asset allocation database (look-through) | partly | no | no |
| Administrator NAV pack (UT, and AbIF's is a different one) | no | n/a | n/a |

The NAV pack is the administrator's own statement rather than the fund's book,
so it has no writer and needs none: it is read to reconcile against, not to
reproduce. UT's is CACEIS; AbIF's is RSM and is a different file with different
tabs, so one reader does not serve both.

The report support model is the file the AbIF deck is built from: the figures as
published, quarter by quarter, with the working that produced them. The reader
keeps the published figures as their own facts — `published.netAssetValue` and
the rest — so that what the system computes can be set beside what was reported
rather than overwrite it. It has no writer yet, and a writer for it is a
different question from the two that are done, because most of the file is the
working rather than the result.

The portfolio database is the one left, and it is a different problem from the
two that are done. Those are each one product's own file. A portfolio database
is a manager's whole book — every programme they run, in one workbook — so a
writer for it writes several products at once, or writes one product's rows back
into a file that also holds other people's. That is a decision to make before
any code: whether what comes out is the database that went in, or one file per
product in a shape the database reader can still read.

The allocation database is the smaller piece and has no such question: one
product, one sheet, one row per company per quarter.

## The deck

Deferred deliberately: the documents and decks vary a great deal by product, and
the workbook above is what they are built from. When it comes back, the sheet
that joins the two is `50 REPORT MAP` — every figure the report needs, by page,
with where it comes from — which this system can fill in completely, including
the value column the hand-kept file leaves blank.

The layout feedback on the current PK TG deck is all presentation and none of it
is about a number: background colour, title and figure sizes, missing colour
legends, bars that do not line up with their labels, one page that wants
landscape, a fair-value bridge that is not there, renovations in progress that
should be marked. In a deck those are twenty-three corrections that come back
every quarter. In the report editor they are one.

## Readers still to write

- **The valuation approval letter.** Two pages, a signed table of fair value by
  security, and the basis of each in a footnote. It is the authority the
  portfolio sheet transcribes, and it is what splits a company held in several
  share classes — which the master leaves unsplit rather than apportioned. It
  is also amended: the current one is the second amendment to a letter approved
  a month earlier, same valuation date, different split. Reading it is what
  makes the fair-value history auditable rather than typed.
- **The RSM NAV pack for AbIF.** No longer what the AbIF net tier waits on: the
  report support model states the same quarter's balance sheet, and the identity
  closes on it — 2,357.89 cash plus 122,084.63 portfolio less 87.16 other net
  liabilities is the 124,355.36 EURk published. The NAV pack would be a second,
  independent statement of the same figures, which is worth having as a check
  and is not blocking anything.
- **Capital account statements and financial statements** have no structural
  reader. Their figures go in through New event, against the document, which
  records them exactly as a parsed figure would be — but somebody types them.

## Products with no data

PCIOF I, PCIOF II, and the Una Terra Early Growth Fund. Each needs whatever its
own quarter arrives in, and the reader that reads that shape.

## Longer-standing

- The Supabase write path, and the importer that takes a folder book into it.
- The membership screen, so phase two is a setting rather than a release.
- Multi-factor authentication and an idle timeout, before anyone but its author
  can sign in.
- A major-version upgrade of vite and vitest. Five advisories, all of them in
  development tooling and none reachable from the built application;
  `npm audit fix --force` breaks the build, so it is a deliberate upgrade rather
  than a command.
