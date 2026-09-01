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

Roles are `viewer`, `editor`, `owner`. Writes require `editor` or above. Fact
tables accept `INSERT` only — no policy grants `UPDATE` or `DELETE` on a
valuation, a cashflow past draft, a balance sheet, an FX rate or an ESG metric.

### Authentication

A session is required before any client data is requested. Without a backend
configured the application runs on the demo dataset and says so, rather than
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

### Audit trail

The schema records what changed and when (`recorded_at` on every fact) but not
who. `created_by` columns and a trigger-written audit table are a small change
and should be made before the system holds anything a regulator would ask about.
Without it, "who filed this valuation" has no answer.

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

### Transport and headers

HTTPS is assumed but not asserted. A production deployment should add HSTS, a
Content-Security-Policy tight enough to forbid inline script (the application
needs none), `X-Content-Type-Options: nosniff` and a restrictive
`Referrer-Policy`. These belong in the hosting configuration, not the bundle.

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
| Stolen session token | Not addressed — no idle timeout, no MFA |
| Insider exporting everything | Not addressed — no export audit or approval |
| Database-level compromise | Not addressed — no column encryption |
| Who filed a given figure | Not addressed — no `created_by` |

---

## Before real data

In order, because each depends on the last:

1. Decide data residency. It constrains the hosting choice.
2. Add `created_by` and an audit table. Cheap now, invasive later.
3. Enforce MFA for `editor` and `owner`, and set an idle timeout.
4. Decide where documents live and how their permissions track row permissions.
5. Set the security headers in the hosting configuration.
6. Have someone who did not write it review the RLS policies. Policies are easy
   to write and easy to get subtly wrong, and the failure is silent.
