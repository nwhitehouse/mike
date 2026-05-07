/**
 * feat-024 — one-shot embedding backfill.
 *
 * Finds every doc in the local Supabase that doesn't yet have rows in
 * document_chunks and runs the chunk + embed + insert pipeline directly.
 * Bypasses the HTTP endpoint (no auth ceremony) and the worker pool (no
 * backend dependency) so we can run it from the CLI in one shot.
 *
 * Usage:
 *   cd backend && npx tsx scripts/backfill-embeddings.ts
 */

import "dotenv/config";
import { createServerSupabase } from "../src/lib/supabase";
import { downloadFile } from "../src/lib/storage";
import { loadActiveVersion } from "../src/lib/documentVersions";
import {
    extractPdfMarkdown,
    extractDocxMarkdown,
} from "../src/lib/tabularJobs";
import { chunkDocument } from "../src/lib/documentChunker";
import { embedBatch, formatVectorLiteral } from "../src/lib/embedding";

async function main() {
    if (!process.env.OPENAI_API_KEY) {
        console.error("OPENAI_API_KEY is not set — aborting.");
        process.exit(1);
    }

    const db = createServerSupabase();

    const { data: docs, error: docsErr } = await db
        .from("documents")
        .select("id, filename, file_type");
    if (docsErr) {
        console.error("Failed to list documents:", docsErr.message);
        process.exit(1);
    }
    const allDocs = (docs ?? []) as {
        id: string;
        filename: string;
        file_type: string;
    }[];

    // Bump the row cap — supabase-js's PostgREST client defaults to 1000
    // rows, but document_chunks easily exceeds that on a real review.
    // Underestimating means already-chunked docs slip through and the
    // script tries to re-insert, hitting the (document_id, chunk_index)
    // unique constraint.
    const { data: chunked } = await db
        .from("document_chunks")
        .select("document_id")
        .limit(100000);
    const chunkedSet = new Set(
        ((chunked ?? []) as { document_id: string }[]).map((c) => c.document_id),
    );

    const missing = allDocs.filter((d) => !chunkedSet.has(d.id));
    console.log(
        `Backfill: ${allDocs.length} total docs, ${missing.length} need embedding.`,
    );
    if (missing.length === 0) {
        console.log("Nothing to do.");
        return;
    }

    let succeeded = 0;
    let failed = 0;
    for (const doc of missing) {
        try {
            const active = await loadActiveVersion(doc.id, db);
            if (!active) {
                console.warn(`  skip ${doc.id} (${doc.filename}): no active version`);
                failed++;
                continue;
            }
            const buf = await downloadFile(active.storage_path);
            if (!buf) {
                console.warn(`  skip ${doc.id} (${doc.filename}): download failed`);
                failed++;
                continue;
            }
            const markdown =
                doc.file_type === "pdf"
                    ? await extractPdfMarkdown(buf)
                    : await extractDocxMarkdown(buf);
            if (!markdown.trim()) {
                console.warn(`  skip ${doc.id} (${doc.filename}): empty markdown`);
                failed++;
                continue;
            }
            const chunks = chunkDocument(markdown);
            if (chunks.length === 0) {
                console.warn(`  skip ${doc.id} (${doc.filename}): no chunks`);
                failed++;
                continue;
            }
            // Wipe-then-insert mirrors the worker's processEmbedDocumentItem
            // shape: handles partial-state docs from prior failed runs,
            // and means the script is idempotent for re-runs.
            await db.from("document_chunks").delete().eq("document_id", doc.id);
            const vectors = await embedBatch(chunks.map((c) => c.content));
            const rows = chunks.map((c, idx) => ({
                document_id: doc.id,
                chunk_index: c.chunkIndex,
                page_start: c.pageStart,
                page_end: c.pageEnd,
                content: c.content,
                embedding: formatVectorLiteral(vectors[idx]),
            }));
            for (let i = 0; i < rows.length; i += 50) {
                const slice = rows.slice(i, i + 50);
                const { error } = await db.from("document_chunks").insert(slice);
                if (error) throw new Error(error.message);
            }
            console.log(
                `  ok   ${doc.id} (${doc.filename}) — ${chunks.length} chunks`,
            );
            succeeded++;
        } catch (err) {
            console.error(
                `  fail ${doc.id} (${doc.filename}):`,
                (err as Error).message,
            );
            failed++;
        }
    }

    console.log(
        `\nBackfill complete: ${succeeded} succeeded, ${failed} failed.`,
    );
}

main().catch((err) => {
    console.error("Backfill crashed:", err);
    process.exit(1);
});
