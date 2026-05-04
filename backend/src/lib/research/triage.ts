// Pass 3 — triage and rank.
//
// Asks Olava to pick the top-N most relevant results out of the deduped pool.
// Input is sent compactly (one line per result with index, title, source,
// date, snippet head) so the model's context can hold 30+ candidates without
// trouble. Output is a JSON array of indices into the input pool.
//
// Defensive parsing + fallback: if JSON fails or the array is empty, we
// take the first N results in pool order (which is the order returned by
// the search providers — already relevance-sorted within each query).

import { completeOlavaText } from "../llm/olava";
import type { RankedResult } from "./types";

const SYSTEM = `You triage legal research results. Given a user question and a numbered list of
candidate results, pick the indices of the most relevant ones — favouring
recency and direct relevance to the question.

Output a JSON array of integer indices (zero-based) in priority order, length
between 5 and 10. Return ONLY the JSON array. No prose. No markdown fences.

Example output: [3, 7, 1, 12, 0, 5, 9]`;

const DEFAULT_TOP_N = 8;
const MIN_TOP_N = 5;
const MAX_TOP_N = 10;

function buildUserPrompt(question: string, pool: RankedResult[]): string {
    const lines = pool.map((r, i) => {
        const date = r.date ? ` [${r.date}]` : "";
        const snip = (r.snippet || "").slice(0, 180).replace(/\s+/g, " ");
        return `${i}. (${r.source_label})${date} ${r.title} — ${snip}`;
    });
    return `User question: ${question}

Candidates:
${lines.join("\n")}

JSON array of indices (priority order, length 5-10):`;
}

function extractJsonArray(raw: string): unknown[] | null {
    const cleaned = raw
        .replace(/```json\s*/gi, "")
        .replace(/```\s*/g, "")
        .trim();
    const start = cleaned.indexOf("[");
    const end = cleaned.lastIndexOf("]");
    if (start < 0 || end <= start) return null;
    try {
        const parsed = JSON.parse(cleaned.slice(start, end + 1));
        return Array.isArray(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

export async function triageResults(args: {
    model: string;
    question: string;
    pool: RankedResult[];
    topN?: number;
}): Promise<RankedResult[]> {
    const { model, question, pool } = args;
    const topN = Math.min(
        MAX_TOP_N,
        Math.max(MIN_TOP_N, args.topN ?? DEFAULT_TOP_N),
    );

    if (pool.length === 0) return [];
    if (pool.length <= topN) return pool;

    let raw = "";
    try {
        raw = await completeOlavaText({
            model,
            systemPrompt: SYSTEM,
            user: buildUserPrompt(question, pool),
        });
    } catch (err) {
        console.warn("[research/triage] Olava call failed, using pool order:", err);
        return pool.slice(0, topN);
    }

    const arr = extractJsonArray(raw);
    if (!arr || arr.length === 0) {
        console.warn("[research/triage] could not parse, using pool order");
        return pool.slice(0, topN);
    }

    const seen = new Set<number>();
    const picked: RankedResult[] = [];
    for (const idx of arr) {
        if (typeof idx !== "number" || !Number.isInteger(idx)) continue;
        if (idx < 0 || idx >= pool.length) continue;
        if (seen.has(idx)) continue;
        seen.add(idx);
        picked.push(pool[idx]);
        if (picked.length >= topN) break;
    }
    if (picked.length === 0) return pool.slice(0, topN);
    return picked;
}
