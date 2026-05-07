-- feat-023 — Tabular filtering. Adds a per-cell "verified" state so the
-- review filter can hide cells the user has already eyeballed and confirmed.
-- Binary state for v1; no audit trail beyond who/when last toggled it.
--
-- All three columns are nullable / default-friendly so the migration is
-- safe against the live tabular_cells data (47 rows in prod at time of
-- writing).

alter table public.tabular_cells
  add column if not exists verified boolean not null default false,
  add column if not exists verified_at timestamptz,
  add column if not exists verified_by uuid references auth.users(id) on delete set null;

comment on column public.tabular_cells.verified is
  'feat-023 — true once a reviewer has manually confirmed the cell value. Used by the filter "Verified state" predicate.';
comment on column public.tabular_cells.verified_at is
  'When the cell was last toggled to verified. Cleared on toggle-off.';
comment on column public.tabular_cells.verified_by is
  'Who toggled the cell to verified. NULL when unverified.';
