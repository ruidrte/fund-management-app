# SharePoint and Microsoft 365

Whether this application can live in a SharePoint environment, and which of the
several things that phrase means.

"SharePoint compatibility" usually turns out to be one of four different
requests. They have different answers, and conflating them is how a project ends
up hosting a reporting system on a document library.

---

## 1. Documents live in SharePoint — the app reads them

**The common case, and the one worth doing.**

Quarterly packs, capital account statements and transaction notices already
arrive by email and get filed in a SharePoint or Teams library. The application
should read them from there rather than asking someone to download and re-upload
each one.

**Feasible, and the code is already shaped for it.** The ingestion pipeline
takes bytes and a filename; where those come from is not its concern. A
SharePoint source is a new module that lists and fetches, not a change to the
readers, the matcher or the review step.

What it needs:

- An Entra ID app registration with `Files.Read.All` or, better,
  `Sites.Selected` scoped to the specific libraries. `Sites.Selected` is the
  correct choice: it grants access to named sites rather than to everything the
  signed-in user can reach.
- Microsoft Graph, `/drives/{id}/root/children` to list and `/items/{id}/content`
  to fetch.
- A watched folder per client, so a document's tenancy is determined by where it
  was found rather than by who happened to upload it.

What to decide first: **whether Graph is called from the browser or from a
server.** From the browser, the user's own permissions apply, which is a clean
answer but means every reviewer needs library access. From a server with an
application permission, the app has broad access and must enforce the client
boundary itself. The first is safer; the second is usually what people expect.

A polling job on the delta endpoint turns this into automatic intake: new
document appears, extraction runs, candidates land in the review queue. The
review step does not change — nothing commits unreviewed regardless of how the
file arrived.

## 2. Reports are written back to SharePoint

**Feasible, and small.** The report renderer already produces one self-contained
HTML file with no external requests. Writing it to a library is a `PUT` to
`/drives/{id}/items/{path}:/content`.

Worth doing alongside: SharePoint columns for fund, quarter and status, so the
library is filterable rather than a list of filenames. Graph sets those in the
same call.

The generated report needs no server to view — it opens from the library, from a
local disk or from an email attachment, and will still open in five years. That
property is deliberate and should not be traded away for a nicer viewer.

## 3. The application is hosted as a SharePoint Framework web part

**Possible, and probably not what you want.**

SPFx would put the application inside a SharePoint page. It can be done — the
app is a static bundle with no server — but the cost is real:

- SPFx pins a React version and a build toolchain that lag current releases.
  This application is on React 18 with Vite; an SPFx port means adopting their
  webpack configuration and their upgrade cadence.
- Debugging happens through the SharePoint workbench, which is materially slower
  than `npm run dev`.
- Any future need for a backend — scheduled imports, a server-side PDF pipeline,
  webhook ingestion — sits awkwardly inside a web part.

**The alternative that gets the same outcome:** host the app as a static site
(Azure Static Web Apps, Netlify, or an internal server), authenticate with Entra
ID, and add a link or an embed tile in SharePoint. Users reach it from
SharePoint, the app stays a normal application, and nothing about the build is
constrained by someone else's toolchain.

Reconsider only if there is a policy requirement that nothing runs outside the
SharePoint tenant. That is a real constraint at some institutions, and if it
applies it decides the matter.

## 4. SharePoint lists as the database

**No.** This one is worth being unambiguous about.

SharePoint lists have a 5,000-item view threshold, no transactions, no foreign
keys, no check constraints and no row-level security in the sense this
application depends on. The bitemporal fact tables would exceed the threshold
within a few quarters of one fund-of-funds — the test fixture alone is 537 rows
for a single vehicle over thirteen quarters.

More fundamentally: every integrity guarantee in this system is a database
constraint. The period format, the ownership range, the requirement that a
cashflow have exactly one counterparty, the tenant boundary itself. On lists,
all of that becomes application code that a direct edit through the SharePoint
UI bypasses entirely.

If Microsoft-stack storage is required, **Azure SQL or Postgres on Azure** is
the answer, not lists. Dataverse is a distant third — it has constraints and row
security, but the reporting workload is not what it is built for.

---

## Authentication with Entra ID

Independent of the above, and worth doing in any Microsoft-centric organisation:
users sign in with their work account rather than a separate password.

Supabase supports Entra ID as an OIDC provider directly, so this is
configuration plus a button — the `AuthContext` already isolates sign-in behind
one interface. The mapping that matters is from Entra group to `client_members`
row, so access is granted by group membership rather than maintained by hand in
two places.

---

## Recommendation

Do (1) and (2): read documents from SharePoint, write reports back to it, and
sign in with Entra ID. That is where the friction actually is — nobody wants to
download a NAV pack in order to upload it again — and none of it constrains the
application's architecture.

Do not do (3) unless a tenant-boundary policy forces it, and do not do (4) at
all.

The work for (1) and (2) is one module and an app registration. The ingestion
pipeline, the extractors, the review step and the report renderer are unchanged,
because none of them has an opinion about where a file came from or where it
goes.
