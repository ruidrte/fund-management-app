# Security

What this application does about confidentiality and integrity, what it
deliberately does not do, and what has to be decided before it holds real
investor data.

Written plainly rather than reassuringly: an accurate list of gaps is worth more
than a claim of completeness.

---

## The data, and why it matters

Everything here is confidential by default. Investor names and commitments,
fund-level performance, capital account balances, and the documents those come
from. Under Swiss and EU rules an investor's identity plus their commitment is
personal data; a capital account statement is personal data with a financial
dimension. Losing a quarterly pack for one client is a reportable incident, not
an inconvenience.

Two consequences shape the design:

1. **The client is the tenant boundary**, enforced in the database rather than
   in the application. An application bug should not be able to cross it.
2. **Facts are append-only.** Nothing is edited or deleted in place, so an
   attacker with write access cannot quietly alter a published figure — a
   restatement is a new row, and the original survives to be compared against.

---

## What is enforced today

### Tenancy and access

Row-level security is enabled on all twelve tables and every policy resolves
through membership of the owning client. There is no application path that
bypasses it, because the application holds no privileged credential: the browser
uses the anon key, and Postgres decides what that key's session may see.

Verified against a clean PostgreSQL 16: the migration applies, a non-member sees
zero rows, and a member sees their own client's data and no other's. Grants are
declared explicitly rather than inherited from default privileges, so a schema
deployed differently from how it was tested fails loudly rather than returning
an empty result that looks like an empty portfolio.

Seven roles: `superuser`, `owner`, `editor`, `analyst`, `auditor`, `viewer`,
`investor`. Writes require `owner` or `editor`; membership changes require
`owner`. Fact tables accept `INSERT` only — no policy grants `UPDATE` or
`DELETE` on a valuation, a cashflow past draft, a balance sheet, an FX rate or
an ESG metric. `docs/PERMISSIONS.md` sets out what each role permits and why.

**Investor scoping.** A login bound to the `investor` role reads exactly one row
of `investors` and only the cashflows attached to it. This is a policy, not a
screen: an investor who reaches the API directly gets the same answer. A
membership with role `investor` and no `investor_id` is rejected by a check
constraint, because such a row would otherwise fall through the filter into
seeing everyone.

**Superusers** live in `platform_admins`, separate from client membership, and
that table is readable but not writable by anyone signed in to the application.
A role that can promote itself is not a role.

### Authentication

A session is required before any client data is requested. Without a backend
configured the application runs with no book and says so, rather than
presenting a login that would accept anything. Sign-in failures do not
distinguish an unknown account from a wrong password, which is a distinction
only useful to someone enumerating accounts.

### Injection

- **HTML.** The report renderer escapes `& < > " '` at every interpolation. Fund
  and manager names arrive from imported documents and are not trusted input.
- **Spreadsheet formulas.** Cells beginning `=`, `+`, `-`, `@`, tab or carriage
  return are prefixed with an apostrophe in both the CSV and XLSX exports. A
  spreadsheet executes such a cell on open, and the name in it came from a
  document this system did not write. This is the most commonly missed
  vulnerability in any application that exports to Excel.
- **SQL.** All access goes through parameterised PostgREST calls; no query is
  assembled from strings.
- **XML.** The workbook writer escapes metacharacters and strips control
  characters that are not legal in XML 1.0.

### Untrusted documents

Uploads are capped at 25 MB and restricted to `.csv`, `.tsv`, `.txt`, `.xlsx`
and `.pdf`. PDFs are parsed with `eval` disabled (the default in pdf.js 6),
font loading disabled, XFA forms disabled and network fetching disabled — a
statement has no legitimate reason to do any of those. Parsing happens in the
browser; nothing is uploaded to a third party to be read.

The report preview renders inside `<iframe sandbox="">`, so a generated document
cannot run script or navigate the page that embeds it.

### Dependencies

`npm audit --omit=dev` reports zero vulnerabilities. The runtime tree is
deliberately small: React, Supabase's client, `fflate`, `lucide-react`, and
`pdfjs-dist` loaded on demand. `exceljs` was evaluated and rejected — it pulls a
`uuid` version carrying an advisory, and an XLSX is a zip of XML that can be
written directly in about two hundred lines. A dependency that handles
confidential data has to earn its place.

---

## What is not enforced yet

These are decisions, not oversights. Each needs an answer before real data goes
in.

### Where the data lives

Supabase Cloud's EU region keeps data in the EU. For Swiss FINMA-supervised
activity that may not be sufficient, and self-hosting Supabase — or running
plain Postgres — in Switzerland is the alternative. **This is the first question
to settle**, because it constrains everything below it.

### Audit trail — partly closed

`created_by` now sits on every fact table, defaulted to `auth.uid()` so it is
stamped by the database rather than supplied by the client and cannot be forged
by an application that forgets to set it. `source_documents` records the file a
figure was read from, with its SHA-256, and fact rows carry a `document_id`.

What remains: no history of *reads*, and no record of who exported what. A
figure's origin is answerable; an access log is not.

### Document storage

`SourceDocument.storageRef` is a pointer with nothing behind it. Documents are
parsed in the browser and the bytes are discarded; only the SHA-256 is kept.
That proves a file on a shared drive is the one the figures came from, but it
does not retain the file. Wiring this to Supabase Storage, or to SharePoint (see
`SHAREPOINT.md`), needs its own access-control decision — document permissions
and row permissions are not the same thing and will not stay in step by
themselves.

### Session policy

Supabase defaults apply: JWTs refreshed in the background, no idle timeout, no
enforced MFA. For investor data an idle timeout and mandatory MFA for `editor`
and `owner` are the minimum, and both are configuration rather than code.

### Transport and headers — closed

`netlify.toml` sets HSTS, `nosniff`, a restrictive `Referrer-Policy`,
`X-Frame-Options: DENY` and a Content-Security-Policy with no escape hatch for
script: the bundle contains no inline script, so `script-src 'self'` holds.
`style-src` does carry `'unsafe-inline'`, because the interface sets colours
through style attributes; that buys an attacker nothing a class would not.

Verified against the built bundle with the header actually served: every screen,
a report preview in its sandboxed frame, and a PDF parsed end to end, with no
violation reported. Any other host needs the same headers — they belong in the
hosting configuration, not in the bundle, and a bundle cannot check that they
are there.

### Rate limiting and brute force

Supabase applies its own limits to auth endpoints. Nothing further is
implemented.

### Export controls

Any signed-in user with read access can export everything they can see. That is
usually the point, but a data-loss-prevention posture would want the export
recorded — who, what scope, when — and possibly approved. The extract already
carries a manifest describing exactly what it contains, which is the harder half
of that.

### Encryption at rest

Whatever the host provides. No column-level encryption is applied. Investor
names and commitments are the fields that would warrant it if the threat model
includes a database-level compromise.

---

## Threats this design does and does not address

| Threat | Position |
|---|---|
| One client's user reading another's data | Addressed — enforced in the database, verified |
| Application bug leaking across tenants | Addressed — the application holds no privileged credential |
| Silent alteration of a published figure | Addressed — fact tables are insert-only, originals survive |
| Malicious spreadsheet formula in an export | Addressed — neutralised in both formats |
| Script injection through a fund name | Addressed — escaped at every interpolation |
| Hostile PDF | Partly — parser hardened, but it is still a parser |
| Script injected into the page itself | Addressed for a hosted build — CSP with no inline script |
| Stolen session token | Not addressed — no idle timeout, no MFA |
| Insider exporting everything | Not addressed — no export audit or approval |
| Database-level compromise | Not addressed — no column encryption |
| A synced copy of the folder, or the drive account | Addressed for a folder — encrypted at rest under a passphrase held only in memory |
| History edited outside the application | Partly — the fact chain reports it; it does not prevent it |
| Who filed a given figure | Addressed — `created_by`, stamped by the database |
| One investor reading another's commitment | Addressed — policy-enforced, verified |
| A user promoting themselves to superuser | Addressed — `platform_admins` is not writable from the app |

---

## A folder instead of a database

The application can keep its book in a folder on the user's own machine. Nothing
is uploaded: spreadsheets and PDFs are parsed in the browser, and what is filed
is written into that folder. For one person working alone that is a smaller
attack surface than any hosted option — there is no server to reach, no account
to phish, and no third party holding the data.

**The folder can be encrypted.** AES-GCM under a key derived from a passphrase
by PBKDF2-SHA256 at 600,000 iterations, chosen when the book is created. Every
fact, every reference file, every stored document and the list of clients are
ciphertext; what stays readable is the schema version and the key-derivation
parameters, which say nothing about the contents. The client folders are named
with random ids, because a folder called `ebg` would say who this is. The
passphrase is held in memory only — never in the folder, never in browser
storage — so a reload asks again, and a tab left open overnight is the exposure
rather than the disk. There is no recovery: a lost passphrase is a lost book.

Each fact line also carries the hash of the line before it, so history edited,
reordered or deleted outside the application is reported rather than silently
short. That is tamper-evidence against accidents, not against someone who can
rewrite the whole file.

What encryption does not change is enforcement. The roles below still shape what the
interface offers, but a folder cannot check them: anyone who can open the folder
reads every file in it, including the source documents. So the folder is the
control, and it should be one only the intended person can open — a synced
folder shared with a team is, for this purpose, a shared database with no
permissions at all.

It is also one writer at a time. Two people with the folder synced and the
application open will overwrite each other, and the sync client resolves that by
keeping a conflicted copy rather than by merging.

Use it for real data with one custodian. Move to the database before more than
one person files figures, or before anyone outside the team can reach the
folder.

## Before real data

In order, because each depends on the last:

1. Decide data residency. It constrains the hosting choice.
2. Enforce MFA for `owner` and `editor` — the roles that change figures and
   grant access — and set an idle timeout.
3. Build the membership screen. The policies and grants exist; adding a person
   is still a SQL insert, which is how the wrong role gets granted.
4. Decide where documents live and how their permissions track row permissions.
5. Carry the security headers to whatever host is chosen — `netlify.toml` has
   them, and a different host will not.
6. Enforce `vehicle_ids` in the database. The permission check honours a
   membership narrowed to certain vehicles; no policy does yet, so treat it as
   an interface convenience rather than a boundary.
7. Have someone who did not write it review the RLS policies. Policies are easy
   to write and easy to get subtly wrong, and the failure is silent.
