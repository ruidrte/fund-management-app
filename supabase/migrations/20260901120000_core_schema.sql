/*
  # Core reporting schema

  The shape the application reads: a client owns vehicles, a vehicle holds
  positions, a position holds assets, and investors hold the vehicle.

  Two things govern the fact tables and are worth stating plainly, because
  reversing either later is expensive:

  1. Facts are bitemporal. Every observation records both the period it
     describes and the instant it was learned (`recorded_at`). Filtering on
     `recorded_at <= t` reproduces exactly what could have been reported at t.
     Rows are therefore never updated in place and never deleted — a
     restatement is a new row, and the original stays so a published quarter
     stays reproducible.

  2. The client is the tenant boundary. Every table reaches a client, and row
     level security is enforced through that path on every one of them.

  ## Tables
    - clients, vehicles, positions, assets, investors      reference data
    - position_valuations, asset_valuations                what things are worth
    - cashflows                                            what moved
    - vehicle_balance_sheets                               vehicle-level items
    - fx_rates                                             currency treatment
    - esg_metrics                                          sustainability
    - client_members                                       who may see what

  ## Security
    - RLS enabled on every table
    - Access is granted through membership of the owning client
    - Writes require the `editor` or `owner` role on that client
*/

create extension if not exists "uuid-ossp";

/* ------------------------------------------------------------------ *
 * Reference data
 * ------------------------------------------------------------------ */

create table if not exists clients (
  id uuid primary key default uuid_generate_v4(),
  name text not null,
  short_name text not null,
  reporting_currency text not null default 'EUR',
  conventions jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

/* Who may see a client, and whether they may write. */
create table if not exists client_members (
  client_id uuid not null references clients(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'viewer' check (role in ('viewer', 'editor', 'owner')),
  created_at timestamptz not null default now(),
  primary key (client_id, user_id)
);

create table if not exists vehicles (
  id uuid primary key default uuid_generate_v4(),
  client_id uuid not null references clients(id) on delete cascade,
  kind text not null check (kind in ('fund-of-funds', 'direct-fund')),
  name text not null,
  short_name text not null,
  currency text not null,
  inception_date date not null,
  investor_commitment numeric not null default 0,
  manager text,
  administrator text,
  domicile text,
  status text not null default 'Investing'
    check (status in ('Fundraising', 'Investing', 'Harvesting', 'Liquidating', 'Closed')),
  conventions jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists positions (
  id uuid primary key default uuid_generate_v4(),
  vehicle_id uuid not null references vehicles(id) on delete cascade,
  kind text not null check (kind in ('fund', 'direct-investment', 'co-investment', 'secondary')),
  name text not null,
  manager text,
  currency text not null,
  vintage integer not null,
  commitment_date date not null,
  investment_period_end date,
  commitment numeric not null default 0,
  -- Fraction, not a percentage. Stored 0..1 so no call site has to guess.
  ownership numeric not null default 0 check (ownership >= 0 and ownership <= 1),
  asset_class text not null,
  sub_asset_class text,
  region text not null,
  sector text,
  strategy text,
  status text not null default 'Investing'
    check (status in ('Committed', 'Investing', 'Harvesting', 'Realised', 'Written Off')),
  -- Set when the position stops reporting; excluded from coverage thereafter.
  terminated_period text,
  esg jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists assets (
  id uuid primary key default uuid_generate_v4(),
  position_id uuid not null references positions(id) on delete cascade,
  name text not null,
  currency text not null,
  investment_date date not null,
  ownership numeric not null default 0 check (ownership >= 0 and ownership <= 1),
  asset_class text not null,
  sub_asset_class text,
  -- A single label, or a weighted split summing to 1.
  sector jsonb not null default '"Unclassified"'::jsonb,
  region jsonb not null default '"Unclassified"'::jsonb,
  country jsonb not null default '"Unclassified"'::jsonb,
  status text not null default 'Held'
    check (status in ('Held', 'Partially Realised', 'Realised', 'Written Off')),
  esg jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists investors (
  id uuid primary key default uuid_generate_v4(),
  vehicle_id uuid not null references vehicles(id) on delete cascade,
  name text not null,
  type text not null check (type in ('Individual', 'Institution', 'Family Office', 'Feeder', 'Seed')),
  country text,
  currency text not null,
  commitment numeric not null default 0,
  share_class text,
  entry_date date not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

/* ------------------------------------------------------------------ *
 * Fact tables — append only
 *
 * `period` is the sortable `YYYYQn` form. `recorded_at` is when the figure
 * entered the system, and is what point-in-time queries filter on.
 * ------------------------------------------------------------------ */

create table if not exists position_valuations (
  id uuid primary key default uuid_generate_v4(),
  position_id uuid not null references positions(id) on delete cascade,
  period text not null check (period ~ '^\d{4}Q[1-4]$'),
  recorded_at timestamptz not null default now(),
  nav numeric not null,
  drawn_cumulative numeric,
  distributed_cumulative numeric,
  recallable_cumulative numeric,
  source text not null,
  -- Set on a row a later filing replaced. The row itself is never deleted, so a
  -- report issued before the restatement can still be reproduced exactly.
  superseded_by text
);

create table if not exists asset_valuations (
  id uuid primary key default uuid_generate_v4(),
  asset_id uuid not null references assets(id) on delete cascade,
  period text not null check (period ~ '^\d{4}Q[1-4]$'),
  recorded_at timestamptz not null default now(),
  invested numeric not null default 0,
  realised numeric not null default 0,
  unrealised numeric not null default 0,
  source text not null
);

create table if not exists cashflows (
  id uuid primary key default uuid_generate_v4(),
  vehicle_id uuid not null references vehicles(id) on delete cascade,
  -- Exactly one of these is set: a portfolio flow, or an investor flow.
  position_id uuid references positions(id) on delete cascade,
  investor_id uuid references investors(id) on delete cascade,
  type text not null check (type in (
    'Commitment', 'Capital Call', 'Distribution', 'Return of Capital',
    'Equalisation', 'Fee', 'Expense', 'Income')),
  -- Signed from the vehicle's perspective: money out negative, money in positive.
  amount numeric not null,
  currency text not null,
  date date not null,
  period text not null check (period ~ '^\d{4}Q[1-4]$'),
  recorded_at timestamptz not null default now(),
  affects_commitment boolean not null default false,
  recallable boolean,
  description text,
  status text not null default 'Settled' check (status in ('Draft', 'Confirmed', 'Settled')),
  constraint cashflow_has_one_counterparty
    check (num_nonnulls(position_id, investor_id) <= 1)
);

create table if not exists vehicle_balance_sheets (
  id uuid primary key default uuid_generate_v4(),
  vehicle_id uuid not null references vehicles(id) on delete cascade,
  period text not null check (period ~ '^\d{4}Q[1-4]$'),
  recorded_at timestamptz not null default now(),
  cash numeric not null default 0,
  other_assets numeric not null default 0,
  current_liabilities numeric not null default 0,
  accrued_expenses numeric not null default 0,
  source text not null
);

create table if not exists fx_rates (
  id uuid primary key default uuid_generate_v4(),
  client_id uuid not null references clients(id) on delete cascade,
  -- Quoted as 1 base = rate quote. One direction only; the engine inverts.
  base text not null,
  quote text not null,
  rate numeric not null check (rate > 0),
  date date not null,
  period text not null check (period ~ '^\d{4}Q[1-4]$'),
  recorded_at timestamptz not null default now(),
  kind text not null default 'closing' check (kind in ('closing', 'average')),
  source text not null,
  constraint fx_pair_differs check (base <> quote)
);

create table if not exists esg_metrics (
  id uuid primary key default uuid_generate_v4(),
  client_id uuid not null references clients(id) on delete cascade,
  scope_kind text not null check (scope_kind in ('vehicle', 'position', 'asset')),
  scope_id uuid not null,
  period text not null check (period ~ '^\d{4}Q[1-4]$'),
  recorded_at timestamptz not null default now(),
  metric text not null,
  value numeric not null,
  unit text not null,
  -- Fraction of the scope the metric actually covers. A carbon figure over a
  -- third of a portfolio is a different claim from one over all of it.
  coverage numeric check (coverage >= 0 and coverage <= 1),
  source text not null
);

/* ------------------------------------------------------------------ *
 * Indexes
 *
 * Every read is "rows for these parents, for this period, known by then", so
 * the fact tables are indexed on exactly that.
 * ------------------------------------------------------------------ */

create index if not exists idx_vehicles_client on vehicles(client_id);
create index if not exists idx_positions_vehicle on positions(vehicle_id);
create index if not exists idx_assets_position on assets(position_id);
create index if not exists idx_investors_vehicle on investors(vehicle_id);
create index if not exists idx_client_members_user on client_members(user_id);

create index if not exists idx_position_valuations_lookup
  on position_valuations(position_id, period, recorded_at desc);
create index if not exists idx_asset_valuations_lookup
  on asset_valuations(asset_id, period, recorded_at desc);
create index if not exists idx_cashflows_vehicle on cashflows(vehicle_id, period, recorded_at);
create index if not exists idx_cashflows_position on cashflows(position_id, period) where position_id is not null;
create index if not exists idx_cashflows_investor on cashflows(investor_id, period) where investor_id is not null;
create index if not exists idx_balance_sheets_lookup
  on vehicle_balance_sheets(vehicle_id, period, recorded_at desc);
create index if not exists idx_fx_lookup on fx_rates(client_id, base, quote, kind, period);
create index if not exists idx_esg_lookup on esg_metrics(client_id, period, scope_kind, scope_id);

/* ------------------------------------------------------------------ *
 * Row level security
 *
 * Membership of the owning client is the only way in, on every table. The
 * helper functions keep the policies readable and, more importantly, keep the
 * membership rule in one place rather than restated fifteen times.
 * ------------------------------------------------------------------ */

create or replace function can_read_client(target uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from client_members
    where client_members.client_id = target
      and client_members.user_id = auth.uid()
  );
$$;

create or replace function can_write_client(target uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from client_members
    where client_members.client_id = target
      and client_members.user_id = auth.uid()
      and client_members.role in ('editor', 'owner')
  );
$$;

create or replace function client_of_vehicle(target uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select client_id from vehicles where id = target;
$$;

create or replace function client_of_position(target uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select v.client_id from positions p join vehicles v on v.id = p.vehicle_id where p.id = target;
$$;

create or replace function client_of_asset(target uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select v.client_id
  from assets a
  join positions p on p.id = a.position_id
  join vehicles v on v.id = p.vehicle_id
  where a.id = target;
$$;

alter table clients enable row level security;
alter table client_members enable row level security;
alter table vehicles enable row level security;
alter table positions enable row level security;
alter table assets enable row level security;
alter table investors enable row level security;
alter table position_valuations enable row level security;
alter table asset_valuations enable row level security;
alter table cashflows enable row level security;
alter table vehicle_balance_sheets enable row level security;
alter table fx_rates enable row level security;
alter table esg_metrics enable row level security;

create policy "Members read their clients" on clients
  for select to authenticated using (can_read_client(id));
create policy "Owners update their clients" on clients
  for update to authenticated using (can_write_client(id)) with check (can_write_client(id));

create policy "Members read their own membership" on client_members
  for select to authenticated using (user_id = auth.uid() or can_write_client(client_id));

create policy "Members read vehicles" on vehicles
  for select to authenticated using (can_read_client(client_id));
create policy "Editors write vehicles" on vehicles
  for all to authenticated using (can_write_client(client_id)) with check (can_write_client(client_id));

create policy "Members read positions" on positions
  for select to authenticated using (can_read_client(client_of_vehicle(vehicle_id)));
create policy "Editors write positions" on positions
  for all to authenticated
  using (can_write_client(client_of_vehicle(vehicle_id)))
  with check (can_write_client(client_of_vehicle(vehicle_id)));

create policy "Members read assets" on assets
  for select to authenticated using (can_read_client(client_of_position(position_id)));
create policy "Editors write assets" on assets
  for all to authenticated
  using (can_write_client(client_of_position(position_id)))
  with check (can_write_client(client_of_position(position_id)));

create policy "Members read investors" on investors
  for select to authenticated using (can_read_client(client_of_vehicle(vehicle_id)));
create policy "Editors write investors" on investors
  for all to authenticated
  using (can_write_client(client_of_vehicle(vehicle_id)))
  with check (can_write_client(client_of_vehicle(vehicle_id)));

create policy "Members read position valuations" on position_valuations
  for select to authenticated using (can_read_client(client_of_position(position_id)));
-- Insert only. A restatement is a new row; the original must survive so a
-- report issued before it can still be reproduced.
create policy "Editors insert position valuations" on position_valuations
  for insert to authenticated with check (can_write_client(client_of_position(position_id)));

create policy "Members read asset valuations" on asset_valuations
  for select to authenticated using (can_read_client(client_of_asset(asset_id)));
create policy "Editors insert asset valuations" on asset_valuations
  for insert to authenticated with check (can_write_client(client_of_asset(asset_id)));

create policy "Members read cashflows" on cashflows
  for select to authenticated using (can_read_client(client_of_vehicle(vehicle_id)));
create policy "Editors insert cashflows" on cashflows
  for insert to authenticated with check (can_write_client(client_of_vehicle(vehicle_id)));
-- A draft cashflow may still be corrected; a settled one is superseded, not edited.
create policy "Editors update draft cashflows" on cashflows
  for update to authenticated
  using (can_write_client(client_of_vehicle(vehicle_id)) and status = 'Draft')
  with check (can_write_client(client_of_vehicle(vehicle_id)));

create policy "Members read balance sheets" on vehicle_balance_sheets
  for select to authenticated using (can_read_client(client_of_vehicle(vehicle_id)));
create policy "Editors insert balance sheets" on vehicle_balance_sheets
  for insert to authenticated with check (can_write_client(client_of_vehicle(vehicle_id)));

create policy "Members read fx rates" on fx_rates
  for select to authenticated using (can_read_client(client_id));
create policy "Editors insert fx rates" on fx_rates
  for insert to authenticated with check (can_write_client(client_id));

create policy "Members read esg metrics" on esg_metrics
  for select to authenticated using (can_read_client(client_id));
create policy "Editors insert esg metrics" on esg_metrics
  for insert to authenticated with check (can_write_client(client_id));

/*
  Table privileges are granted explicitly rather than left to default
  privileges. Row level security only filters rows a role can already reach; a
  missing grant fails as a permission error rather than an empty result, which
  is a confusing way to discover the schema was deployed differently from how
  it was tested.
*/
grant usage on schema public to authenticated;
grant select on all tables in schema public to authenticated;
grant insert, update on
  clients, vehicles, positions, assets, investors,
  position_valuations, asset_valuations, cashflows,
  vehicle_balance_sheets, fx_rates, esg_metrics
  to authenticated;

/* ------------------------------------------------------------------ *
 * Timestamps
 * ------------------------------------------------------------------ */

create or replace function touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

do $$
declare t text;
begin
  foreach t in array array['clients','vehicles','positions','assets','investors'] loop
    execute format(
      'drop trigger if exists touch_%1$s on %1$s; '
      'create trigger touch_%1$s before update on %1$s '
      'for each row execute function touch_updated_at();', t);
  end loop;
end $$;
