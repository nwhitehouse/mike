// Pass 2 — parallel search fan-out.
//
// Dispatches each expanded query to legalSearch or webSearch in parallel.
// Aggregates, dedupes by URL, normalises into RankedResult shape (without
// `extract` set; that's filled by pass 4).

import { legalSearch, type LegalSourceKey } from "../legalSearch";
import { webSearch } from "../webSearch";
import type { ExpandedQuery, RankedResult } from "./types";

/** Per-query result count cap. Keeps the dedup'd pool bounded. */
const COUNT_PER_QUERY = 5;

export async function fanOutSearches(
    queries: ExpandedQuery[],
): Promise<{ raw: number; unique: RankedResult[] }> {
    const tasks = queries.map((q) => runOne(q));
    const settled = await Promise.allSettled(tasks);

    const all: RankedResult[] = [];
    for (let i = 0; i < settled.length; i++) {
        const s = settled[i];
        if (s.status === "fulfilled") {
            all.push(...s.value);
        } else {
            console.warn(
                `[research/searchFanOut] query "${queries[i].query}" failed:`,
                s.reason,
            );
        }
    }

    // Dedupe by URL (keep first occurrence — the query that found it earliest
    // also tends to be the most-relevant per relevance-sort).
    const seen = new Set<string>();
    const unique: RankedResult[] = [];
    for (const r of all) {
        const key = r.url || `${r.source_label}:${r.title}`;
        if (seen.has(key)) continue;
        seen.add(key);
        unique.push(r);
    }
    return { raw: all.length, unique };
}

async function runOne(q: ExpandedQuery): Promise<RankedResult[]> {
    if (q.target === "legal") {
        const results = await legalSearch(
            q.query,
            (q.sources as LegalSourceKey[] | undefined),
            COUNT_PER_QUERY,
        );
        return results.map((r) => ({
            source_kind: "legal",
            title: r.title,
            url: r.url,
            snippet: r.snippet,
            source_label: r.source,
            date: r.date,
        }));
    } else {
        const results = await webSearch(q.query, COUNT_PER_QUERY);
        return results.map((r) => ({
            source_kind: "web",
            title: r.title,
            url: r.url,
            snippet: r.snippet,
            source_label: "Web",
        }));
    }
}
