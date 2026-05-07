/**
 * feat-024 — pgvector kNN search across a tabular review's documents.
 *
 * Used by the TR chat path: the user message is embedded once, then we
 * fetch the top-K most similar chunks across the docs in scope. The
 * chunks come back with their document_id + page span so the chat
 * route can format them as <retrieved_passage> blocks the LLM cites
 * via [[doc:N||page:P||quote:...]] markers.
 *
 * We use cosine distance (`<=>`) since text-embedding-3-small produces
 * unit-normalised-ish vectors and cosine is the conventional choice
 * for OpenAI embeddings. The HNSW index on the `embedding` column
 * (migration 007) accelerates this — for sub-50K-chunk reviews the
 * query is sub-50ms.
 */

import type { createServerSupabase } from "./supabase";
import { formatVectorLiteral } from "./embedding";

type Db = ReturnType<typeof createServerSupabase>;

export interface RagHit {
    chunkId: string;
    documentId: string;
    chunkIndex: number;
    pageStart: number | null;
    pageEnd: number | null;
    content: string;
    /** Cosine distance, 0 = identical, 2 = opposite. Smaller is better. */
    distance: number;
}

/**
 * Fetch the top-K most similar chunks across the given document set. The
 * doc set is scoped externally (route handler already knows which docs
 * the user can see in this review) so RLS only has to enforce per-doc
 * access on each row, not the scope.
 */
export async function searchChunks(args: {
    db: Db;
    documentIds: string[];
    queryEmbedding: number[];
    k: number;
}): Promise<RagHit[]> {
    const { db, documentIds, queryEmbedding, k } = args;
    if (documentIds.length === 0) return [];

    // pgvector's <=> operator computes cosine distance. ORDER BY ... ASC
    // gives nearest-first. We use the RPC pattern via supabase.rpc to
    // run a parameterised SQL with proper vector binding — the JS client
    // can't quite express a vector(1536) column literal in its query
    // builder, so we use rpc.
    const { data, error } = await db.rpc("rag_search_chunks", {
        document_ids: documentIds,
        query_embedding: formatVectorLiteral(queryEmbedding),
        match_count: k,
    });
    if (error) {
        console.error("[rag-search] RPC error", error);
        return [];
    }
    const rows = data as
        | {
              id: string;
              document_id: string;
              chunk_index: number;
              page_start: number | null;
              page_end: number | null;
              content: string;
              distance: number;
          }[]
        | null;
    if (!rows) return [];
    return rows.map((r) => ({
        chunkId: r.id,
        documentId: r.document_id,
        chunkIndex: r.chunk_index,
        pageStart: r.page_start,
        pageEnd: r.page_end,
        content: r.content,
        distance: r.distance,
    }));
}
