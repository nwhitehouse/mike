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

### feat-003 Brave web search with globe-icon toggle
**Status:** done
**Branch:** `feat-003-web-search`
**Priority:** High — needed by feat-005 multi-pass orchestrator + standalone value for current commentary
**Size:** Medium (~1d, includes frontend globe icon)

Add a `web_search` tool backed by the Brave Search API, gated by a globe-icon toggle on the right side of the chat input (Ruli pattern). Hard-gated like legal sources: globe off → tool not in schema.

**Why now.** feat-002 demonstrated the gap vs work___: most of the rich content in their answer came from web search (the Dentons commentary article), not legal databases. feat-005 (multi-pass orchestrator) will fan out across both legal and web in parallel — needs this tool to exist.

**Backend — files to create.**
- `backend/src/lib/webSearch.ts` — Brave Search API client. Single `webSearch(query, count)` function. Returns `{ title, url, snippet, source: "Web" }[]`. 12s timeout via AbortController. Same shape as legalSearch results so feat-004 can render both as one card type.

**Backend — files to modify.**
- `chatTools.ts`:
  - Define `WEB_TOOLS` array (same conditional pattern as `LEGAL_TOOLS`).
  - Dispatch case for `web_search` in `runToolCalls()`.
  - `runLLMStream` accepts `sources.web?: boolean`. When true → append `WEB_TOOLS` to `activeTools` and add system-prompt line "Web search is enabled — use it for current events, blog posts, and commentary not in legal databases."
- `chat.ts` — already plumbs `sources` from request body; just include `sources.web` in the type.
- `.env.example` — add `BRAVE_SEARCH_API_KEY`.

**Frontend — files to modify.**
- `ChatInput.tsx`:
  - Add `webSearchEnabled` boolean state (default false).
  - Add a globe icon button on the right side of the input, between the model toggle and the send button. Filled blue when on, gray when off. Click toggles.
  - Include in submitted MikeMessage: `sources: { ..., web: webSearchEnabled }`.
  - Reset `webSearchEnabled = false` after each submit (per-message-only, matches legal-sources behaviour).
- `MikeMessage.sources` type already accepts arbitrary fields; add `web?: boolean` to the type.
- `mikeApi.streamChat` already passes `sources` through; no change needed.

**Key decisions.**
- **Globe icon position:** right side of input, near send button, matching the Ruli reference image. Distinct from the left-side "Files and sources" picker because legal sources are categorically different (curated, opt-in per source) from web search (everything-everywhere fallback).
- **Hard gate:** globe off → no `web_search` in tool schema (model can't call it). Avoids accidental web spend on doc-focused chats.
- **Rate limiting:** none in v1. Brave's free tier is 2K queries/month. If we hit caps we add per-user throttle.
- **Result format:** same shape as legalSearch results so feat-004 references-inline doesn't need branch logic per source type.

**Risks.**
- Brave API quota — free tier is enough for dev, may need paid plan for prod.
- Outbound httpSecurity (already cleared in feat-002 — helmet only sets response headers, no outbound restrictions).

**Test plan.**
- `tsc` clean both sides.
- Smoke: `node` script calling `webSearch("AI court opinion 2026")` directly with a real BRAVE_SEARCH_API_KEY → confirm results returned.
- Manual: globe off, ask "current AI news" → tool not invoked, model answers from training.
- Manual: globe on, same question → tool fires, model cites web sources.
- Manual: globe on + Court Opinions checked → both tools available, model picks appropriately.

**Acceptance.**
- Globe icon renders on right side of chat input; click toggles state visually.
- Globe off → `web_search` not in schema (verifiable in backend log of activeToolNames).
- Globe on → tool fires when model asks about current/web-y questions.
- Reset after submit.
- `.env.example` documents `BRAVE_SEARCH_API_KEY`.

---

### feat-004 References inline display
**Status:** planning
**Branch:** `feat-004-references-inline` (worktree created, not yet started)
**Priority:** High — closes the citation gap regardless of model synthesis quality
**Size:** Small-Medium (~½ day)

Surface every `legal_search` and `web_search` result as a structured event the frontend can render as a clickable card in the assistant message. Decouples link/source visibility from Olava's synthesis prose — the user sees raw results even when the model under-summarises.

**Why now.** feat-002 testing showed Olava drops URLs from its synthesis even when they're in the tool result. work___'s "References" sidebar fixes this by rendering raw results separately. We do the same, inline (no sidebar — keeps the chat UI dense).

**Backend — files to modify.**
- `chatTools.ts`:
  - In the `legal_search` and `web_search` dispatch cases, after fetching results, push a `reference_added` event for each result into the events array.
  - Each event: `{ type: "reference_added", source: "legal" | "web", title, url, snippet, date?, source_label }`.
- `frontend/src/app/components/shared/types.ts` — add `reference_added` to AssistantEvent union.

**Frontend — files to modify.**
- `AssistantMessage.tsx` — render `reference_added` events as a horizontal-scrolling row of compact cards (icon + title + source + date), interleaved chronologically with content events.
  - Card style: similar to `EditCard.tsx` shape — small, clickable, opens URL in new tab.

**Key decisions.**
- **Inline vs sidebar.** Inline keeps the chat compact and matches mike's existing pattern of doc_read/doc_created cards in the message stream. work___ uses a sidebar — different layout philosophy.
- **One event per result, not batched.** Easier for streaming and for feat-005 which will fire results in parallel passes.
- **Same shape for legal + web.** feat-003 already aligns these on the backend.

**Test plan.**
- `tsc` + `next build` clean.
- Manual: select Court Opinions, ask a legal question → confirm cards appear in message + link clickable.
- Manual: globe on, ask current question → confirm web result cards appear.
- Manual: both on, multi-source question → confirm cards from both sources interleaved.

**Acceptance.**
- Each tool result renders as a clickable card in the assistant message.
- Cards work for both legal and web sources.
- Olava's prose synthesis is no longer the only path to source URLs.

---

### feat-005 Multi-pass research orchestrator
**Status:** planning (awaiting Nick's review of detailed plan below)
**Branch:** `feat-005-research-orchestrator` (not yet created)
**Priority:** High — strategic direction, closes the work___ quality gap
**Size:** Large (~3 days)

Embrace Olava's cost advantage: orchestrate 13–17 parallel + sequential Olava calls into a richer answer than any single-pass attempt. Architectural reference is work___'s `services/{orchestrator,sub_agent,loop_controller}.py`, but designed fresh for Olava-001 (Qwen3.6 base + LoRA) — different context size, custom tool-call markup, vLLM streaming quirks.

**Trigger (auto-detect).** Any chat where `sources.legal?.length > 0` OR `sources.web === true` → route to orchestrator instead of single-pass `runLLMStream`. Selecting a source = user signal "I want depth."

**Pipeline (5 passes).**

```
Pass 1 — Query expansion           (1 Olava call,  ~3s)
  Input:  user question + selected sources
  Output: 3-5 specialized search queries, each tagged target=legal|web

Pass 2 — Parallel search swarm     (5-10 search API calls, ~3-5s wall)
  Promise.allSettled across all queries × applicable tools
  Dedupe by URL, normalise shape

Pass 3 — Triage & rank             (1 Olava call,  ~3s)
  Input:  user question + all dedup'd results (titles+snippets only)
  Output: top-N (default 8) by recency × relevance

Pass 4 — Per-result extraction     (≤10 parallel Olava calls, ~5-8s wall)
  For each top-N result: 2-3 sentence extract tailored to user's question
  Optionally fetch full doc text (CourtListener has full-opinion API)

Pass 5 — Synthesis                 (1 Olava call,  ~5-10s)
  Input:  user question + per-result extracts
  Output: narrative answer with inline [Title](URL) citations
  Streamed token-by-token to user (uses feat-001 streaming path)
```

**Hard caps (enforced in budget.ts):**
- Max Olava calls per turn: **25** (configurable via env)
- Max wall-clock: **45s** (return what we have at the cap)
- Max parallel search calls: 10
- Max parallel extract calls: 10

**Streaming progress events** (so 30s of work doesn't look like 30s of dead air):
- `research.expanding_queries` — show the queries being generated
- `research.searching` — show "Searching 6 sources…" with live count
- `research.search_complete` — N results found
- `research.ranking` — show "Ranking 47 results…"
- `research.extracting` — progress like "Reading 5/10…"
- `research.synthesizing` — show "Drafting answer…"
- `chat.token` — final answer streams as Olava produces it

Frontend renders a progress checklist similar to work___'s plan UI in the assistant message.

**Files to create.**
- `backend/src/lib/research/orchestrator.ts` — main pipeline coordinator
- `backend/src/lib/research/queryExpander.ts` — pass 1
- `backend/src/lib/research/searchFanOut.ts` — pass 2 (uses legalSearch + webSearch)
- `backend/src/lib/research/triage.ts` — pass 3
- `backend/src/lib/research/extractor.ts` — pass 4
- `backend/src/lib/research/synthesizer.ts` — pass 5 (streams via existing olava streaming)
- `backend/src/lib/research/budget.ts` — hard cap enforcement (call counter, wall-clock timer)
- `backend/src/lib/research/types.ts` — shared types (RankedResult, ExtractedFinding, etc.)

**Files to modify.**
- `backend/src/routes/chat.ts` — detect research mode, route to `runResearchOrchestrator` instead of `runLLMStream` when triggered.
- `frontend/src/app/components/assistant/AssistantMessage.tsx` — render new `research.*` event types as a progress checklist + spinner.
- `frontend/src/app/components/shared/types.ts` — add the new event types to AssistantEvent.

**Failure modes & degradation.**
- Pass 1 fails (Olava can't generate queries) → fall back to single-pass `runLLMStream`. User sees a normal chat response.
- Pass 2 returns 0 results → fall back to single-pass + a system-prompt note "no sources found, answer from knowledge."
- Pass 4 partially fails (some extracts time out) → use successful extracts, skip failed.
- Pass 5 fails → return raw extracts as a structured list, no narrative.
- Hard cap hit → emit a `research.cap_hit` event, return whatever we have synthesized so far.

**Key decisions.**
- **Olava as both planner and worker.** Same model, different system prompts per pass. Cheaper than routing some passes to Claude.
- **No persistent research-mode state.** Each turn re-orchestrates. Simpler, supports follow-up questions naturally.
- **Synthesis pass uses existing streaming path** (feat-001). Don't reinvent — token streaming for the final answer is already solved.
- **Per-result extracts are JSON not prose** — easier for synthesis pass to consume reliably.

**Test plan.**
- `tsc` clean.
- Unit: `budget.ts` enforces caps in isolation (call counter increments, wall-clock timer trips at 45s).
- Smoke: end-to-end script that runs the orchestrator against "What's the latest court opinion involving AI?" and prints the final result + per-pass timings + Olava call count.
- Manual: send the same question via UI; expect 20-30s of progress events then a richly-cited answer.
- Manual: trigger each failure mode (no sources, 0 results, kill vLLM mid-pass) and confirm graceful degradation.
- Manual: confirm cost cap (mock Olava to count calls without hitting prod, verify cap kicks in at 25).

**Acceptance.**
- Orchestrator triggers automatically when any source is selected.
- "Latest AI court opinion" query produces an answer comparable to work___'s in richness and citation density (subjective but checkable side-by-side).
- Wall-clock ≤ 45s for typical queries.
- Olava call count ≤ 25 for typical queries.
- Progress events visible in UI throughout the run.
- Single-pass path still works when no sources selected (no regression).
- No regression in feat-001/002/003/004.
