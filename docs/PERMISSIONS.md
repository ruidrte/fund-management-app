# Permissions

Seven roles, twelve capabilities, one matrix. The matrix lives in
`src/auth/permissions.ts` and is rendered on the Access page, so it can be read
without reading the code.

## The rule that governs the design

**The database is the boundary; the interface is the explanation.** Every
capability below has a matching row-level-security policy. Nothing is protected
by hiding a button — the interface exists so that what it offers matches what
the database will already allow, and so a refusal comes with a reason instead of
a dead control.

## Roles

| Role | What it is for |
|---|---|
| `superuser` | Every client on the platform, and membership management. Administers the system; not a reporting role. |
| `owner` | Full control of one client, including who else may reach it. |
| `editor` | Loads documents and files figures. The role that changes what the reports say. |
| `analyst` | Reads everything of a client and takes it away — reports and extracts — but cannot file a figure. |
| `auditor` | Reads everything including who filed what and when. Can never write, by construction. |
| `viewer` | Reads on screen. No export. |
| `investor` | The vehicle they are invested in, and their own capital account. Never another investor's. |

## Capabilities

| Capability | superuser | owner | editor | analyst | auditor | viewer | investor |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| Open the client | ● | ● | ● | ● | ● | ● | ● |
| Change client settings | ● | ● | | | | | |
| Grant and revoke access | ● | ● | | | | | |
| See the holding register | ● | ● | ● | ● | ● | ● | ● |
| **See every capital account** | ● | ● | ● | ● | ● | ● | |
| See own capital account | ● | ● | ● | ● | ● | ● | ● |
| Load documents | ● | ● | ● | ● | | | |
| **File figures** | ● | ● | ● | | | | |
| Generate reports | ● | ● | ● | ● | ● | ● | ● |
| **Export the history** | ● | ● | ● | ● | ● | | |
| Coverage and controls | ● | ● | ● | ● | ● | ● | |
| Sustainability metrics | ● | ● | ● | ● | ● | ● | |

## Three distinctions worth defending

**Seeing every capital account is the confidentiality line.** One investor
learning another's commitment is an incident, not a preference. So
`investors.read.all` and `investors.read.own` are separate capabilities, an
investor login is bound to exactly one investor row by a check constraint, and
the restriction is a database policy rather than a filtered screen.

An investor *does* hold `portfolio.read`. A limited partner receives the
portfolio listing in their quarterly report, so withholding it on screen would
be theatre.

**Export is not a side effect of reading.** Anyone who can read a screen can
copy it by hand; anyone who can export takes the whole history in one click.
A `viewer` reads; an `analyst` exports.

**The auditor cannot write, by construction.** Not by convention, not by a UI
that omits the button: `can_write_client()` does not include the role, so the
database refuses.

## What a restricted register does to the numbers

An investor login sees one capital account, either because row-level security
filtered the others or because the scope did. The vehicle's size must not then
be inferred from the row that survived — summing the visible register would
give that investor's own commitment, and every multiple built on it would be
several times the real one.

So the fund's total commitment comes from `vehicles.investor_commitment`, and
ownership is taken on commitment against that total. `NetResult.restricted`
marks the condition, and the screens report the investor's own account rather
than presenting fund-level figures as theirs.

## Granting access

Today this is a SQL insert:

```sql
insert into client_members (client_id, user_id, role) values (…, …, 'analyst');

-- An investor must be bound to an account. A membership without one is rejected.
insert into client_members (client_id, user_id, role, investor_id)
values (…, …, 'investor', …);
```

Superusers are granted out of band, never from the application:

```sql
insert into platform_admins (user_id) values (…);
```

## Not built

- **A membership screen.** Policies and grants exist; the interface does not.
- **`vehicle_ids` in the database.** The permission check honours a membership
  narrowed to named vehicles; no policy enforces it yet, so it is an interface
  convenience rather than a boundary.
- **Export auditing.** Who took what, and when.
- **MFA.** Should be mandatory for `owner` and `editor`.
