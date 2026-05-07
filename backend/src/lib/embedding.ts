/**
 * feat-024 — OpenAI embeddings helper for the RAG-chat pipeline.
 *
 * Direct fetch (no openai SDK dependency) so the backend stays slim and
 * mirrors the existing olava.ts pattern of talking to a remote inference
 * endpoint over plain HTTP.
 *
 * Single model: `text-embedding-3-small` (1536 dim, cosine similarity,
 * matches migration 007's `vector(1536)` column). Cheaper than -large
 * (~$0.02/M tokens vs $0.13/M) at minimal accuracy cost on legal text;
 * picked deliberately so a 200-doc backfill costs ~$0.20 not ~$1.30.
 */

const EMBEDDING_MODEL = "text-embedding-3-small";
const EMBEDDING_DIMENSIONS = 1536;
// OpenAI's max for /v1/embeddings is 2048 inputs/request; 100 keeps a
// single failed batch from costing too much, and at ~6KB per chunk
// stays well under the 300K-token-per-request payload limit.
const BATCH_SIZE = 100;

const OPENAI_ENDPOINT = "https://api.openai.com/v1/embeddings";

function apiKey(): string {
    const key = process.env.OPENAI_API_KEY?.trim();
    if (!key) {
        throw new Error(
            "OPENAI_API_KEY is not set — required for feat-024 RAG embeddings.",
        );
    }
    return key;
}

export type EmbeddingError = {
    status: number;
    message: string;
};

/**
 * Embed a batch of strings. Returns one Float32-style number[] per input,
 * preserving order. Throws on persistent error (caller decides whether to
 * mark the doc-job item failed or retry on lease expiry).
 *
 * Implements exponential backoff for 429 (rate limit) and 5xx. 4xx other
 * than 429 fail fast — they're a request shape problem, retrying won't
 * help.
 */
export async function embedBatch(inputs: string[]): Promise<number[][]> {
    if (inputs.length === 0) return [];
    if (inputs.length > BATCH_SIZE) {
        const out: number[][] = [];
        for (let i = 0; i < inputs.length; i += BATCH_SIZE) {
            const slice = inputs.slice(i, i + BATCH_SIZE);
            const part = await embedBatch(slice);
            out.push(...part);
        }
        return out;
    }

    const body = {
        model: EMBEDDING_MODEL,
        input: inputs,
        // Returning floats over base64 to keep the parser simple. Trade-off
        // is 4× the response size; embedding-side bandwidth dwarfs this.
        encoding_format: "float" as const,
    };

    let attempt = 0;
    const maxAttempts = 5;
    while (attempt < maxAttempts) {
        attempt += 1;
        const resp = await fetch(OPENAI_ENDPOINT, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${apiKey()}`,
            },
            body: JSON.stringify(body),
        });
        if (resp.ok) {
            const json = (await resp.json()) as {
                data: { index: number; embedding: number[] }[];
            };
            // Sort by index because OpenAI doesn't guarantee return order.
            const sorted = [...json.data].sort((a, b) => a.index - b.index);
            const vectors = sorted.map((r) => r.embedding);
            // Cheap sanity check — wrong dim means the model returned a
            // shape that won't fit our pgvector(1536) column. Fail fast.
            for (const v of vectors) {
                if (v.length !== EMBEDDING_DIMENSIONS) {
                    throw new Error(
                        `[embedding] expected ${EMBEDDING_DIMENSIONS}-dim vectors, got ${v.length}`,
                    );
                }
            }
            return vectors;
        }
        if (resp.status === 429 || resp.status >= 500) {
            const wait = Math.min(2000 * 2 ** (attempt - 1), 30_000);
            console.warn(
                `[embedding] ${resp.status} — backing off ${wait}ms (attempt ${attempt}/${maxAttempts})`,
            );
            await new Promise((r) => setTimeout(r, wait));
            continue;
        }
        // Non-retriable error — surface body so the caller can record it.
        const errText = await resp.text();
        throw new Error(
            `[embedding] ${resp.status} ${resp.statusText}: ${errText.slice(0, 500)}`,
        );
    }
    throw new Error(`[embedding] giving up after ${maxAttempts} attempts`);
}

/**
 * Embed a single query string. Convenience wrapper for the chat-time path
 * where the user message is one string and we just want one vector back.
 */
export async function embedQuery(text: string): Promise<number[]> {
    const [v] = await embedBatch([text]);
    return v;
}

/**
 * Format a number[] as the pgvector literal "[v0,v1,...]" — pgvector
 * accepts the array form via parameter binding but Supabase's PostgREST
 * doesn't always thread number[] through as a vector cleanly, so we
 * stringify ourselves and pass as the column value. Matches what the
 * supabase JS client expects when writing to a vector column.
 */
export function formatVectorLiteral(v: number[]): string {
    return `[${v.join(",")}]`;
}

export const EMBEDDING_INFO = {
    model: EMBEDDING_MODEL,
    dimensions: EMBEDDING_DIMENSIONS,
};
