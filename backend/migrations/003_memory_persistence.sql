-- feat-017 — In-chat memory: persist tool calls + tool results so subsequent
-- turns of the same conversation can replay them to the LLM. Today
-- chat_messages stores only role='user' and role='assistant' rows, and the
-- assistant content column holds an `events[]` array (used by the frontend
-- for display) that does NOT include the model's `<tool_call>` markup. As a
-- result, every new turn the LLM has no memory of what tools it called or
-- what they returned, so it re-reads documents and re-answers from scratch
-- (see chatTools.ts:730 for the system-prompt warning that admits this).
--
-- This migration is additive only — all new columns are nullable so existing
-- rows remain valid.
--
-- Apply: paste into the Supabase SQL editor, OR run via supabase CLI.
-- Take a snapshot first (SECURITY_HARDENING.md established the pattern).

-- 1. Allow role='tool' rows alongside 'user' and 'assistant'.
--    chat_messages.role has no CHECK constraint today (000_one_shot_schema.sql:248
--    `role text not null`), so no constraint to drop. Document the expectation
--    in a comment for future readers.
comment on column public.chat_messages.role is
  'one of user | assistant | tool — tool rows carry the result returned to the LLM after a tool call. Persisted by feat-017 to enable in-chat memory replay.';

-- 2. Tool-row metadata. Nullable for non-tool rows.
alter table public.chat_messages
  add column if not exists tool_call_id text,
  add column if not exists tool_name text;

create index if not exists idx_chat_messages_tool_call_id
  on public.chat_messages(tool_call_id)
  where tool_call_id is not null;

-- 3. Raw model output for assistant rows, including `<tool_call>...</tool_call>`
--    markup. The existing `content` column continues to hold events[] for the
--    frontend display layer; the new `assistant_text` is consumed only by
--    buildMessages() when reconstructing the LLM's view of conversation
--    history. Legacy assistant rows have NULL here — they remain context-blind
--    on replay (acceptable per feat-017 backlog risks section).
alter table public.chat_messages
  add column if not exists assistant_text text;

comment on column public.chat_messages.assistant_text is
  'Raw model output (including <tool_call> markup) for role=assistant rows. Used by feat-017 in-chat memory replay; legacy rows have NULL.';

-- 4. Structured tool calls aggregated from this assistant turn — replayed
--    alongside assistant_text so vLLM/Olava sees the OpenAI-canonical
--    {role:"assistant", tool_calls:[...]} → {role:"tool", tool_call_id} pairing.
--    JSON shape: [{ id: string, type: "function", function: { name, arguments } }, ...]
alter table public.chat_messages
  add column if not exists assistant_tool_calls jsonb;

comment on column public.chat_messages.assistant_tool_calls is
  'OpenAI-canonical tool_calls array aggregated from this assistant turn. Paired with role=tool rows by tool_call_id. NULL for assistant rows that called no tools or for legacy rows.';
