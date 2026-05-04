// Multi-pass research orchestrator.
//
// Trigger: chat.ts routes here when the user has any source selected
// (legal sources picker non-empty OR globe-icon web toggle on). We
// presume "user wants depth" from that signal — see auto-detect decision
// in feat-005 plan.
//
// Pipeline (5 passes), see backlog.md feat-005 entry for the full rationale:
//   1. queryExpander  — 1 Olava call → 3-6 specialised search queries
//   2. searchFanOut   — parallel legal/web searches, dedupe by URL
//   3. triage         — 1 Olava call → top-N (5-10) most relevant
//   4. extractor      — N parallel Olava calls → 2-3 sentence extract per result
//   5. synthesizer    — 1 streaming Olava call → final markdown answer
//
// Caps: ResearchBudget enforces ≤25 Olava calls and ≤45s wall-clock per turn.
// When a cap trips we emit `research.cap_hit` and degrade gracefully — return
// whatever we have synthesised (or fall back to single-pass) rather than
// abort.
//
// Persistence: events flow into the same `events[]` array the chat route
// stores on chat_messages, so reload shows the same checklist + cards.

import { ResearchBudget } from "./budget";
import { expandQueries } from "./queryExpander";
import { fanOutSearches } from "./searchFanOut";
import { triageResults } from "./triage";
import { extractMany } from "./extractor";
import { synthesize } from "./synthesizer";
import type { RankedResult, ResearchEvent } from "./types";

type AssistantEvent =
    | { type: "content"; text: string }
    | {
          type: "reference_added";
          source_kind: "legal" | "web";
          title: string;
          url: string;
          snippet: string;
          source_label: string;
          date?: string;
      }
    | { type: "research_step"; key: string; status: string; meta?: Record<string, unknown> };

export type ResearchOrchestratorParams = {
    model: string;
    question: string;
    legalSources: string[];
    webEnabled: boolean;
    write: (s: string) => void;
};

export type ResearchOrchestratorResult = {
    fullText: string;
    events: AssistantEvent[];
    /** True when at least the synthesis step completed (even if cap hit later). */
    completed: boolean;
};

function emitSse(write: (s: string) => void, e: ResearchEvent | object) {
    write(`data: ${JSON.stringify(e)}\n\n`);
}

function emitStep(
    write: (s: string) => void,
    events: AssistantEvent[],
    key: string,
    status: "running" | "done" | "failed" | "skipped",
    meta?: Record<string, unknown>,
) {
    const evt = { type: "research_step" as const, key, status, meta };
    write(`data: ${JSON.stringify(evt)}\n\n`);
    // Dedupe by key in the persisted array — replace any prior entry for
    // this step instead of appending. Otherwise a reload shows both the
    // "running" and "done" state of every step (see 2026-05-04 bug report).
    const existingIdx = events.findIndex(
        (e) =>
            e.type === "research_step" &&
            (e as { key?: string }).key === key,
    );
    if (existingIdx >= 0) {
        events[existingIdx] = evt;
    } else {
        events.push(evt);
    }
}

export async function runResearchOrchestrator(
    params: ResearchOrchestratorParams,
): Promise<ResearchOrchestratorResult> {
    const { model, question, legalSources, webEnabled, write } = params;
    const events: AssistantEvent[] = [];
    const budget = new ResearchBudget();

    emitSse(write, { type: "research.start" });

    // ---- Pass 1: query expansion ----
    emitSse(write, { type: "research.expanding_queries" });
    emitStep(write, events, "expanding_queries", "running");
    if (!budget.tryConsumeCall()) {
        emitSse(write, { type: "research.cap_hit", cap: budget.capHitReason()! });
        emitStep(write, events, "expanding_queries", "skipped");
        return { fullText: "", events, completed: false };
    }
    const queries = await expandQueries({
        model,
        question,
        legalSources,
        webEnabled,
    });
    emitSse(write, { type: "research.queries_ready", queries });
    emitStep(write, events, "expanding_queries", "done", {
        count: queries.length,
    });

    if (queries.length === 0) {
        emitSse(write, {
            type: "research.fallback",
            reason: "no queries produced",
        });
        return { fullText: "", events, completed: false };
    }

    // ---- Pass 2: parallel search fan-out ----
    emitSse(write, { type: "research.searching", count: queries.length });
    emitStep(write, events, "searching", "running", { count: queries.length });
    if (budget.wallClockExpired()) {
        emitSse(write, { type: "research.cap_hit", cap: "wallclock" });
        emitStep(write, events, "searching", "skipped");
        return { fullText: "", events, completed: false };
    }
    const fan = await fanOutSearches(queries);
    emitSse(write, {
        type: "research.search_complete",
        raw_count: fan.raw,
        unique_count: fan.unique.length,
    });
    emitStep(write, events, "searching", "done", {
        raw_count: fan.raw,
        unique_count: fan.unique.length,
    });

    if (fan.unique.length === 0) {
        emitSse(write, {
            type: "research.fallback",
            reason: "no results found",
        });
        return { fullText: "", events, completed: false };
    }

    // ---- Pass 3: triage ----
    emitSse(write, { type: "research.ranking" });
    emitStep(write, events, "ranking", "running");
    let topN: RankedResult[];
    if (!budget.tryConsumeCall() || budget.wallClockExpired()) {
        // Fall back to pool order.
        topN = fan.unique.slice(0, 8);
        emitStep(write, events, "ranking", "skipped");
    } else {
        topN = await triageResults({ model, question, pool: fan.unique });
        emitSse(write, { type: "research.ranked", top_n: topN.length });
        emitStep(write, events, "ranking", "done", { top_n: topN.length });
    }

    // Emit reference_added events + persist for the chosen top-N. These are
    // the cards the user will see (feat-004 rendering). We do this before
    // extraction so cards appear as soon as ranking is done — extracts fill
    // in shortly after.
    for (const r of topN) {
        const ref = {
            type: "reference_added" as const,
            source_kind: r.source_kind,
            title: r.title,
            url: r.url,
            snippet: r.snippet,
            source_label: r.source_label,
            date: r.date,
        };
        write(`data: ${JSON.stringify(ref)}\n\n`);
        events.push(ref);
    }

    // ---- Pass 4: parallel per-result extraction ----
    emitSse(write, { type: "research.extracting", total: topN.length });
    emitStep(write, events, "extracting", "running", { total: topN.length });
    let enriched: RankedResult[] = topN;
    const remaining = budget.callsRemaining();
    if (remaining < topN.length || budget.wallClockExpired()) {
        // Skip extraction — synthesis can still work from raw snippets.
        emitStep(write, events, "extracting", "skipped");
    } else {
        // Reserve one call for synthesis.
        if (remaining - topN.length < 1) {
            emitStep(write, events, "extracting", "skipped");
        } else {
            // Consume the budget upfront so concurrent calls don't race past
            // the cap. tryConsumeCall increments the counter atomically.
            const allowed = topN.filter(() => budget.tryConsumeCall());
            if (allowed.length < topN.length) {
                // Couldn't reserve all — proceed with whoever fits.
                console.warn(
                    `[research/orchestrator] budget allowed only ${allowed.length}/${topN.length} extracts`,
                );
            }
            const enrichedSubset = await extractMany({
                model,
                question,
                results: allowed,
                onProgress: (done, total) => {
                    emitSse(write, {
                        type: "research.extract_progress",
                        done,
                        total,
                    });
                },
            });
            // Merge enriched extracts back into topN (preserving order); any
            // result that didn't fit in budget keeps its original snippet.
            const byUrl = new Map(enrichedSubset.map((r) => [r.url, r]));
            enriched = topN.map((r) => byUrl.get(r.url) ?? r);
            emitStep(write, events, "extracting", "done", {
                done: enrichedSubset.length,
                total: topN.length,
            });
        }
    }

    // ---- Pass 5: synthesis (streamed) ----
    emitSse(write, { type: "research.synthesizing" });
    emitStep(write, events, "synthesizing", "running");
    if (!budget.tryConsumeCall()) {
        emitSse(write, { type: "research.cap_hit", cap: budget.capHitReason()! });
        emitStep(write, events, "synthesizing", "skipped");
        // Degrade: emit a minimal content event listing the references.
        const fallbackText = buildFallbackText(enriched);
        if (fallbackText) {
            write(
                `data: ${JSON.stringify({ type: "content_delta", text: fallbackText })}\n\n`,
            );
            events.push({ type: "content", text: fallbackText });
            return { fullText: fallbackText, events, completed: true };
        }
        return { fullText: "", events, completed: false };
    }

    let visibleText = "";
    let synthErr: unknown = null;
    try {
        const result = await synthesize({
            model,
            question,
            results: enriched,
            onContentDelta: (text) => {
                visibleText += text;
                write(
                    `data: ${JSON.stringify({ type: "content_delta", text })}\n\n`,
                );
            },
        });
        visibleText = result.fullText;
    } catch (err) {
        synthErr = err;
        console.warn("[research/orchestrator] synthesis failed:", err);
    }

    if (synthErr || !visibleText.trim()) {
        // Synthesis produced nothing — fall back to a structured list.
        const fallbackText = buildFallbackText(enriched);
        if (fallbackText) {
            write(
                `data: ${JSON.stringify({ type: "content_delta", text: fallbackText })}\n\n`,
            );
            events.push({ type: "content", text: fallbackText });
            emitStep(write, events, "synthesizing", "failed");
            return { fullText: fallbackText, events, completed: true };
        }
        emitStep(write, events, "synthesizing", "failed");
        return { fullText: "", events, completed: false };
    }

    events.push({ type: "content", text: visibleText });
    emitStep(write, events, "synthesizing", "done");

    return { fullText: visibleText, events, completed: true };
}

/** Last-ditch text when synthesis produces nothing — at least give the user the cards laid out. */
function buildFallbackText(results: RankedResult[]): string {
    if (results.length === 0) return "";
    const lines = [
        "I couldn't synthesise a narrative answer from the available sources, but here are the most relevant results:",
        "",
    ];
    for (const r of results) {
        const date = r.date ? ` (${r.date})` : "";
        const link = r.url ? `[${r.title}](${r.url})` : r.title;
        lines.push(`- ${link} — ${r.source_label}${date}`);
        if (r.extract || r.snippet) {
            lines.push(`  ${(r.extract || r.snippet).slice(0, 240)}`);
        }
    }
    return lines.join("\n");
}
