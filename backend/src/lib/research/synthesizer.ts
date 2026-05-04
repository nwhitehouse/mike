// Pass 5 — synthesis.
//
// Takes the user's question + the per-result extracts from pass 4 and
// produces a narrative answer with inline [Title](URL) citations. Streams
// tokens to the user via the existing streamOlava path — no tools forwarded
// (this pass doesn't need any). The synthesis model is the same Olava
// model used for the other passes; we don't pay for a frontier model here.

import { streamOlava } from "../llm/olava";
import type { RankedResult } from "./types";

const SYSTEM = `You are a legal research synthesiser. Given a user's question and structured
extracts from several sources, write a comprehensive answer that:
  - directly addresses the user's question with the strongest evidence first
  - uses inline markdown links [Title](URL) every time you reference a source
  - groups related cases and contrasts dissenting views when relevant
  - is concise but complete — no padding, no recap of the question
  - stops cleanly when the answer is done; do not invite follow-up questions

If the extracts don't actually answer the question, say so plainly and point
to the closest-related sources.

Output well-formatted markdown. Do not include a "References" section — the
inline links are the citations.`;

function buildUserPrompt(question: string, results: RankedResult[]): string {
    const blocks = results.map((r, i) => {
        const date = r.date ? ` (${r.date})` : "";
        const extract = r.extract || r.snippet || "(no extract)";
        return `[${i + 1}] ${r.title}${date}
From: ${r.source_label}
URL: ${r.url}
${extract}`;
    });
    return `User question: ${question}

Sources:

${blocks.join("\n\n")}

Write the answer now (markdown, inline [Title](URL) citations):`;
}

export async function synthesize(args: {
    model: string;
    question: string;
    results: RankedResult[];
    onContentDelta: (text: string) => void;
}): Promise<{ fullText: string }> {
    const { model, question, results, onContentDelta } = args;
    const userPrompt = buildUserPrompt(question, results);
    const result = await streamOlava({
        model,
        systemPrompt: SYSTEM,
        messages: [{ role: "user", content: userPrompt }],
        tools: [],
        callbacks: { onContentDelta },
        maxIterations: 1,
    });
    return { fullText: result.fullText };
}
