// Shared types for the multi-pass research orchestrator.
//
// The pipeline produces a stream of these events that the frontend renders
// as a progress checklist alongside the streamed answer prose. They're also
// persisted as part of the assistant message's events[] so reloading shows
// the same checklist.

export type ResearchTarget = "legal" | "web";

export type ExpandedQuery = {
    query: string;
    target: ResearchTarget;
    /** Subset of legal source keys, only for target=legal. Defaults to all. */
    sources?: string[];
};

export type RankedResult = {
    source_kind: ResearchTarget;
    title: string;
    url: string;
    snippet: string;
    /** Human-readable origin: "CourtListener", "Federal Register", "Web", etc. */
    source_label: string;
    date?: string;
    /** Set after pass 4 — 2-3 sentence summary tailored to the user's question. */
    extract?: string;
};

/** Progress events emitted to the SSE stream. Mirrored in the frontend. */
export type ResearchEvent =
    | { type: "research.start" }
    | { type: "research.expanding_queries" }
    | { type: "research.queries_ready"; queries: ExpandedQuery[] }
    | {
          type: "research.searching";
          /** How many queries fanned out across legal and web in total. */
          count: number;
      }
    | {
          type: "research.search_complete";
          /** Total raw results before dedupe. */
          raw_count: number;
          /** Unique results after dedupe by URL. */
          unique_count: number;
      }
    | { type: "research.ranking" }
    | {
          type: "research.ranked";
          /** How many top-N were selected for extraction. */
          top_n: number;
      }
    | { type: "research.extracting"; total: number }
    | { type: "research.extract_progress"; done: number; total: number }
    | { type: "research.synthesizing" }
    | {
          type: "research.cap_hit";
          /** Which cap tripped: "calls" (Olava-call limit) or "wallclock" (time). */
          cap: "calls" | "wallclock";
      }
    | { type: "research.fallback"; reason: string };

/** Frontend-facing checklist step keys. */
export type ResearchStepKey =
    | "expanding_queries"
    | "searching"
    | "ranking"
    | "extracting"
    | "synthesizing";
