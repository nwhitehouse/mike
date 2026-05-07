-- feat-015 — Structured agent audit log. Replaces the 60+ console.log
-- calls scattered across chatTools.ts and llm/olava.ts as the only debug
-- trail for what an agent did during a chat turn. With this table you can
-- query `select * from agent_events where chat_id = ? order by created_at`
-- and reconstruct the agent's path: when each tool fired, how long it took,
-- whether it succeeded, when the loop controller (feat-014) escalated.
--
-- Append-only. Fire-and-forget — a failed insert must never break a chat.
-- No PII in payload by default (no user prompts, no doc text); just
-- metadata (tool names, latencies, error codes). Full content lives in
-- chat_messages already.

create table if not exists public.agent_events (
  id uuid primary key default gen_random_uuid(),
  chat_id uuid not null references public.chats(id) on delete cascade,
  type text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_agent_events_chat_created
  on public.agent_events(chat_id, created_at);

alter table public.agent_events enable row level security;

-- Reuse the same predicate as chat_messages — anyone who can see the chat
-- can see its audit trail. Inserts come from the backend (service_role
-- bypasses RLS) so the insert policy is symmetric with select for clarity
-- when developing against the anon key.
create policy agent_events_select on public.agent_events
  for select using (public.can_access_chat(chat_id));
create policy agent_events_insert on public.agent_events
  for insert with check (public.can_access_chat(chat_id));

comment on table public.agent_events is
  'feat-015 — structured audit log of agent activity per chat turn. Append-only, fire-and-forget from the backend.';
comment on column public.agent_events.type is
  'event taxonomy: turn.started, model.first_token, tool.call_started, tool.call_succeeded, tool.call_failed, loop.escalated (feat-014), turn.completed';
comment on column public.agent_events.payload is
  'metadata only — tool names, latencies, error codes, step counts. NEVER user prompts, doc text, or other content (chat_messages already holds that).';
