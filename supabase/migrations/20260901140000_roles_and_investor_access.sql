/*
  # Roles, superusers and investor-scoped access

  Replaces the three-role model (viewer / editor / owner) with the seven the
  application actually needs, adds a platform superuser, and — the substantive
  change — lets a login be bound to one investor so a limited partner sees their
  own capital account and nobody else's.

  ## Why this is a database change and not a UI one

  An investor who can reach the API directly can read any row the policy admits,
  whatever the screen shows them. One investor seeing another's commitment is a
  confidentiality incident, so the restriction has to live here.

  ## Roles

    superuser  every client; administers the platform
    owner      one client, including its membership
    editor     loads documents and files figures
    analyst    reads everything and exports; cannot file a figure
    auditor    reads everything including the audit trail; can never write
    viewer     reads on screen; no export
    investor   one vehicle's reporting and one capital account

  Export is not enforceable in the database — anyone who can select can copy —
  so the viewer/analyst distinction is advisory and enforced in the application.
  Everything else below is a policy.

  ## Changes
    - `platform_admins`: the superuser list, separate from client membership
    - `client_members.role`: widened, with `investor_id` and `vehicle_ids`
    - `created_by` on every fact table, defaulted to the writing user
    - Investor-scoped read policies on `investors` and investor cashflows
    - Write policies narrowed to the roles that may actually write
*/

/* ------------------------------------------------------------------ *
 * Superusers
 *
 * A separate table rather than a role value on client_members: a superuser is
 * not a member of anything, and modelling them as one would mean inserting a
 * row per client and forgetting one when a client is added.
 * ------------------------------------------------------------------ */

create table if not exists platform_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  granted_at timestamptz not null default now(),
  granted_by uuid references auth.users(id),
  note text
);

alter table platform_admins enable row level security;

create or replace function is_superuser()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from platform_admins where user_id = auth.uid());
$$;

-- Superusers see the list; nobody else learns who they are.
drop policy if exists "Superusers read the admin list" on platform_admins;
create policy "Superusers read the admin list" on platform_admins
  for select to authenticated using (is_superuser());

/* ------------------------------------------------------------------ *
 * Membership
 * ------------------------------------------------------------------ */

alter table client_members
  drop constraint if exists client_members_role_check;

alter table client_members
  add constraint client_members_role_check
  check (role in ('owner', 'editor', 'analyst', 'auditor', 'viewer', 'investor'));

alter table client_members
  add column if not exists investor_id uuid references investors(id) on delete cascade,
  add column if not exists vehicle_ids uuid[],
  add column if not exists created_at_ts timestamptz not null default now();

/*
  An investor membership without an investor grants access to a vehicle with no
  account to look at, and — worse — would fall through the investor filter below
  into seeing everyone. Rejecting it here is the difference between a
  misconfiguration and a disclosure.
*/
alter table client_members
  drop constraint if exists investor_membership_needs_investor;

alter table client_members
  add constraint investor_membership_needs_investor
  check (role <> 'investor' or investor_id is not null);

/* ------------------------------------------------------------------ *
 * Capability helpers
 *
 * One function per question the policies ask, so a rule change happens in one
 * place rather than in fifteen policy bodies.
 * ------------------------------------------------------------------ */

create or replace function role_on_client(target uuid)
returns text language sql stable security definer set search_path = public as $$
  select case
    when is_superuser() then 'superuser'
    else (
      select role from client_members
      where client_id = target and user_id = auth.uid()
      -- Most privileged wins if a user somehow holds two memberships.
      order by array_position(
        array['owner', 'editor', 'analyst', 'auditor', 'viewer', 'investor'], role)
      limit 1
    )
  end;
$$;

create or replace function can_read_client(target uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select role_on_client(target) is not null;
$$;

/** Roles that may file a figure. Auditor is excluded by construction. */
create or replace function can_write_client(target uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select role_on_client(target) in ('superuser', 'owner', 'editor');
$$;

/** Roles that may change who has access. */
create or replace function can_administer_client(target uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select role_on_client(target) in ('superuser', 'owner');
$$;

/**
 * The investor this login is bound to on a client, or null when it is bound to
 * none — which is every role except `investor`.
 */
create or replace function bound_investor(target uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select investor_id from client_members
  where client_id = target and user_id = auth.uid() and role = 'investor'
  limit 1;
$$;

/** True when the login may see every investor of the client, not just its own. */
create or replace function can_read_all_investors(target uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select role_on_client(target) in
    ('superuser', 'owner', 'editor', 'analyst', 'auditor', 'viewer');
$$;

create or replace function client_of_investor(target uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select v.client_id
  from investors i join vehicles v on v.id = i.vehicle_id
  where i.id = target;
$$;

/* ------------------------------------------------------------------ *
 * Investor-scoped reads
 *
 * The substantive change. An investor login reads exactly one row of
 * `investors` and only the cashflows attached to it.
 * ------------------------------------------------------------------ */

drop policy if exists "Members read investors" on investors;
create policy "Members read investors" on investors
  for select to authenticated using (
    case
      when can_read_all_investors(client_of_vehicle(vehicle_id)) then true
      -- An investor sees itself and nothing else. `bound_investor` is null for
      -- a membership that is not an investor one, and null = id is never true,
      -- so a misconfigured row denies rather than leaks.
      else id = bound_investor(client_of_vehicle(vehicle_id))
    end
  );

drop policy if exists "Members read cashflows" on cashflows;
create policy "Members read cashflows" on cashflows
  for select to authenticated using (
    can_read_client(client_of_vehicle(vehicle_id))
    and (
      -- Portfolio flows carry no investor and are part of the reporting an
      -- investor receives.
      investor_id is null
      or can_read_all_investors(client_of_vehicle(vehicle_id))
      or investor_id = bound_investor(client_of_vehicle(vehicle_id))
    )
  );

/* ------------------------------------------------------------------ *
 * Writes narrowed to the roles that may write
 * ------------------------------------------------------------------ */

drop policy if exists "Editors write investors" on investors;
create policy "Editors write investors" on investors
  for all to authenticated
  using (can_write_client(client_of_vehicle(vehicle_id)))
  with check (can_write_client(client_of_vehicle(vehicle_id)));

drop policy if exists "Owners update their clients" on clients;
create policy "Owners update their clients" on clients
  for update to authenticated
  using (can_administer_client(id)) with check (can_administer_client(id));

drop policy if exists "Members read their own membership" on client_members;
create policy "Members read their own membership" on client_members
  for select to authenticated
  using (user_id = auth.uid() or can_administer_client(client_id));

-- Membership is managed by the client owner, not by editors.
drop policy if exists "Owners manage membership" on client_members;
create policy "Owners manage membership" on client_members
  for all to authenticated
  using (can_administer_client(client_id))
  with check (can_administer_client(client_id));

/* ------------------------------------------------------------------ *
 * Audit trail
 *
 * The schema already recorded what changed and when. It did not record who,
 * which leaves "who filed this valuation" with no answer — the first question
 * asked when a figure turns out to be wrong.
 *
 * `created_by` defaults to the writing user rather than being supplied by the
 * client, so it cannot be forged by an application that forgets to set it.
 * ------------------------------------------------------------------ */

alter table position_valuations
  add column if not exists created_by uuid references auth.users(id) default auth.uid();
alter table asset_valuations
  add column if not exists created_by uuid references auth.users(id) default auth.uid();
alter table cashflows
  add column if not exists created_by uuid references auth.users(id) default auth.uid();
alter table vehicle_balance_sheets
  add column if not exists created_by uuid references auth.users(id) default auth.uid();
alter table fx_rates
  add column if not exists created_by uuid references auth.users(id) default auth.uid();
alter table esg_metrics
  add column if not exists created_by uuid references auth.users(id) default auth.uid();

/*
  Documents, so a committed figure traces to the file it was read from and to
  the person who accepted it.
*/
create table if not exists source_documents (
  id uuid primary key default uuid_generate_v4(),
  client_id uuid not null references clients(id) on delete cascade,
  kind text not null check (kind in (
    'historical-workbook', 'capital-account-statement', 'transaction-notice',
    'financial-statements', 'nav-pack', 'manual-entry')),
  name text not null,
  mime_type text not null default 'application/octet-stream',
  size_bytes bigint not null default 0,
  -- SHA-256. Proves years later that the file on the shared drive is the one
  -- the figures were read from.
  content_hash text not null,
  storage_ref text,
  period text check (period ~ '^\d{4}Q[1-4]$'),
  uploaded_at timestamptz not null default now(),
  uploaded_by uuid references auth.users(id) default auth.uid(),
  status text not null default 'uploaded'
    check (status in ('uploaded', 'extracted', 'in-review', 'committed', 'rejected')),
  note text
);

create index if not exists idx_source_documents_client
  on source_documents(client_id, period, uploaded_at desc);
create index if not exists idx_source_documents_hash
  on source_documents(client_id, content_hash);

alter table source_documents enable row level security;

-- Guarded so the migration can be re-applied without a manual teardown.
drop policy if exists "Members read documents" on source_documents;
create policy "Members read documents" on source_documents
  for select to authenticated using (can_read_client(client_id));

drop policy if exists "Editors insert documents" on source_documents;
create policy "Editors insert documents" on source_documents
  for insert to authenticated with check (can_write_client(client_id));

drop policy if exists "Editors update document status" on source_documents;
create policy "Editors update document status" on source_documents
  for update to authenticated
  using (can_write_client(client_id)) with check (can_write_client(client_id));

-- Link a filed figure to the document it came from.
alter table position_valuations
  add column if not exists document_id uuid references source_documents(id);
alter table cashflows
  add column if not exists document_id uuid references source_documents(id);
alter table vehicle_balance_sheets
  add column if not exists document_id uuid references source_documents(id);

/*
  Table grants for the new tables and for membership.

  Row-level security only filters rows a role can already reach; without a grant
  the call fails as a permission error instead. The membership policies above
  are useless without this, and the failure would have looked like a bug in the
  application rather than a missing grant.

  `platform_admins` is deliberately readable but not writable here: a superuser
  is granted out of band, through a migration or the service role, never by
  anyone signed in to the application. A role that can promote itself is not a
  role.
*/
grant select on platform_admins to authenticated;
grant select on source_documents to authenticated;
grant insert, update on source_documents to authenticated;
grant insert, update, delete on client_members to authenticated;
