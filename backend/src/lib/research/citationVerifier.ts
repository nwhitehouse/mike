import { completeOlavaText } from "../llm/olava";

export type VerifierInput = {
    /** The [N] / superscript-N number being verified. */
    marker: number;
    /** The chat-local doc label this citation should be attributed to. */
    docId: string;
    /** Prose written so far, ending at (or just past) the marker. */
    proseSoFar: string;
    /** Full document text with [Page N] markers prepended per page (the
     *  output of extractPdfText). The verifier reads from this to find the
     *  page + verbatim quote. */
    docText: string;
};

export type VerifierResult = {
    ref: number;
    doc_id: string;
    page: number | string;
    quote: string;
};

/**
 * Verify a single inline citation marker. Cheap, single non-streaming
 * Olava call. Designed to be called many in parallel — the SLM cost
 * profile makes per-marker fan-out cheaper than a one-shot end-of-turn
 * pass that has to track every marker at once.
 *
 * Returns null on any failure (model didn't follow the JSON format,
 * doc text didn't contain a matching quote, etc.) — caller treats
 * "no verification" as "this marker won't render as a pill" without
 * blowing up the rest of the response.
 */
export async function verifyCitation(
    input: VerifierInput,
    model = "olava-extract",
): Promise<VerifierResult | null> {
    // Bound the doc text we send. Even with 256K vLLM context, the
    // verifier only needs to find a short verbatim phrase — the full
    // document is overkill and slows the call down. Cap at ~30K chars,
    // which is roughly 7-8K tokens — comfortably fits a hundred pages
    // of text-extracted PDF.
    const docExcerpt =
        input.docText.length <= 30000
            ? input.docText
            : input.docText.slice(0, 30000);

    const claimWindow = takeClaimWindow(input.proseSoFar, input.marker);

    const prompt =
        `You are validating a single inline citation in an assistant's response. The assistant wrote the prose below and inserted [${input.marker}] to mark a claim that needs to be cited from the document.

Prose containing the [${input.marker}] marker:
---
${claimWindow}
---

Document content (with [Page N] markers prefixing each page):
---
${docExcerpt}
---

Find the page and verbatim quote in the document that supports the specific claim immediately before [${input.marker}] in the prose. Respond with ONLY a JSON object on a single line, no commentary, no code fences:

{"page": <integer page number>, "quote": "<short verbatim text from the document, ≤ 25 words>"}

Rules:
- "page" MUST be the integer N from the [Page N] marker that contains the supporting text.
- "quote" MUST appear verbatim in the document content above. Do not paraphrase.
- Keep the quote short and tightly scoped to the cited claim.
- If you cannot find supporting text in the document, respond with {"page": 0, "quote": ""} — the citation will be skipped.`;

    let raw: string;
    try {
        raw = await completeOlavaText({
            model,
            user: prompt,
            // Verifier responses are tiny — a few dozen tokens. Cap so
            // a runaway model doesn't burn through context.
            maxTokens: 256,
        });
    } catch (err) {
        console.warn(`[verifier] marker=${input.marker} fetch failed:`, err);
        return null;
    }

    const parsed = extractFirstJsonObject(raw);
    if (!parsed) {
        console.warn(
            `[verifier] marker=${input.marker} no JSON in response: ${raw.slice(0, 200)}`,
        );
        return null;
    }

    const page = parsed.page;
    const quote = parsed.quote;
    if (typeof quote !== "string" || quote.trim() === "") {
        console.warn(
            `[verifier] marker=${input.marker} empty quote — model said: page=${JSON.stringify(page)} quote=${JSON.stringify(quote)}`,
        );
        return null;
    }
    if (typeof page !== "number" || !Number.isFinite(page) || page <= 0) {
        console.warn(
            `[verifier] marker=${input.marker} bad page — model said: page=${JSON.stringify(page)} quote=${JSON.stringify(quote).slice(0, 80)}`,
        );
        return null;
    }

    return {
        ref: input.marker,
        doc_id: input.docId,
        page: Math.trunc(page),
        quote,
    };
}

/**
 * Find the first standalone JSON object in `text`. Defensive against
 * model wrapping the JSON in code fences, prose, or chain-of-thought.
 */
function extractFirstJsonObject(
    text: string,
): { page?: unknown; quote?: unknown } | null {
    const m = text.match(/\{[\s\S]*?\}/);
    if (!m) return null;
    try {
        return JSON.parse(m[0]) as { page?: unknown; quote?: unknown };
    } catch {
        return null;
    }
}

/**
 * Trim the prose to roughly the sentence containing the marker, plus a
 * little context on either side. Keeps the verifier prompt small without
 * losing the claim.
 */
function takeClaimWindow(prose: string, marker: number): string {
    const markerToken = `[${marker}]`;
    const idx = prose.lastIndexOf(markerToken);
    if (idx < 0) return prose.slice(-1500); // marker not found, give recent tail
    const start = findSentenceStart(prose, idx);
    const end = Math.min(prose.length, idx + markerToken.length + 200);
    return prose.slice(start, end);
}

function findSentenceStart(text: string, fromIdx: number): number {
    // Walk back to the previous sentence terminator (or document start).
    // Limit to 1500 chars back so a long flowing paragraph doesn't blow up.
    const lowerBound = Math.max(0, fromIdx - 1500);
    for (let i = fromIdx; i > lowerBound; i--) {
        const ch = text[i];
        if (ch === "." || ch === "?" || ch === "!" || ch === "\n") {
            // Skip past the punctuation + whitespace
            let j = i + 1;
            while (j < text.length && /\s/.test(text[j])) j++;
            return j;
        }
    }
    return lowerBound;
}
