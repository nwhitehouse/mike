-- feat-024 — generalise the bug-007 worker pool so it can dispatch on
-- multiple job types instead of being tabular_generate-only. Adds a
-- job_type discriminator with a default that keeps existing rows valid.
--
-- The two job_type values used so far:
--   tabular_generate — bug-007 — produces tabular_cells from per-doc LLM calls
--   embed_document   — feat-024 — chunks a doc + writes embeddings to document_chunks
--
-- Adding a column to a table referenced by an in-flight job-pool query
-- is safe because the worker selects by status, not job_type. Older
-- rows pick up the default (tabular_generate) which is correct.

alter table public.tabular_jobs
  add column if not exists job_type text not null default 'tabular_generate';

-- embed_document jobs are scoped to a specific document, not a review,
-- so review_id may not apply. Drop the not-null on review_id; rows
-- where review_id IS NULL are valid for embed_document and (by
-- convention) only for that job_type.
alter table public.tabular_jobs alter column review_id drop not null;

-- Helpful index when the worker grows past two job types and we want
-- to query "all the embedding jobs from the last 24h" etc.
create index if not exists idx_tabular_jobs_type
  on public.tabular_jobs(job_type, created_at desc);

comment on column public.tabular_jobs.job_type is
  'Discriminator for the worker pool dispatcher. Currently: tabular_generate (bug-007) | embed_document (feat-024).';
