// Pass 1 — query expansion.
//
// Asks Olava to fan one user question out into 3-5 specialised search
// queries, each tagged for legal or web. Olava is a small model so we
// (a) prompt strongly for JSON-only output, (b) parse defensively
// (extract the first JSON array we can find), and (c) fall back to a
// single passthrough query if parsing fails — degraded but never blocks
// the orchestrator.

import { completeOlavaText } from "../llm/olava";
import type { ExpandedQuery } from "./types";

const SYSTEM = `You are a legal research query planner. Given a user question and the
research sources they have available, produce a JSON array of 3-5 specialised
search queries that together cover the question.

Each item must have:
  - "query": a short search-engine-style query string (3-10 words)
  - "target": "legal" or "web" — pick the more useful source for that query

Return ONLY the JSON array. No prose. No markdown fences.`;

const MAX_QUERIES = 6; // hard cap regardless of what the model returns

function buildUserPrompt(args: {
    question: string;
    legalSources: string[];
    webEnabled: boolean;
}): string {
    const sources: string[] = [];
    if (args.legalSources.length) {
        sources.push(`legal databases: ${args.legalSources.join(", ")}`);
    }
    if (args.webEnabled) sources.push(`web search`);
    const sourcesLine = sources.length
        ? `Available sources: ${sources.join("; ")}.`
        : "Available sources: none.";
    return `${sourcesLine}

User question: ${args.question}

JSON array:`;
}

/** Best-effort extract a JSON array from a model response. */
function extractJsonArray(raw: string): unknown[] | null {
    // Strip markdown fences if the model wrapped it anyway.
    const cleaned = raw
        .replace(/```json\s*/gi, "")
        .replace(/```\s*/g, "")
        .trim();
    // Find the first [...] block. Greedy because nested objects might exist.
    const start = cleaned.indexOf("[");
    const end = cleaned.lastIndexOf("]");
    if (start < 0 || end <= start) return null;
    const slice = cleaned.slice(start, end + 1);
    try {
        const parsed = JSON.parse(slice);
        return Array.isArray(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

function fallbackQueries(
    question: string,
    legalSources: string[],
    webEnabled: boolean,
): ExpandedQuery[] {
    const out: ExpandedQuery[] = [];
    if (legalSources.length > 0) {
        out.push({ query: question, target: "legal", sources: legalSources });
    }
    if (webEnabled) {
        out.push({ query: question, target: "web" });
    }
    return out;
}

export async function expandQueries(args: {
    model: string;
    question: string;
    legalSources: string[];
    webEnabled: boolean;
}): Promise<ExpandedQuery[]> {
    const { model, question, legalSources, webEnabled } = args;

    let raw = "";
    try {
        raw = await completeOlavaText({
            model,
            systemPrompt: SYSTEM,
            user: buildUserPrompt({ question, legalSources, webEnabled }),
        });
    } catch (err) {
        console.warn("[research/queryExpander] Olava call failed:", err);
        return fallbackQueries(question, legalSources, webEnabled);
    }

    const arr = extractJsonArray(raw);
    if (!arr) {
        console.warn(
            "[research/queryExpander] could not parse JSON, using fallback. raw_len=",
            raw.length,
        );
        return fallbackQueries(question, legalSources, webEnabled);
    }

    const validLegalSources = new Set(legalSources);
    const queries: ExpandedQuery[] = [];
    for (const item of arr) {
        if (queries.length >= MAX_QUERIES) break;
        if (typeof item !== "object" || item === null) continue;
        const obj = item as Record<string, unknown>;
        const queryStr = typeof obj.query === "string" ? obj.query.trim() : "";
        const targetRaw = obj.target;
        if (!queryStr) continue;
        const target: ExpandedQuery["target"] =
            targetRaw === "legal" && legalSources.length > 0
                ? "legal"
                : webEnabled
                  ? "web"
                  : legalSources.length > 0
                    ? "legal"
                    : "web";
        const eq: ExpandedQuery = { query: queryStr, target };
        if (target === "legal") {
            // Restrict to user-allowed sources only; if model returned a
            // sources field, intersect with allowed.
            const modelSources = Array.isArray(obj.sources)
                ? (obj.sources as unknown[]).filter(
                      (s): s is string => typeof s === "string",
                  )
                : null;
            const intersected = modelSources
                ? modelSources.filter((s) => validLegalSources.has(s))
                : legalSources;
            eq.sources =
                intersected.length > 0 ? intersected : legalSources;
        }
        queries.push(eq);
    }

    if (queries.length === 0) {
        return fallbackQueries(question, legalSources, webEnabled);
    }
    return queries;
}
