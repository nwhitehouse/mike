// Pass 4 — per-result extraction.
//
// For each top-N result, fire a parallel non-streaming Olava call asking for
// a 2-3 sentence extract that's tailored to the user's original question.
// The synthesizer (pass 5) then composes from these structured extracts
// instead of from raw snippets — much higher signal density.
//
// Failed extracts fall back to the original snippet so synthesis isn't
// blocked. Budget enforcement is the caller's responsibility — we run
// whatever we're given, in parallel.

import { completeOlavaText } from "../llm/olava";
import type { RankedResult } from "./types";

const SYSTEM = `You read one source result and produce a 2-3 sentence summary tailored to a
user's research question. Focus on facts directly relevant to the question.
Mention dates, parties, and key holdings when present. Plain prose only — no
markdown, no bullets, no preamble like "This source describes…".`;

const MAX_EXTRACT_TOKENS = 400; // generous to allow Olava's reasoning headroom

function buildUserPrompt(question: string, r: RankedResult): string {
    const date = r.date ? ` (${r.date})` : "";
    return `User question: ${question}

Source: ${r.title}${date}
From: ${r.source_label}
URL: ${r.url}
Snippet:
${r.snippet || "(no snippet available)"}

Write a 2-3 sentence summary tailored to the question:`;
}

export async function extractOne(args: {
    model: string;
    question: string;
    result: RankedResult;
}): Promise<RankedResult> {
    const { model, question, result } = args;
    try {
        const raw = await completeOlavaText({
            model,
            systemPrompt: SYSTEM,
            user: buildUserPrompt(question, result),
            maxTokens: MAX_EXTRACT_TOKENS,
        });
        const extract = raw.trim();
        return { ...result, extract: extract || result.snippet };
    } catch (err) {
        console.warn(
            `[research/extractor] failed for "${result.title.slice(0, 40)}":`,
            err,
        );
        return { ...result, extract: result.snippet };
    }
}

/**
 * Extract all top-N results in parallel. `onProgress` fires after each one
 * completes so the orchestrator can stream progress to the UI.
 */
export async function extractMany(args: {
    model: string;
    question: string;
    results: RankedResult[];
    onProgress?: (done: number, total: number) => void;
}): Promise<RankedResult[]> {
    const { model, question, results, onProgress } = args;
    const total = results.length;
    let done = 0;
    return Promise.all(
        results.map(async (r) => {
            const enriched = await extractOne({ model, question, result: r });
            done += 1;
            onProgress?.(done, total);
            return enriched;
        }),
    );
}
