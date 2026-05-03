# Backlog

Categories: `feat` (new capability), `bug` (defect), `maint` (chore/refactor).

Branch naming: `<id>-<short-description>`. One story per branch.

---

## Sprint 1: Port from work___ (started 2026-05-03)

Goal: bring the most useful capabilities from `/Users/nick.whitehouse/coding/work___` (Onit Q) into Olava. Three stories, sequenced (not parallel) because feat-001 introduces SSE event types that feat-002 and feat-003 will reuse.

**Coordination note:** another agent is working on security hardening in the main working tree (uncommitted on `main`, ~27 modified files, 5 new). Their work is expected to land on `main` first; this sprint's branches were rooted at `9a36051` (clean main as of sprint start) and will be rebased after the security PR merges.

### feat-001 Stream tokens during tool-using turns
**Status:** done
**Branch:** `feat-001-streaming-with-tools`
**Priority:** High — unblocks the rest of the sprint (introduces the SSE event taxonomy)
**Size:** Medium (~1 day)

**Problem.** `backend/src/lib/llm/olava.ts:134` short-circuits to `nonStreamOlavaWithTools()` whenever tools are forwarded. Result: the user sees a long pause then the whole answer at once, instead of token-by-token streaming.

**Root cause.** The Olava LoRA emits tool calls as custom markup (`<tool_call><function=NAME><parameter=KEY>VALUE</parameter>...</tool_call>`) that no built-in vLLM parser recognises. In streaming mode vLLM emits empty `delta.tool_calls: []` chunks then `finish_reason: "tool_calls"` with no payload. Non-streaming mode dumps the markup into `message.content`, which mike already parses with `parseCustomToolCall()` (olava.ts:78).

**Approach.** Keep streaming on. Buffer raw `delta.content` server-side, but emit a *filtered* stream to `onContentDelta` that withholds any tail that could be the start of `<tool_call>`. After the stream ends, run the existing `parseCustomToolCall()` on the full buffer and dispatch tools via `runTools` exactly like the non-streaming path.

**Files to modify.**
- `backend/src/lib/llm/olava.ts` — remove early-return at line 134; rewrite the streaming loop to (1) accumulate raw content, (2) emit a streaming-safe filtered version that hides `<tool_call>` and `<think>` markup, (3) post-stream parse + dispatch.

**Scope narrower than originally planned:** mike already has the SSE event taxonomy I need (`content_delta`, `tool_call_start`, etc. in `chatTools.ts:2397+`). Also caught a bonus bug — the no-tools "streaming" path today buffers the entire response and emits one giant `onContentDelta` at the end (olava.ts:251), so the user never actually sees streaming. Same fix solves both: stream `delta.content` chunks through a markup-filtering scanner.

**Key decisions.**
- **Streaming-safe scanner:** state machine with two flags (`inThink`, `toolCallSeen`) plus a held-back tail. Tail size is computed from the longest target tag (`<tool_call>` = 11 chars, so hold ≤10). On stream end, flush the tail unless the scanner is still inside `<think>` or past `<tool_call>`.
- **Emergency rollback:** keep `nonStreamOlavaWithTools()` available behind `OLAVA_FORCE_NONSTREAM_TOOLS=true` so prod can revert without a code change.
- **Multiple tool calls per response:** `parseCustomToolCall()` today returns the first call only. The Olava LoRA in practice emits one call per round, then loops. Keep that behaviour; if multi-call ever becomes real, extend the parser separately.
- **Fallback to structured field:** if vLLM ever does start populating `delta.tool_calls` correctly, prefer the structured payload over the markup parse. Both paths exist; structured wins when present.
- **Reasoning fields:** continue dropping `delta.reasoning` / `delta.reasoning_content` from output. Counted for diagnostics only, same as today.

**Risks.**
- Markup spanning a chunk boundary — mitigated by the held-back tail.
- `<tool_call>` appearing in legitimate prose (e.g. user asking about XML syntax) — extremely unlikely in legal use, accept the risk.
- Rebase conflict on `olava.ts` after security agent merges — mostly mechanical since their changes are likely security-scoped (auth headers, body validation), not in the streaming loop.

**Test plan.**
- `tsc --noEmit` clean build.
- Manual: run dev, send a message that triggers `read_document` (a tool-using turn), confirm tokens stream in real-time before the tool fires.
- Manual: send a tool-free message, confirm tokens stream (this is also a behaviour change — today they don't).
- Manual: send a message that produces no tool call but emits prose containing `<` characters, confirm the held-back-tail logic doesn't drop content.
- Manual: emergency rollback — set `OLAVA_FORCE_NONSTREAM_TOOLS=true`, confirm tool-using turns revert to today's non-streaming behaviour.
- Backend log line `[olava] iter=…` should still appear.

**Acceptance.**
- Tool-using and tool-free turns both stream tokens to the user as they arrive.
- The `<tool_call>` markup is never visible to the user mid-stream.
- Tools dispatch correctly (existing tools: `read_document`, `generate_docx`, etc.).
- No regression in the chat API contract or SSE event shape that the frontend depends on.

---

### feat-002 Legal database search (CourtListener + GovInfo + Federal Register + eCFR)
**Status:** ready (blocked-by feat-001 for streaming events)
**Branch:** `feat-002-legal-databases` (not yet created)
**Priority:** High — most useful new capability for the legal-team users
**Size:** Medium (~1 day)

Port `backend/services/legal_search_service.py` from work___ to TypeScript. Add `legal_search` tool to `chatTools.ts`. Wire into the tool dispatcher so the agent can call CourtListener, GovInfo, Federal Register, eCFR.

**New env vars:** `COURTLISTENER_API_TOKEN`, `GOVINFO_API_KEY` (Federal Register + eCFR are open APIs, no auth).

Detail to be planned when feat-001 merges.

---

### feat-003 Brave web search
**Status:** ready (blocked-by feat-001 for streaming events)
**Branch:** `feat-003-brave-web-search` (not yet created)
**Priority:** Medium — broad fallback when legal databases miss
**Size:** Small (~half day)

Port `_brave_web_search` from `work___/backend/services/chat_service.py:1206`. Single `web_search` tool, single env var `BRAVE_SEARCH_API_KEY`.

Detail to be planned when feat-002 merges.
