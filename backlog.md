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
**Status:** done
**Branch:** `feat-002-legal-databases` (stacked on feat-001)
**Priority:** High — most useful new capability for the legal-team users
**Size:** Medium-Large (~1.5 days, includes frontend)

Port `backend/services/legal_search_service.py` from work___ to TypeScript and add a "Files and Sources" picker to the chat input (Ruli-style) so the user can choose which legal databases to enable per message. Sources are **hard-gated**: when nothing is selected, `legal_search` is not in the tool schema at all.

**Why now (revised dependency note).** Originally listed as blocked on feat-001 for shared SSE event types, but feat-001 confirmed mike's existing event taxonomy is sufficient. feat-002 is functionally independent — branched on top of feat-001 only so backlog.md and any future sprint-wide conventions stack cleanly.

**Design decisions (confirmed with Nick).**
- Default state: all 4 legal sources **off**; user opts in.
- Persistence: per-message only for v1; resets each turn / on chat reload. Per-chat persistence is a future story.
- UI placement: extend the existing "+ Documents" button in the chat input into a unified "Files and Sources" popover (Ruli-style). Keep the same trigger position, expand the dropdown content.
- Gating: hard. Empty selection → tool not in schema; partial → tool in schema with a system-prompt line restricting the `sources` arg to the selected list.
- Architecture: sectioned popover so future sources (Knowledge Base items, Integrations, EU/UK Law, etc.) drop in as new sections without rework.

**Backend — files to create.**
- `backend/src/lib/legalSearch.ts` — TS port of work___'s `legal_search_service.py`. Four async functions (`searchCourtListener`, `searchGovInfo`, `searchFederalRegister`, `searchECFR`), one fan-out dispatcher (`legalSearch(query, sources, perSource)`), one source-name → function map. Uses `fetch` + `AbortController` for 12s timeouts. No new deps.

**Backend — files to modify.**
- `backend/src/lib/chatTools.ts`:
  - Define a separate `LEGAL_TOOLS` array containing the `legal_search` tool (kept out of the always-on `TOOLS` so it can be conditionally appended).
  - Add a dispatch case for `legal_search` in `runToolCalls()` (around line 1505+).
  - In `runLLMStream`, accept new `sources?: { legal?: string[] }` param. When `sources.legal?.length > 0`: append `LEGAL_TOOLS` to `activeTools` and append a system-prompt line `"User has selected these legal sources: …; restrict the legal_search sources arg to that list."` Otherwise no-op.
- `backend/src/routes/chat.ts` — read `sources` from request body, pass through to `runLLMStream`.
- `backend/.env.example` — add `COURTLISTENER_API_TOKEN`, `GOVINFO_API_KEY`.

**Frontend — files to modify.**
- `frontend/src/components/ui/dropdown-menu.tsx` — surface `DropdownMenuCheckboxItem`, `DropdownMenuLabel`, `DropdownMenuSeparator` from `@radix-ui/react-dropdown-menu` (already installed).
- `frontend/src/app/components/assistant/AddDocButton.tsx` → rename to `FilesAndSourcesButton.tsx`:
  - Trigger label: "Files and Sources" (was "Documents"). Count badge shows total (attached files + selected sources). Same icon-rotation / hover behaviour.
  - Dropdown content: existing "Upload files" + "Browse all" at top, then `<DropdownMenuSeparator>`, then `<DropdownMenuLabel>US Legal Sources</DropdownMenuLabel>`, then 4 `<DropdownMenuCheckboxItem>` entries: Court Opinions, Federal Legislation, Federal Register, Regulations (CFR).
  - New props: `selectedLegalSources: string[]`, `onLegalSourcesChange: (sources: string[]) => void`.
- `frontend/src/app/components/assistant/ChatInput.tsx`:
  - Add state `selectedLegalSources: string[]` (default `[]`).
  - Pass to `FilesAndSourcesButton` and receive change callback.
  - Include `sources: { legal: selectedLegalSources }` in the message payload submitted to the parent.
  - Reset to `[]` after each submit (per-message-only behaviour).
- `frontend/src/app/hooks/useAssistantChat.ts` (or wherever `/chat` requests are constructed) — include `sources` in the POST body.
- Update file path imports referencing the renamed `AddDocButton` (one importer in `ChatInput.tsx`).

**Tool schema (matches work___).**
```ts
{
  name: "legal_search",
  description: "Search US legal databases for case law, federal legislation, regulations, and executive orders...",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Legal search query" },
      sources: {
        type: "array",
        items: { type: "string", enum: ["courtlistener", "govinfo", "federal_register", "ecfr"] },
        description: "Which databases to search. Omit for all four.",
      },
    },
    required: ["query"],
  },
}
```

**Dispatch behaviour.** Returns the combined results as a markdown-flavoured string back to the model:
```
[CASE NAME](https://courtlistener.com/...) (CourtListener · 2024-03-12)
snippet text…

[Title 21 §312.20](https://ecfr.gov/...) (eCFR)
snippet text…
```
The model can then cite inline with markdown links — no frontend change needed for the user to click through.

**SSE events.** Reuse existing `tool_call_start` (already fires for any tool from `olava.ts` callback). Skip a per-source "searching X" event for v1 — adds frontend coupling for marginal value.

**Key decisions.**
- **No retries / circuit-breakers.** v1 mirrors work___: try, log on error, return empty. Real failures show up in tool-result content as "No results found."
- **Concurrent fan-out.** `Promise.allSettled` across the requested sources — one slow source can't block the others, one failing source can't poison the others.
- **Timeouts.** 12s per source via `AbortController` (matches work___).
- **Rate limits.** Not addressed in v1. CourtListener allows 5000 req/hr authenticated which is plenty for interactive use; if we hit a wall we add a per-user throttle later.

**Risks.**
- **API drift.** Federal Register and eCFR schemas may have changed since work___ wrote against them. Mitigation: defensive null-coalescing on every field.
- **Outbound network blocked by httpSecurity.** The security commit added `backend/src/lib/httpSecurity.ts` with helmet — need to verify it doesn't restrict outbound `fetch` to legal API hostnames. Quick read of httpSecurity.ts before coding.
- **Stacking on feat-001.** When feat-001 PR merges, feat-002 will need to rebase. Should be a no-op (no file overlap) or near-no-op.

**Test plan.**
- `tsc --noEmit` clean (both backend and frontend).
- `next build --no-lint` clean (or just `next build`).
- Unit: small Node script that calls `legalSearch("reasonable accommodation ADA", ["federal_register", "ecfr"])` with no API keys — confirm graceful degradation (FR + eCFR return results; CourtListener + GovInfo unrequested so no warning).
- Manual: dev server, no sources selected → ask a legal question → confirm `legal_search` is NOT in the tool list (check backend log of system prompt + tool schema).
- Manual: select Court Opinions only → ask a legal question → confirm `legal_search` fires with `sources: ["courtlistener"]`.
- Manual: select all 4 → ask a question → confirm parallel fan-out, results from all sources appear in tool result.
- Manual: confirm vLLM streaming (feat-001) is unaffected — tokens stream as they arrive both before and after the tool call.

**Acceptance.**
- "Files and Sources" button replaces "Documents" button visually; same trigger position; expanded dropdown.
- 4 legal source checkboxes render under a "US Legal Sources" heading; default off; selectable per message.
- Selecting → `legal_search` tool is added to the model's schema; deselecting → removed.
- All four sources work end-to-end with valid API keys (or fail gracefully without).
- Selection resets after submit (per-message-only).
- `.env.example` documents both new env vars.
- No regression in feat-001 streaming or any other tool.

---

### feat-003 Brave web search
**Status:** ready (blocked-by feat-001 for streaming events)
**Branch:** `feat-003-brave-web-search` (not yet created)
**Priority:** Medium — broad fallback when legal databases miss
**Size:** Small (~half day)

Port `_brave_web_search` from `work___/backend/services/chat_service.py:1206`. Single `web_search` tool, single env var `BRAVE_SEARCH_API_KEY`.

Detail to be planned when feat-002 merges.
