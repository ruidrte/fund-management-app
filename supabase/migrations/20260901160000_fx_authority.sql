/*
  Where an FX rate came from, and which one wins.

  Rates are pulled from the ECB and then replaced by the rate the
  administrator's financials imply once the trial balance for a quarter is
  received. Both rows stay — the table is append-only, like every other fact
  table here — so the question the schema has to answer is which of them
  applied.

  Recency cannot answer it. Published fixings get corrected and backfilled; if
  the newest row simply won, a correction filed weeks after the financials
  would move a net asset value that had already been signed, and the reported
  figure would stop tying to the administrator's statement it was reconciled
  against. So precedence is by authority first, and only then by recency.

  The engine applies that ordering; this column is what it orders on.
*/

alter table fx_rates
  add column if not exists authority text not null default 'market'
    check (authority in ('market', 'manual', 'administrator'));

-- The financials a rate was taken from, so an override traces to a file.
-- Nullable, and null for every market fixing: an ECB rate has no document.
alter table fx_rates
  add column if not exists document_id uuid references source_documents(id) on delete set null;

comment on column fx_rates.authority is
  'market < manual < administrator. Precedence is by authority first, then recorded_at.';

-- An administrator rate is a claim about a specific set of books. Letting one
-- be filed without naming them would make the override unverifiable, which is
-- the one thing it cannot be.
alter table fx_rates
  drop constraint if exists fx_administrator_has_document;
alter table fx_rates
  add constraint fx_administrator_has_document
    check (authority <> 'administrator' or document_id is not null) not valid;

-- Not validated against existing rows: rates loaded before documents were
-- tracked have no file to point at, and rewriting history to satisfy a
-- constraint would be worse than carrying it forward. New rows are checked.

-- The index the lookup reads. Authority sits ahead of recorded_at for the same
-- reason the engine's sort does.
drop index if exists idx_fx_lookup;
create index if not exists idx_fx_lookup
  on fx_rates(client_id, base, quote, kind, period, authority, recorded_at);
