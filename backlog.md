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
**Status:** done
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

---

### feat-006 Reliable document citations via tool-calling
**Status:** ready
**Branch:** (not yet created)
**Priority:** High — current freeform `[N] + <CITATIONS>` format is unreliable on Olava (small-model prompt-adherence gap)
**Size:** Medium-Large (~2-3 days, mirrors feat-005's SLM-multi-pass pattern)

**Problem.** The current citation system asks Olava to write `[1]`, `[2]` markers in prose and append a `<CITATIONS>` JSON block at the end. Detailed instructions in the system prompt (chatTools.ts:80-130) cover the format. Empirically Olava follows it inconsistently — same chat type, same doc, different turn = sometimes inline `[N]` markers + clickable citations, sometimes just freeform `[Page 5]` text references that aren't clickable. Rooted in: small models follow tool schemas more reliably than freeform output formats (same insight as feat-005's multi-pass).

**Three sub-issues observed in testing 2026-05-04.**
1. **Inconsistent emission** — some doc-summary turns emit no inline citations at all, just `[Page 5]` text in prose.
2. **Stuck on first citation** — clicking the second/third citation pill on the same doc doesn't scroll to it; viewer stays on the first. Likely a `quoteKey` / `initialScrollTop` race in `DocView.tsx` when the same DocPanel tab is reused across citations of the same document.
3. **No hover preview** — citation pills use a plain HTML `title="..."` attribute (browser-native tooltip) instead of a custom popover with the quote and page.

**Proposed fix — three layered changes.**

a) **`add_citation` tool** (the core SLM-friendly fix). Define a tool the model calls explicitly per citation:
```ts
add_citation({
  doc_id: "doc-0",
  page: 5,           // or "5-6" for span
  quote: "exact text from doc",
  marker: 1          // the [N] marker that appears in prose
})
```
Model writes `[N]` in prose AND calls `add_citation` for each. Backend collects calls into the same annotations array `<CITATIONS>` JSON would have produced. Tool-call dispatch is reliable (we already have streaming + recovery for the LoRA's tool-call format from feat-001 + bug-002). Eliminates the "model didn't follow JSON format" failure mode.

b) **Verifier pass** (optional, in research/orchestrator mode only). After synthesis, a quick non-streaming Olava call: "These are the claims in your answer; for each that needs a citation, call add_citation." Cheap (1 extra call per turn) and catches missing citations.

c) **DocView `quoteKey` fix + custom hover popover** (frontend, separable from a/b). Track down why same-doc re-clicks don't scroll; replace the `title=` attribute with a small portal'd popover showing page + quote + clickable "Open" button.

**Files to create/modify (sketch).**
- backend: `chatTools.ts` (new `add_citation` tool def + dispatch case that pushes to a `citations[]` accumulator returned alongside other tool results), `routes/chat.ts` (merge tool-emitted citations into the assistant message annotations), system prompt update.
- backend research: optional `verifier.ts` pass after synthesizer.
- frontend: `AssistantMessage.tsx` (replace `title=` with popover, e.g. Radix Tooltip already used by other primitives), `DocView.tsx` (audit `quoteKey` effect + initialScrollTop handling for the same-doc-different-citation case).

**Success criteria.**
- Asking Olava to summarise a document reliably produces clickable `[N]` pills (≥9/10 attempts on the same doc).
- Hovering a pill shows page + quote in a custom popover (no browser-native `title` tooltip).
- Clicking pill #3 on a doc that's already showing pill #1 scrolls the viewer to pill #3's quote.
- No regression in tool-using turns or research-mode synthesis.

**Why deferred.** Model behaviour change + viewer-scroll race + popover UI is three separable concerns that deserve their own sprint thread; rolling them into the feat-005 commit would muddle review.

**Outcome (2026-05-04).** Tried; reverted. The `add_citation` tool was added to the schema and the system prompt rewritten to instruct calling it per `[N]` marker. Empirically Olava skipped the tool ~always — it wrote `[N]` markers but never invoked `add_citation`. Same SLM-prompt-following gap as before, just shifted from "didn't follow JSON format" to "didn't call the tool." See commit `8731d95 [feat-006] Park add_citation tool path; restore <CITATIONS> JSON prompt`. Tool definition + dispatch remain in code so re-engaging is just a prompt swap. Frontend pieces (hover popover via `CitationPill`, same-doc rescroll fix in `ChatView.upsertTab`) **did ship in `6321e28`** and are still live — they're not coupled to the prompt path.

---

## Sprint 2: Vision mode (started 2026-05-04, ongoing)

Goal: stop relying on `read_document` text extraction as the primary doc-context channel. Send PDFs as images to Olava-001's Qwen3-VL backbone so it reasons over visual layout (tables, signatures, headers) — and incidentally fits more pages per request via grid composition.

Sequenced because each piece compounds: 007a established the pipeline, 008 fixed the silent rendering bug + introduced 4-up compression, 009 layered cache + perf, 010 closed the user-perceived first-chat latency gap.

### feat-007a Vision-mode auto-on for PDFs
**Status:** done
**Commits:** `f870b0a` (initial), `436d028` (live citation rendering)

Auto-enable when any chat has an attached PDF. Backend renders pages → spliced into the last user message as `image_url` content blocks. New system-prompt hint tells the model to read directly from images instead of waiting for `read_document`.

Includes the per-marker citation verifier (`lib/research/citationVerifier.ts`) that watches `iterText` for newly-arriving `[N]` / `¹²³⁴` markers and fires parallel non-streaming Olava calls to derive page+quote. Streams `citation_added` SSE events live; frontend rAF-batches them to avoid render storms.

**Open issue (2026-05-06):** verifier is now the dominant chat-finish wait. Per-call latency 12–17s; we await all in-flight at end-of-turn before sending `[DONE]`. Backend log on a representative SEK chat: 4 calls, 3 misses, 12.5s wait. Two ways forward queued (see "Open items" below).

### feat-008 PDF rendering via pdftoppm + 4-up
**Status:** done
**Commits:** `787258c` (pdftoppm + 4-up), `26ef15f` (verifier model-name bug)

Two outcomes in one commit:
1. **Fixed silent blank-page bug.** Production was rendering blank PNGs because canvas v3 dropped `Path2D` and pdfjs 4.x uses Path2D for glyph paths. The `path2d` polyfill didn't bridge it. Vision-mode answers were entirely from `read_document` text-fallback up until this fix; vision input was noise. Now shells out to `pdftoppm` (poppler-utils, added to `nixpacks.toml`).
2. **4-up grid as default.** Two spike rounds (25-page services agreement + 75-page SEK financing doc, see `backend/scripts/spike_compression.ts`) confirmed ~3× token compression vs 1-up at no fidelity loss on factual queries (dates, currency amounts, party names). 8-up was rejected — it hallucinates.

`26ef15f` separately fixes the verifier hardcoding `olava-001` (vLLM serves `olava-extract`).

### feat-009 Vision perf: parallel render + tiered cache + progress UI
**Status:** done
**Commit:** `6bf6d52`

Four wins for chat-time vision wait:
1. **Progress UI.** SSE stream opens BEFORE pdftoppm runs so a `vision_render_start` placeholder reaches the browser immediately. `VisionRenderBlock` matches the `DocReadBlock` pattern.
2. **Parallel render.** 4 pdftoppm workers split via `-f`/`-l` page ranges. 75 pages went from 28s → 11.7s on bench.
3. **In-memory LRU cache** (`lib/visionCache.ts`). 5-entry cap (~30MB per 75-page doc, ≤150MB worst case on 512MB Railway).
4. **R2 persistent cache** (`lib/visionR2Cache.ts`). Single JSON manifest at `vision-cache/<base64url>.json`. Survives restarts and redeploys. Write-through on render.

Tiered lookup in `visionContext.ts`: memory → R2 → live render.

### feat-010 Pre-render at upload + chip shimmer
**Status:** done
**Commit:** `b284014`

Closes the "first chat against a freshly-uploaded doc is slow" gap. Upload route fires `kickOffVisionPrerender` (fire-and-forget) the moment a PDF version row inserts. By the time the user opens a chat, R2 cache is warm.

Frontend: new `useVisionStatus` hook polls `GET /single-documents/:id/vision-status` per attached PDF. While status is `pending`, the chip in `ChatInput` shimmers (`chip-shimmer` keyframe in `globals.css`) and the Send button is disabled (with `title=` explanation). Belt-and-braces in `handleSubmit` so Enter doesn't sneak past.

Status endpoint combines in-memory render-tracker map with R2 manifest existence — survives backend restarts.

### Bonus shipped this sprint
- `e67b072` + `4f480f2` — user-message attachment chips are now clickable; opens the doc in the side panel viewer. Wired on both standalone-assistant and project-chat routes.

---

## Sprint 3: Harness hardening + memory (planned 2026-05-07)

Goal: make the Finch agent loop more robust by porting distilled patterns from `/Users/nick.whitehouse/Coding/work___` (Onit Q), and fix the in-chat context loss caused by tool results not persisting between turns. Seven stories, partially independent.

**Direction note (decided 2026-05-07).** Earlier consolidation discussion landed on: stick with Finch as the demo base, port good ideas from work___ in distilled form. Explicitly NOT porting work___'s 5-tier permission model, sub-agent spawning, 4-stage compaction pipeline, or 8 agent primitives — those solve problems Finch doesn't have. This sprint takes the smaller, higher-ROI patterns only.

**Sequencing recommendation.**
1. **feat-017 (memory) first** — biggest user pain ("finch loses context in chat"). Demonstrably broken today.
2. **feat-013 (tool registry) second** — largest refactor; landing it early lets feat-014 / feat-016 build on the cleaner structure.
3. **bug-006 + bug-007** — opportunistic 1-hour fills between bigger stories. Both clear `SECURITY.md` items.
4. **feat-014, feat-015, feat-016** — independent of each other after feat-013; can parallelise.

---

### feat-017 Memory hierarchy: persist tool results (Tier 1 only — in-chat replay)
**Status:** in-progress
**Branch:** `feat-017-memory-hierarchy`
**Priority:** High — root cause of "finch loses context in chat"
**Size:** Medium (~1 day)

**Scope decision (2026-05-07).** v1 ships **Tier 1 only** (in-chat tool result replay). Tier 2 (per-project persistent facts across chats) is **deferred to feat-018** — user said "I just want chat to remember what we're talking about through the whole conversation at a minimum. It doesn't need to be so detailed yet." The Tier 2 design below is preserved here as the spec for feat-018.

**Problem.** Two distinct context-loss failures, often confused as one:
1. **Within-chat:** `chatTools.ts:710 buildMessages()` rebuilds the LLM input from `chat_messages` rows, which only stores `user` and `assistant` text — tool calls and tool results from previous turns are dropped. The system prompt at `chatTools.ts:730` admits this defeat: *"You do NOT retain document content between conversation turns. You MUST call read_document at the start of every response."* So every turn re-reads every doc, costing latency, tokens, and breaking the "remembers what we discussed" UX.
2. **Across-chats:** Each new chat starts blank. Project-level facts (parties, opposing counsel, key dates, prior conclusions) are not surfaced. User has to re-explain context every chat.

**Approach (two-tier, distilled from work___'s 4-tier model — dropped agent-memory and org-memory tiers as speculative).**

**Tier 1 — Session memory (in-chat tool replay).** Persist tool calls + tool results into `chat_messages` so `buildMessages()` can replay the full sequence to the LLM next turn.

- Schema: add columns `tool_call_id text`, `tool_name text` to `chat_messages`. Allow `role IN ('user','assistant','tool')`.
- Persistence: in `chatTools.ts runToolCalls()`, after each tool result is produced, insert a `role:'tool'` row alongside the assistant row. Assistant rows already keep their `<tool_call>...</tool_call>` markup in content — fine for Olava, that's how it formatted them the first time.
- Replay: `buildMessages()` includes all rows in order. Olava sees prior tool calls as part of assistant content (markup intact) and tool results as `role:'tool'` content. This is exactly what it sees mid-turn already — no LoRA retraining needed.
- Delete the "you do NOT retain document content" warning from the system prompt. Replace with: *"Tool results from earlier in this conversation are included in the message history — refer to them rather than re-reading documents you've already inspected, unless the user implies the doc may have changed."*

**Tier 2 — Project memory (persistent facts across chats).** Per-project key/value store of facts surfaced into every chat in that project.

- Schema: new table `project_memory(id, project_id, key, value, source text, updated_at)`. RLS by project_id.
- Write path v1: manual only — `POST /projects/:id/memory` for user-pinned facts. No auto-extraction yet (a v2 nice-to-have via a background extractor agent).
- Read path: `projectChat.ts` loads memory rows at session start, injects into system prompt as `KNOWN FACTS:\n- {key}: {value}\n- ...`.
- UI: a "Memory" panel in the project sidebar listing facts with edit/delete. Reuse existing project-settings styling.

**Files to create.**
- `backend/migrations/003_memory_persistence.sql` — adds tool columns to chat_messages + creates project_memory table + RLS.
- `frontend/src/app/components/projects/MemoryPanel.tsx` — CRUD UI, ~150 LOC.

**Files to modify.**
- `backend/src/lib/chatTools.ts` — `runToolCalls()` persists tool rows; `buildMessages()` replays them; system prompt warning removed.
- `backend/src/routes/projectChat.ts` and `chat.ts` — load project_memory at session start, inject into systemPromptExtra.
- `backend/src/routes/projects.ts` — add `GET/POST/PUT/DELETE /projects/:id/memory` endpoints.
- `frontend/src/app/projects/[id]/page.tsx` (or wherever the project sidebar lives) — mount MemoryPanel.

**Key decisions.**
- **Why store assistant `<tool_call>` markup verbatim, not structured tool_calls?** Olava emits markup natively; persisting it round-trips cleanly without translation. If we ever switch back to a Hermes-format model we'll re-derive — one-way migration when needed.
- **Tier 2 manual-only for v1.** Auto-extraction needs an extractor agent + dedup logic + UX for "we learned X about your project." That's a sprint of its own; ship the storage + UI now, add auto-write later.
- **Why a dedicated table not JSON in `projects.metadata`?** Wanting RLS, indexing on key, audit trail of updated_at. Cheap to over-build the storage even if v1 UX is bare.
- **Compaction for long chats: explicitly out of scope.** Anthropic prompt caching + tool-result-replay handles the typical case. Add a rolling-summary tier (work___'s stage-2 compaction) only when chats actually start hitting the window — measure first.

**Risks.**
- **Migration on a live DB.** chat_messages columns are additive (nullable) so safe. project_memory is new. RLS must be applied or it's a tenant leak. Take a Supabase snapshot before applying (`SECURITY_HARDENING.md` pattern).
- **Older chats predate the change.** Tool history before the migration is gone forever — those chats remain context-blind. Acceptable; users start a new chat.
- **Token budget inflation.** Replaying every tool result inflates context. For most chats this is what we want. For pathological cases (50-turn chats with 50 large doc reads) we'll hit the window — defer until measured.

**Test plan.**
- `tsc --noEmit` clean.
- Apply migration to local Supabase, smoke-test chat in dev.
- Manual: ask "what's in doc-1?" → confirm `read_document` fires. Then ask "what about clause 3 in doc-1?" → confirm `read_document` does NOT fire (model uses cached result).
- Manual: ask the same in turn 3 with a different question → confirm no re-read.
- Manual: pin a project memory fact (e.g., "opposing counsel: Acme LLP"). New chat in same project → confirm fact appears in system prompt (check backend log).
- Manual: edit/delete memory fact → round-trip.
- Regression: `edit_document`, `generate_docx`, `legal_search`, `web_search` still end-to-end.

**Acceptance.**
- Same chat, second turn does NOT re-read documents already read in turn 1.
- The "you do NOT retain document content" line is gone from `SYSTEM_PROMPT`.
- Project memory CRUD round-trips through the UI.
- Project memory facts visible in the system prompt (verifiable via backend log).
- No regression in existing tool flows.

---

### feat-013 Tool registry split (extract tools from chatTools.ts monolith)
**Status:** ready
**Branch:** `feat-013-tool-registry`
**Priority:** High — biggest maintainability win, unlocks cleaner work on subsequent stories
**Size:** Medium (~1.5 days)

**Problem.** `backend/src/lib/chatTools.ts` is a 3,396-line monolith mixing: a 3,800-word prose system prompt, ~9 tool schemas embedded as inline objects, dispatch switch statements, the streaming loop, the message builder, and ad-hoc helpers. Adding or modifying a tool requires edits in multiple sections of the same file, system prompt drift from schema, and merge-conflict pain on parallel branches. work___'s `backend/services/tool_catalog.py` (11KB) shows the cleaner pattern: declarative tool modules + a registry.

**Approach.** Each tool becomes a TS module exporting `{schema, handler}`. The main chat loop iterates a registry; the system prompt drops to behavior-only with the tool list auto-generated.

**Files to create.**
- `backend/src/lib/tools/types.ts` — `Tool` interface: `{ name, description, parameters: ZodSchema, handler: (args, ctx) => Promise<ToolResult> }`. Zod gives runtime validation AND JSON-Schema generation via `zod-to-json-schema`.
- `backend/src/lib/tools/registry.ts` — collects tools, exposes `getActiveTools(ctx) => Tool[]` (with conditional inclusion for legal sources, web search, table cells) and `dispatch(name, args, ctx)`.
- `backend/src/lib/tools/{readDocument,editDocument,generateDocx,findInDocument,readWorkflow,readTableCells,legalSearch,webSearch}.ts` — one file per tool, ~50–150 LOC each.

**Files to modify.**
- `backend/src/lib/chatTools.ts` — replace inline tool definitions and dispatch switch with calls to registry. Should drop ~1,500 LOC. Keep `buildMessages`, the streaming loop, and run orchestration.
- System prompt — strip per-tool prose; keep behavior guidance (citation format, DOCX rules, numbered sections). Append `Available tools:\n${registry.describeForPrompt(ctx)}` so the prompt always matches the active tool set.

**Key decisions.**
- **Zod, not raw JSON Schema.** Runtime validation catches malformed LLM args before dispatch; JSON-Schema generated via `zod-to-json-schema` for the LLM. Already aligned with TS-everywhere stack. ~30KB added.
- **Behavior stays in system prompt, schema doesn't.** Tool descriptions live in tool schemas (the LLM's tool list). Cross-cutting behavior (citation format, "use markdown links") stays in the system prompt.
- **No backward-compat shim.** Everything moves at once. Branch isolates the change.
- **Conditional tools (legal, web, table cells) become predicates on the tool's exported entry.** Registry filters at lookup time using the same `sources`/`scope` context Finch already plumbs.

**Risks.**
- **Behavior drift.** Tool descriptions in the new schema files must match what was previously in the prose system prompt. Risk of subtle wording change → model behaves differently. Mitigation: side-by-side compare each tool's old prose with new description before merge.
- **Olava LoRA trained on specific phrasing.** If a tool's description influences how Olava emits its `<tool_call>`, changes could shift behavior. Mitigation: keep the old name + arg shape exactly; only restructure where the description lives.

**Test plan.**
- `tsc --noEmit` clean.
- Manual regression on every existing tool: read, edit, generate, find, workflow, table cells, legal search, web search.
- Diff the rendered system prompt before/after for a fixed chat scenario; confirm no semantic loss.

**Acceptance.**
- Each tool lives in its own file under `backend/src/lib/tools/`.
- `chatTools.ts` shrinks by ~1,500 LOC.
- Adding a new tool = creating one file + one registry export, no chatTools.ts edits beyond import.
- All existing tool flows work end-to-end.

---

### feat-014 Loop controller with stall detection
**Status:** ready
**Branch:** `feat-014-loop-controller`
**Priority:** Medium-High — prevents runaway agent loops
**Size:** Medium (~1 day)

**Problem.** `chatTools.ts runLLMStream()` runs until the model emits no tool call or finishes. No guard rails: a tool that keeps failing + a model that keeps retrying = unbounded spend. work___'s `backend/services/loop_controller.py` (10KB, with unit tests in `test_loop_controller.py`) is the proven pattern; port it.

**Approach.** Wrap the tool-call loop in a controller that tracks step count, repeated identical calls, repeated identical errors, wall-clock elapsed. On threshold breach, emit a `loop.escalated` event (writes to feat-015 audit), append a system message *"You have reached the step budget. Please stop calling tools and synthesise an answer from what you have."*, and force the next iteration to be the final one.

**Files to create.**
- `backend/src/lib/loopController.ts` — class `LoopController` with `recordStep({tool, args, error?})`, `shouldEscalate() → {reason, action} | null`. Independent of chat code; unit-testable.
- `backend/tests/loopController.test.ts` — port the cases from work___'s `test_loop_controller.py`.

**Files to modify.**
- `backend/src/lib/chatTools.ts runLLMStream()` — instantiate controller; call `recordStep` after each tool dispatch; check `shouldEscalate` before next iteration.

**Thresholds (env-tunable).**
- `MAX_STEPS=12` (was 15 in work___; Finch chats are typically smaller).
- `MAX_REPEAT_TOOL_ERRORS=3` (3 identical tool errors → escalate).
- `MAX_REPEAT_TOOL_CALLS=3` (same tool + same args 3× → escalate).
- `WALL_CLOCK_MS=60_000` (1 min total tool-loop budget).

**Key decisions.**
- **Synthesise rather than abort.** When budget hits, force the model to summarise what it has rather than fail the chat. Better UX than a red error.
- **Don't gate the research orchestrator (feat-005).** It has its own 45s wall-clock. Two budgets are fine; they protect different surfaces.
- **No retry logic in the controller.** Retry is the model's job (it sees the tool error and decides). The controller only escalates on patterns.

**Risks.**
- **Premature escalation.** A legitimate 10-step research chain could trip MAX_STEPS. Mitigation: tune in dev; thresholds in env.
- **Budget bypass via tool composition.** A tool that internally fans out (e.g., legal_search hitting 4 sources) counts as one step. That's correct.

**Test plan.**
- Unit tests in `loopController.test.ts`: each escalation reason has positive + negative case.
- Manual: induce a tool error and confirm escalation message after 3 retries.
- Manual: normal chat flows are not affected.

**Acceptance.**
- LoopController unit tests pass.
- Pathological loop (force a tool to always error) escalates within 3 retries with a user-visible message, not silently.
- Normal chats unaffected.

---

### feat-015 Agent events audit table
**Status:** ready
**Branch:** `feat-015-agent-events`
**Priority:** Medium — replaces 61 `console.log` calls with a structured trail; enables replay later
**Size:** Small-Medium (~½ day)

**Problem.** Today the agent loop's debug trail is `console.log`s scattered across `chatTools.ts` and `olava.ts` (61 calls). Reconstructing what an agent did in prod requires reading Railway logs and stitching by chat_id. work___ persists every event to a `SessionEvent` table — cheap insurance giving audit + replay + better debugging.

**Approach.** New table `agent_events`. Insert one row per significant event in the chat loop. Don't change SSE event shape (frontend unchanged). Single-purpose append-only log.

**Files to create.**
- `backend/migrations/004_agent_events.sql` — table with columns: `id, chat_id, project_id, user_id, type, payload jsonb, created_at`. Indexes on `chat_id` and `created_at`. RLS: select-by-user via project membership.
- `backend/src/lib/agentEvents.ts` — `recordEvent({chatId, type, payload})`. Fire-and-forget with `void` return; failures logged not thrown.

**Files to modify.**
- `backend/src/lib/chatTools.ts` — call recordEvent at: turn start, tool_call_start, tool_result, tool_error, model chunk milestones, turn end.
- `backend/src/lib/llm/olava.ts` — record stream lifecycle events (start, first_token_ms, finish_reason).

**Event taxonomy (mirrors existing SSE event names where possible).**
- `turn.started`
- `model.first_token` (with latency_ms)
- `tool.call_started` (name, args)
- `tool.call_succeeded` (name, latency_ms, result_length)
- `tool.call_failed` (name, error_code, latency_ms) — pairs with feat-016 envelope
- `loop.escalated` (reason) — written by feat-014
- `turn.completed` (total_tokens, total_steps, total_latency_ms)

**Key decisions.**
- **Fire-and-forget.** A failed audit insert must not break a chat. Wrap in try/catch.
- **Don't log message content.** `payload` carries metadata (tool name, latency, error code) but not user prompts or doc text — keep audit log small and PII-light. Full content lives in `chat_messages` already.
- **Don't replicate SSE.** SSE is the wire format to the frontend; agent_events is the backend audit. Different consumers, different lifecycles.

**Risks.**
- **DB write rate.** Each chat emits ~10–30 events. Negligible at current scale; add batched insert path if traffic grows.
- **PII leakage.** Strict review of what goes into `payload`. No content fields by default.

**Test plan.**
- Apply migration locally.
- Manual: send a chat, query `select * from agent_events where chat_id = '...' order by created_at` — verify expected sequence.
- Manual: induce a tool failure, verify `tool.call_failed` row.
- Verify no chat regression if the table is dropped (catch-all suppression works).

**Acceptance.**
- All listed event types are written for a normal chat.
- Querying by chat_id reconstructs the agent's path.
- No chat behaviour change visible to users.

---

### feat-016 Structured tool-result error envelope
**Status:** ready
**Branch:** `feat-016-tool-error-envelope`
**Priority:** Medium — improves model error recovery and structured logging
**Size:** Small-Medium (~½ day)
**Depends on:** feat-013 (cleanest if the tool registry exists; can land before with an adapter shim).

**Problem.** Tool errors today are returned as prose strings stuffed into `role:'tool'` content (e.g., `"document not found"`). The model can't distinguish *retryable* from *unrecoverable*, and observability has no structured signal to count failures by type.

**Approach.** All tool handlers return `{ ok: true, content } | { ok: false, error: { code, message, retryable } }`. The dispatcher renders the failure case to the model as a structured prose blurb (`"Tool error (code=NOT_FOUND, retryable=false): document not found"`) and emits a `tool.call_failed` agent_event (feat-015) with the structured payload.

**Files to modify.**
- `backend/src/lib/tools/types.ts` (from feat-013) — define `ToolResult` discriminated union.
- Each tool module (`readDocument.ts`, etc.) — return `ok:true|false` envelopes.
- Registry dispatch in `registry.ts` — render failures consistently for the model.

**Initial error code vocabulary.**
- `NOT_FOUND`, `PERMISSION_DENIED`, `RATE_LIMITED` (retryable), `INVALID_ARG`, `UPSTREAM_TIMEOUT` (retryable), `UPSTREAM_ERROR` (retryable), `INTERNAL`.

**Key decisions.**
- **Render failures as prose for the model.** Olava-001 wasn't trained on a structured error type; prose works. The structured envelope is for the dispatcher, the audit, and human debugging.
- **Keep tool happy-path content unchanged.** Only the failure path is wrapped.

**Test plan.**
- Unit: each tool's failure paths return correct envelope shape.
- Manual: induce each error class once; observe the model retries on retryable codes only, gives up on others.

**Acceptance.**
- All tools return the discriminated union.
- The model sees structured error prose; agent_events records structured payload.

---

### bug-006 Tighten Olava tool-call parser (require `</parameter>`)
**Status:** ready
**Branch:** `bug-006-strict-parser`
**Priority:** Medium — `SECURITY.md` H7. Low practical exploitability, easy fix.
**Size:** Small (~1 hour)

**Problem.** `backend/src/lib/llm/olava.ts:78-117 parseCustomToolCall()` splits on `<parameter=KEY>` and reads until the next opener. It doesn't require or validate `</parameter>` close tags. A value containing literal `<parameter=foo>` text misparses.

**Approach.** Rewrite the inner regex to match `<parameter=([^>]+)>(.*?)</parameter>` non-greedy with the `s` flag. Treat absence of close tag as a parse failure; log and fall back to the unparsed string-result path.

**Files to modify.**
- `backend/src/lib/llm/olava.ts` — `parseCustomToolCall()` only.
- `backend/tests/olavaParser.test.ts` — new test file: well-formed, missing close tag, embedded `<parameter=` in value, embedded `</parameter>` in value, multi-parameter ordering.

**Acceptance.**
- Parser tests pass for all listed cases.
- No regression on existing well-formed tool calls (manual `read_document` and `edit_document` flows).

---

### bug-007 Cap tabular generate concurrency
**Status:** ready
**Branch:** `bug-007-tabular-concurrency`
**Priority:** Medium — `SECURITY.md` H1, cost-DoS surface.
**Size:** Small (~1 hour)

**Problem.** `backend/src/routes/tabular.ts:960` fans out N parallel LLM calls for N documents with `Promise.all`. A user with 200 documents triggers 200 simultaneous LLM calls. Cost-DoS by accident or malice.

**Approach.** Add `p-limit` and cap concurrency at 5 in the tabular generation path.

**Files to modify.**
- `backend/src/routes/tabular.ts` — wrap the `Promise.all` in `pLimit(5)`.
- `backend/package.json` — add `p-limit` if not already a direct dep.

**Acceptance.**
- 200-doc tabular generate sends at most 5 LLM requests in flight.
- Throughput unchanged for small N (≤5).

---

## Open items (queued for next session)

### bug-005 Verifier blocks [DONE] for ~12s after model finishes
**Status:** ready, well-scoped
**Priority:** High — biggest user-perceived latency now

Per-marker verifier in `lib/research/citationVerifier.ts` is awaited at end-of-turn (`chatTools.ts:3009+`). Verifier calls take 12–17s each, and we wait for all in-flight before emitting `[DONE]`. The model's `<CITATIONS>` block already produces all pills via the existing parser — verifier results are duplicate work most of the time, and 3-of-4 come back empty in practice.

**Two options:**
- (A) Stop awaiting verifiers at end-of-turn. Cuts ~12s. Citations from `<CITATIONS>` block path land via existing flow; in-flight verifier results that didn't finish before `[DONE]` are lost.
- (B) Disable verifier entirely. Same speed win; even simpler. Re-enable selectively if/when we observe `<CITATIONS>` block skips again.

User leans (B). 1-line change.

### feat-011 vLLM prefix caching
**Status:** ready (vLLM-side flag flip)
**Priority:** Medium — second-biggest first-token latency

vLLM has `--enable-prefix-caching` which caches KV across requests with shared prompt prefixes. With our system prompt + image content as the prefix, second chat against the same doc would skip vision encoding entirely. ~5–15s savings on repeat chats. No backend code change.

### feat-018 Project memory (Tier 2 of feat-017): per-project persistent facts
**Status:** ready, deferred from feat-017 v1
**Priority:** Medium — pick up if chats-across-sessions context loss is still felt after feat-017 ships

Per-project key/value store of facts surfaced into every chat in that project. Schema: `project_memory(id, project_id, key, value, source, created_by, created_at, updated_at)` with RLS by project_id (same pattern as `projects` policies). Manual CRUD via `GET/POST/PUT/DELETE /projects/:id/memory`. Loaded at chat session start, injected into system prompt as `KNOWN FACTS:\n- key: value\n- ...`. Frontend: `MemoryPanel.tsx` in the project sidebar with inline edit/add. Auto-extraction from chat content (background extractor agent) is a v2 nice-to-have, out of scope.

Full design preserved in the feat-017 entry above (the "Tier 2 — Project memory" section was originally part of feat-017 and was scoped out per user request).

### feat-012 Text-as-image compression for chat history / tool results
**Status:** spike done, decision deferred
**Priority:** Low

Inspired by the EMNLP 2025 paper (`Text or Pixels? It Takes Half`). Spike (`backend/scripts/spike_compression.ts`) showed `text-img-6pt` gets ~0.42× tokens vs raw text on legal docs with mostly-preserved fidelity, but is inconsistent on factual queries. Worth revisiting if we hit context-window pressure on long chat histories or tool result blobs (search results, doc text). Don't ship for PDF context — `pdf-4up` (feat-008) is the answer there.

### feat-006 Reliable document citations via tool-calling
**Status:** parked (see Outcome note above)
**Priority:** Defer — current `<CITATIONS>` JSON path works in practice

Re-engage if we see citation reliability drop again. Tool definition + dispatch remain in `chatTools.ts`; just need to flip the system prompt back to the `add_citation`-instructive variant.
