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
| Quarterly reporting workbook (PAS Infra) | no | no | no |
| Portfolio database (AbIF, PHF) | no | no | no |
| Asset allocation database (look-through) | partly | no | no |

"Reader keeps everything" is the part that is easy to believe is done and is
not. Before the metric table existed, the advisory reader read about sixty
columns per property and stored four. The other three readers are still in that
position: they read what the engine computes on and drop the rest, and the rest
is most of what a report page prints.

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

- **The RSM NAV pack for AbIF.** The only piece keeping the AbIF net tier from
  tying to 124,355.4 EURk. Nothing else is blocked on it.
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
