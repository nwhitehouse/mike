-- feat-024 — RAG chat across all docs in a tabular review.
--
-- Document chunks + their embeddings, used by the tabular-review chat
-- to answer questions whose answers aren't represented by any column
-- (e.g. "which contracts have a most-favoured-nation clause?" when
-- there's no MFN column). Mirrors the work___ pattern, ported to
-- Postgres' pgvector.
--
-- Embedding model: OpenAI text-embedding-3-small (1536 dimensions,
-- ~$0.02 per 1M tokens). Picked over -large for storage + cost; the
-- accuracy delta on legal text is small enough that the savings win
-- at the scale of a 200+ doc review.

create extension if not exists vector;

create table if not exists public.document_chunks (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents(id) on delete cascade,
  -- Position in the doc, 0-based. Mostly for debugging / replay.
  chunk_index int not null,
  -- Page span this chunk covers. Pulled from the "## Page N" headings
  -- the existing extractPdfMarkdown already emits. Both nullable for
  -- non-PDF or single-page-document corner cases.
  page_start int,
  page_end int,
  content text not null,
  embedding vector(1536) not null,
  created_at timestamptz not null default now(),
  unique (document_id, chunk_index)
);

-- HNSW for kNN cosine search. m=16 / ef_construction=64 are the pgvector
-- defaults; tune if/when we observe recall problems on large reviews.
create index if not exists idx_document_chunks_embedding
  on public.document_chunks
  using hnsw (embedding vector_cosine_ops);

-- Lookup-by-doc index for cascade deletes + the "which docs already have
-- chunks" backfill query.
create index if not exists idx_document_chunks_document
  on public.document_chunks(document_id);

alter table public.document_chunks enable row level security;

-- Same access predicate as everything else doc-related — anyone who can
-- access the document can read its chunks. Inserts come from the backend
-- (service_role bypasses RLS); the symmetric insert policy keeps the
-- shape consistent with chat_messages, agent_events, tabular_*.
-- DROP-then-CREATE so the migration is idempotent on environments where
-- earlier policy CREATEs partially landed.
drop policy if exists document_chunks_select on public.document_chunks;
create policy document_chunks_select on public.document_chunks
  for select using (public.can_access_document(document_id));
drop policy if exists document_chunks_insert on public.document_chunks;
create policy document_chunks_insert on public.document_chunks
  for insert with check (public.can_access_document(document_id));
drop policy if exists document_chunks_delete on public.document_chunks;
create policy document_chunks_delete on public.document_chunks
  for delete using (public.can_access_document(document_id));

comment on table public.document_chunks is
  'feat-024 — chunked document text + OpenAI text-embedding-3-small embeddings (1536-dim). Used by tabular-review RAG chat to retrieve relevant passages across an entire review.';
comment on column public.document_chunks.embedding is
  'OpenAI text-embedding-3-small, 1536 dim, cosine similarity.';

-- feat-024 — kNN search RPC. The supabase JS client can't quite express
-- a `vector(1536)` parameter inline, so the route handler passes the
-- query embedding as a stringified literal ("[v0,v1,...]") and we cast
-- inside. RLS still applies on the SELECT — this function runs as
-- SECURITY INVOKER so the caller's auth bounds the visible rows.
create or replace function public.rag_search_chunks(
  document_ids uuid[],
  query_embedding text,
  match_count int default 12
)
returns table (
  id uuid,
  document_id uuid,
  chunk_index int,
  page_start int,
  page_end int,
  content text,
  distance real
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    dc.id,
    dc.document_id,
    dc.chunk_index,
    dc.page_start,
    dc.page_end,
    dc.content,
    (dc.embedding <=> query_embedding::vector)::real as distance
  from public.document_chunks dc
  where dc.document_id = any(document_ids)
  order by dc.embedding <=> query_embedding::vector
  limit match_count;
$$;

comment on function public.rag_search_chunks is
  'feat-024 — cosine kNN over document_chunks scoped to a doc set. Wrapped in an RPC because the supabase JS client cannot bind vector(1536) parameters directly.';
