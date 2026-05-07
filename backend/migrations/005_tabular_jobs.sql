-- bug-007 — Tabular generate as a durable job + worker-pool pattern.
--
-- Problem: POST /tabular/:reviewId/generate fans out N parallel LLM calls
-- inside the HTTP handler and streams progress over SSE. For N up to a few
-- dozen this works; for the actual product target (~5K–10K-doc tabular
-- projects) it falls over on multiple axes:
--   - vLLM cannot serve N concurrent inference requests at that scale
--   - the request handler ties up an Express worker for hours
--   - the SSE is a single point of failure (proxy idle timeout, browser
--     tab close, backend restart all kill the run with no recovery)
--   - any partial progress is lost on a backend restart mid-run
--
-- Solution: durable job table + in-process worker pool. The HTTP request
-- creates a job + N items and returns immediately. Background workers
-- claim items atomically (FOR UPDATE SKIP LOCKED) with a 5-minute lease,
-- process them, and update status. Frontend polls instead of streaming.
-- Resume-on-restart is automatic because the next worker scan picks up
-- 'pending' items + 'running' items whose lease has expired.

create table if not exists public.tabular_jobs (
  id uuid primary key default gen_random_uuid(),
  review_id uuid not null references public.tabular_reviews(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  status text not null
    check (status in ('pending', 'running', 'completed', 'failed', 'cancelled')),
  total_items int not null default 0,
  completed_items int not null default 0,
  error_items int not null default 0,
  started_at timestamptz,
  completed_at timestamptz,
  cancel_requested_at timestamptz,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_tabular_jobs_review_created
  on public.tabular_jobs(review_id, created_at desc);

-- Partial index used by GET /tabular/reviews/:reviewId/active-job to find
-- the currently in-flight job (if any) for a review on page reload.
create index if not exists idx_tabular_jobs_active
  on public.tabular_jobs(review_id, created_at desc)
  where status in ('pending', 'running');

create table if not exists public.tabular_job_items (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.tabular_jobs(id) on delete cascade,
  -- NOT a foreign key on purpose. Documents may be deleted between
  -- job creation and processing, but we still want to keep the historical
  -- record of what the job tried to do.
  document_id uuid not null,
  status text not null
    check (status in ('pending', 'running', 'completed', 'error', 'skipped')),
  attempt_count int not null default 0,
  -- Set by a worker when it claims the item; cleared when the work
  -- finishes. Workers reclaim 'running' items whose lease has expired —
  -- that's how a crashed/restarted worker's items get retried automatically.
  lease_expires_at timestamptz,
  error text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_tabular_job_items_job
  on public.tabular_job_items(job_id);

-- The worker claim query reads from this index. Partial because most rows
-- end up 'completed'/'error' and we never look at them again — only the
-- in-flight ones matter for dispatch.
create index if not exists idx_tabular_job_items_pickable
  on public.tabular_job_items(created_at)
  where status in ('pending', 'running');

create index if not exists idx_tabular_job_items_job_completed_at
  on public.tabular_job_items(job_id, completed_at desc nulls last)
  where status in ('completed', 'error', 'skipped');

alter table public.tabular_jobs enable row level security;
alter table public.tabular_job_items enable row level security;

-- RLS reuses the can_access_review predicate so the job audit follows the
-- same access rules as the review itself. The worker pool runs as
-- service_role and bypasses RLS — these policies gate frontend reads.
create policy tabular_jobs_select on public.tabular_jobs
  for select using (public.can_access_review(review_id));

create policy tabular_jobs_insert on public.tabular_jobs
  for insert with check (public.can_access_review(review_id));

create policy tabular_jobs_update on public.tabular_jobs
  for update using (public.can_access_review(review_id))
  with check (public.can_access_review(review_id));

create policy tabular_job_items_select on public.tabular_job_items
  for select using (
    exists (
      select 1 from public.tabular_jobs j
      where j.id = job_id and public.can_access_review(j.review_id)
    )
  );

-- Inserts/updates on items only happen from the backend (service_role) —
-- frontend never writes here directly. Symmetric SELECT policy for clarity.
create policy tabular_job_items_insert on public.tabular_job_items
  for insert with check (
    exists (
      select 1 from public.tabular_jobs j
      where j.id = job_id and public.can_access_review(j.review_id)
    )
  );

create policy tabular_job_items_update on public.tabular_job_items
  for update using (
    exists (
      select 1 from public.tabular_jobs j
      where j.id = job_id and public.can_access_review(j.review_id)
    )
  )
  with check (
    exists (
      select 1 from public.tabular_jobs j
      where j.id = job_id and public.can_access_review(j.review_id)
    )
  );

-- bug-007 — atomic claim helper. Wraps the FOR UPDATE SKIP LOCKED select
-- and the lease-extending update in a single SQL statement, callable via
-- supabase.rpc('claim_tabular_job_item', ...). Returns the claimed row, or
-- nothing when no work is available.
--
-- Picks 'pending' items, plus 'running' items whose lease expired (worker
-- crashed / restarted / OOM). Within those, oldest created_at wins so a
-- single job doesn't starve waiting on items from a later job.
--
-- SKIP LOCKED ensures multiple workers — within one Express instance OR
-- across multiple instances if the backend ever scales past one — never
-- claim the same item.
create or replace function public.claim_tabular_job_item(
  lease_seconds int default 300
)
returns table (
  id uuid,
  job_id uuid,
  document_id uuid,
  status text,
  attempt_count int,
  lease_expires_at timestamptz,
  created_at timestamptz
)
language sql
volatile
security definer
set search_path = public
as $$
  update public.tabular_job_items it
  set
    status = 'running',
    attempt_count = it.attempt_count + 1,
    started_at = coalesce(it.started_at, now()),
    lease_expires_at = now() + (lease_seconds || ' seconds')::interval
  where it.id = (
    select inner_it.id
    from public.tabular_job_items inner_it
    where inner_it.status = 'pending'
       or (inner_it.status = 'running' and inner_it.lease_expires_at < now())
    order by inner_it.created_at
    limit 1
    for update skip locked
  )
  returning
    it.id, it.job_id, it.document_id, it.status,
    it.attempt_count, it.lease_expires_at, it.created_at;
$$;

comment on function public.claim_tabular_job_item is
  'bug-007 — atomic worker-pool claim. SKIP LOCKED ensures no two workers grab the same item. Returns nothing when no work is available.';

comment on table public.tabular_jobs is
  'bug-007 — durable representation of a /tabular/:reviewId/generate run. Replaces the SSE-based handler with a job + worker-pool pattern that survives backend restart, browser tab close, proxy idle timeout.';
comment on table public.tabular_job_items is
  'bug-007 — one row per (job, document) work unit. Workers claim with claim_tabular_job_item() and 5-minute leases.';
