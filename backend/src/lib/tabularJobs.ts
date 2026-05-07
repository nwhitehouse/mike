/**
 * bug-007 — Tabular generate as durable job + in-process worker pool.
 *
 * The previous implementation ran tabular generate inline in the HTTP
 * handler, fanning out N parallel LLM calls and streaming progress over
 * SSE. That tied up an Express worker for the full duration (hours, for
 * 5K–10K-doc projects), made the SSE a single point of failure (proxy
 * idle timeout, browser tab close, backend restart all killed the run),
 * and lost all in-flight progress on a deploy. vLLM also can't serve
 * thousands of concurrent inference requests at the scale we need.
 *
 * This module moves the work to a durable job table (migration 005) and
 * a small in-process worker pool. The HTTP handler creates a job + N
 * items and returns immediately; workers claim items atomically with a
 * 5-minute lease (FOR UPDATE SKIP LOCKED via the claim_tabular_job_item
 * RPC) and process them in the background. Browser refreshes, backend
 * restarts, and proxy timeouts no longer kill an in-flight run — the
 * next worker scan picks up 'pending' items plus 'running' items whose
 * lease has expired.
 *
 * The frontend polls instead of streaming. See routes/tabular.ts for
 * the GET /tabular/jobs/:jobId{,cells} and POST /cancel surface.
 *
 * Helpers that used to live in routes/tabular.ts (formatPromptSuffix,
 * queryGemini, queryGeminiAllColumns, extract*Markdown, Column /
 * CellResult types) moved here so the worker doesn't pull in the route
 * file and we don't end up with a circular import.
 */

import { completeText, streamChatWithTools } from "./llm";
import { downloadFile } from "./storage";
import { loadActiveVersion } from "./documentVersions";
import { normalizeDocxZipPaths } from "./convert";
import { createServerSupabase } from "./supabase";

type Db = ReturnType<typeof createServerSupabase>;

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type CellResult = {
    summary: string;
    flag: "green" | "grey" | "yellow" | "red";
    reasoning: string;
};

export type Column = {
    index: number;
    name: string;
    prompt: string;
    format?: string;
    tags?: string[];
};

export type ClaimedJobItem = {
    id: string;
    job_id: string;
    document_id: string;
    status: string;
    attempt_count: number;
    lease_expires_at: string | null;
    created_at: string;
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers (moved from routes/tabular.ts so the worker doesn't import a route
// file). Pure / network-only — no Supabase access.
// ─────────────────────────────────────────────────────────────────────────────

export function formatPromptSuffix(format?: string, tags?: string[]): string {
    switch (format) {
        case "bulleted_list":
            return ' The "summary" field in your JSON response must be a markdown bulleted list only — no prose. Format: each item on its own line, prefixed with "* " (asterisk + single space), e.g.\n* First item\n* Second item\n* Third item';
        case "number":
            return ' The "summary" field in your JSON response must be a single number only. No units or explanation.';
        case "percentage":
            return ' The "summary" field in your JSON response must be a single percentage value only (e.g. 42%). No explanation.';
        case "monetary_amount":
            return ' The "summary" field in your JSON response must be the monetary value only, including currency symbol (e.g. $1,234.56). No explanation.';
        case "currency":
            return ' The "summary" field in your JSON response must contain only the currency code(s). Wrap each code in double square brackets, e.g. [[USD]] or [[EUR]]. No other text.';
        case "yes_no":
            return ' The "summary" field in your JSON response must be [[Yes]] or [[No]] only. The "reasoning" field MUST include an inline citation [[page:N||quote:verbatim excerpt ≤25 words]] pointing to the exact language in the document that supports the Yes/No answer.';
        case "date":
            return ' The "summary" field in your JSON response must be the date only in DD Month YYYY format (e.g. 1 January 2024). If a range, give both dates separated by an em dash. The "reasoning" field MUST include an inline citation [[page:N||quote:verbatim excerpt ≤25 words]] pointing to the exact place in the document where the date is found.';
        case "tag":
            return tags?.length
                ? ` The "summary" field in your JSON response must contain exactly one tag wrapped in double square brackets. Available tags: ${tags.map((t) => `[[${t}]]`).join(", ")}. No other text. The "reasoning" field MUST include an inline citation [[page:N||quote:verbatim excerpt ≤25 words]] pointing to the exact language in the document that supports the chosen tag.`
                : "";
        default:
            return "";
    }
}

export async function extractPdfMarkdown(buf: ArrayBuffer): Promise<string> {
    try {
        const pdfjsLib = await import(
            "pdfjs-dist/legacy/build/pdf.mjs" as string
        );
        const pdf = await (
            pdfjsLib as unknown as {
                getDocument: (opts: unknown) => {
                    promise: Promise<{
                        numPages: number;
                        getPage: (n: number) => Promise<{
                            getTextContent: () => Promise<{
                                items: { str?: string; hasEOL?: boolean }[];
                            }>;
                        }>;
                    }>;
                };
            }
        ).getDocument({ data: new Uint8Array(buf) }).promise;
        const pages: string[] = [];
        for (let i = 1; i <= pdf.numPages; i++) {
            const page = await pdf.getPage(i);
            const tc = await page.getTextContent();
            const text = tc.items
                .filter((it): it is { str: string } => "str" in it)
                .map((it) => it.str)
                .join(" ")
                .trim();
            if (text) pages.push(`## Page ${i}\n\n${text}`);
        }
        return pages.join("\n\n");
    } catch {
        return "";
    }
}

export async function extractDocxMarkdown(buf: ArrayBuffer): Promise<string> {
    try {
        const mammoth = await import("mammoth");
        const normalized = await normalizeDocxZipPaths(Buffer.from(buf));
        const { value: html } = await mammoth.convertToHtml({
            buffer: normalized,
        });
        return html
            .replace(
                /<h([1-6])[^>]*>(.*?)<\/h\1>/gi,
                (_, l, t) => "#".repeat(Number(l)) + " " + t + "\n\n",
            )
            .replace(/<strong[^>]*>(.*?)<\/strong>/gi, "**$1**")
            .replace(/<li[^>]*>(.*?)<\/li>/gi, "- $1\n")
            .replace(/<p[^>]*>(.*?)<\/p>/gi, "$1\n\n")
            .replace(/<[^>]+>/g, "")
            .replace(/&nbsp;/g, " ")
            .replace(/&amp;/g, "&")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/\n{3,}/g, "\n\n")
            .trim();
    } catch {
        return "";
    }
}

/** Single-cell extraction. Used by /tabular/.../regenerate-cell. */
export async function queryGemini(
    model: string,
    filename: string,
    documentText: string,
    columnPrompt: string,
    format?: string,
    tags?: string[],
    apiKeys?: import("./llm").UserApiKeys,
) {
    const suffix = formatPromptSuffix(format, tags);
    const fullPrompt = `${columnPrompt}${suffix} If not found, state "Not Found". Leave all reasoning and explanation in the "reasoning" field only.`;

    const EXTRACTION_SYSTEM = `You are a legal document analyst. Return ONLY valid JSON:
{"summary": string, "flag": "green"|"grey"|"yellow"|"red", "reasoning": string}

The "summary" and "reasoning" field values may use markdown formatting (bullets, bold, italics, etc.) — the values are still plain JSON strings (escape newlines as \\n), but the text inside will be rendered as markdown in the UI.

The "summary" field must contain only the extracted value with inline citations — no explanation or reasoning. Every factual claim in "summary" must be followed immediately by a citation in the format [[page:N||quote:exact quoted text]], where N is the page number and the quote is a short verbatim excerpt (≤ 25 words). The quote must be narrowly scoped to the specific claim it supports — extract only the exact words that support that statement, not the surrounding sentence or paragraph. Do not have multiple claims share the same long quote; if two different statements need different evidence, give each its own short, narrowly-scoped quote. All reasoning and explanation belongs in "reasoning" only, which may also contain citations.`;

    let raw: string;
    try {
        raw = await completeText({
            model,
            systemPrompt: EXTRACTION_SYSTEM,
            user: `Document: ${filename}\n\n${documentText.slice(0, 120_000)}\n\n---\nInstruction: ${fullPrompt}`,
            maxTokens: 2048,
            apiKeys,
        });
    } catch (err) {
        console.error("[queryGemini] completion failed", err);
        return null;
    }
    try {
        const parsed = JSON.parse(
            raw.replace(/^```(?:json)?\n?/i, "").replace(/\n?```$/, "").trim(),
        ) as {
            summary?: unknown;
            value?: unknown;
            flag?: unknown;
            reasoning?: unknown;
        };
        return {
            summary:
                String(parsed.summary ?? parsed.value ?? "").trim() ||
                "Not addressed",
            flag: (["green", "grey", "yellow", "red"] as const).includes(
                parsed.flag as "green",
            )
                ? (parsed.flag as "green")
                : "grey",
            reasoning: String(parsed.reasoning ?? ""),
        };
    } catch {
        return raw.trim()
            ? {
                  summary: raw.trim().slice(0, 500),
                  flag: "grey" as const,
                  reasoning: "",
              }
            : null;
    }
}

/** Multi-column extraction for one document. Streams one result per column. */
export async function queryGeminiAllColumns(
    model: string,
    filename: string,
    documentText: string,
    columns: Column[],
    onResult: (columnIndex: number, result: CellResult) => Promise<void>,
    apiKeys?: import("./llm").UserApiKeys,
): Promise<void> {
    const columnsDesc = columns
        .map((col) => {
            const suffix = formatPromptSuffix(col.format, col.tags);
            const fullPrompt = `${col.prompt}${suffix} If not found, state "Not Found".`;
            return `Column ${col.index} — "${col.name}": ${fullPrompt}`;
        })
        .join("\n");

    const SYSTEM = `You are a legal document analyst. Extract information for each column listed below.

For each column, output exactly one minified JSON object on its own line (no line breaks inside the JSON), then a newline. Process columns in order and output each result as soon as you finish it.

Line format:
{"column_index": <N>, "summary": <string>, "flag": <"green"|"grey"|"yellow"|"red">, "reasoning": <string>}

Rules:
- "summary": the extracted value with inline citations [[page:N||quote:verbatim excerpt ≤25 words]] after every factual claim. No explanation or reasoning here. Quotes must be narrowly scoped to the specific claim — extract only the exact supporting words, not the full surrounding sentence. Do not reuse one long quote across multiple statements; give each claim its own short, precise quote.
- "flag": green = standard/favorable, yellow = needs attention, red = problematic/unfavorable, grey = neutral/not found
- "reasoning": brief explanation of the extraction
- The "summary" and "reasoning" string VALUES may use markdown (bullets, bold, italics, etc.) — escape newlines as \\n inside the JSON string. This markdown is rendered in the UI.
- Output ONLY the JSON lines themselves. Do NOT wrap the response in markdown code fences (e.g. \`\`\`json), and do not add any preamble or summary.`;

    const USER = `Document: ${filename}\n\n${documentText.slice(0, 120_000)}\n\n---\nColumns to extract:\n${columnsDesc}`;

    let contentBuffer = "";
    const pending: Promise<unknown>[] = [];

    const processLine = async (line: string) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        try {
            const parsed = JSON.parse(trimmed) as {
                column_index?: unknown;
                summary?: unknown;
                flag?: unknown;
                reasoning?: unknown;
            };
            if (typeof parsed.column_index !== "number") return;
            const col = columns.find((c) => c.index === parsed.column_index);
            if (!col) return;
            await onResult(parsed.column_index, {
                summary: String(parsed.summary ?? "").trim() || "Not addressed",
                flag: (["green", "grey", "yellow", "red"] as const).includes(
                    parsed.flag as "green",
                )
                    ? (parsed.flag as CellResult["flag"])
                    : "grey",
                reasoning: String(parsed.reasoning ?? ""),
            });
        } catch {
            /* malformed line — skip */
        }
    };

    try {
        await streamChatWithTools({
            model,
            systemPrompt: SYSTEM,
            messages: [{ role: "user", content: USER }],
            tools: [],
            apiKeys,
            callbacks: {
                onContentDelta: (delta) => {
                    contentBuffer += delta;
                    let newlineIdx: number;
                    while ((newlineIdx = contentBuffer.indexOf("\n")) !== -1) {
                        const completedLine = contentBuffer.slice(
                            0,
                            newlineIdx,
                        );
                        contentBuffer = contentBuffer.slice(newlineIdx + 1);
                        pending.push(processLine(completedLine));
                    }
                },
            },
        });
    } catch (err) {
        console.error("[queryGeminiAllColumns] stream failed", err);
    }

    if (contentBuffer.trim()) pending.push(processLine(contentBuffer));
    await Promise.all(pending);
}

// ─────────────────────────────────────────────────────────────────────────────
// Job lifecycle
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a generate job + N items in a single transaction-equivalent (two
 * inserts). Caller has already authenticated and resolved the doc list.
 *
 * Returns the job id + total_items so the route handler can hand them
 * straight to the frontend.
 */
export async function createGenerateJob(args: {
    db: Db;
    reviewId: string;
    userId: string;
    documentIds: string[];
}): Promise<{ jobId: string; totalItems: number } | { error: string }> {
    const { db, reviewId, userId, documentIds } = args;
    if (documentIds.length === 0) {
        return { error: "No documents to process" };
    }

    const { data: job, error: jobErr } = await db
        .from("tabular_jobs")
        .insert({
            review_id: reviewId,
            user_id: userId,
            status: "pending",
            total_items: documentIds.length,
        })
        .select("id")
        .single();
    if (jobErr || !job) {
        return { error: jobErr?.message ?? "Failed to create job" };
    }

    const itemRows = documentIds.map((document_id) => ({
        job_id: job.id as string,
        document_id,
        status: "pending" as const,
    }));
    const { error: itemsErr } = await db
        .from("tabular_job_items")
        .insert(itemRows);
    if (itemsErr) {
        // Best-effort cleanup so we don't leave a job with no items.
        await db.from("tabular_jobs").delete().eq("id", job.id);
        return { error: itemsErr.message };
    }

    return {
        jobId: job.id as string,
        totalItems: documentIds.length,
    };
}

/**
 * Atomic claim. Wraps the claim_tabular_job_item RPC (migration 005).
 * Returns the claimed item or null when no work is available. SKIP LOCKED
 * means multiple workers — and multiple Express instances if we ever
 * scale past one — never claim the same row.
 */
export async function claimNextItem(
    db: Db,
    leaseSeconds: number,
): Promise<ClaimedJobItem | null> {
    const { data, error } = await db.rpc("claim_tabular_job_item", {
        lease_seconds: leaseSeconds,
    });
    if (error) {
        console.error("[tabular-worker] claim RPC error:", error.message);
        return null;
    }
    const rows = data as ClaimedJobItem[] | null;
    if (!rows || rows.length === 0) return null;
    return rows[0];
}

/**
 * After every item state transition, decide if the parent job is now
 * resolved. Single source of truth for the job status state machine.
 *
 * Status pipeline:
 *   pending → running (set on first claim)
 *   running → completed     (all items resolved, no cancel was requested)
 *   running → cancelled     (all items resolved, cancel_requested_at set)
 *
 * 'failed' is reserved for a future story (catastrophic backend errors);
 * partial errors today fall under 'completed' with error_items > 0 — the
 * user can re-run the failed cells.
 */
export async function maybeFinalizeJob(db: Db, jobId: string): Promise<void> {
    const { data: job } = await db
        .from("tabular_jobs")
        .select("id, status, total_items, completed_items, error_items, cancel_requested_at")
        .eq("id", jobId)
        .single();
    if (!job) return;
    const j = job as {
        id: string;
        status: string;
        total_items: number;
        completed_items: number;
        error_items: number;
        cancel_requested_at: string | null;
    };

    // Count items that have reached a terminal state (completed/error/skipped).
    const { count: resolvedCount } = await db
        .from("tabular_job_items")
        .select("id", { count: "exact", head: true })
        .eq("job_id", jobId)
        .in("status", ["completed", "error", "skipped"]);

    if ((resolvedCount ?? 0) < j.total_items) return;

    // All items resolved.
    const finalStatus = j.cancel_requested_at ? "cancelled" : "completed";
    if (j.status === finalStatus) return;
    await db
        .from("tabular_jobs")
        .update({
            status: finalStatus,
            completed_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
        })
        .eq("id", jobId);
}

/**
 * Process one claimed item end-to-end:
 *   - load review + doc + columns + user model settings
 *   - check job cancel_requested_at, skip if set
 *   - extract markdown, run queryGeminiAllColumns, write cells
 *   - mark item completed/error
 *   - bump job counters
 *   - call maybeFinalizeJob
 *
 * Workers should never throw out of this function — failures get
 * recorded on the item row instead. The pool's loop catches anything
 * that escapes anyway, but recording on the row gives the user
 * visibility in the UI.
 */
export async function processOneJobItem(
    db: Db,
    item: ClaimedJobItem,
): Promise<void> {
    const t0 = Date.now();

    const { data: jobRow } = await db
        .from("tabular_jobs")
        .select(
            "id, review_id, user_id, status, cancel_requested_at, total_items",
        )
        .eq("id", item.job_id)
        .single();
    if (!jobRow) {
        // Parent job was deleted while the item was queued — nothing to do.
        return;
    }
    const job = jobRow as {
        id: string;
        review_id: string;
        user_id: string;
        status: string;
        cancel_requested_at: string | null;
        total_items: number;
    };

    // Move job from 'pending' to 'running' on first claim. Best-effort —
    // a parallel worker might already have done this; the WHERE filter
    // makes it idempotent.
    if (job.status === "pending") {
        await db
            .from("tabular_jobs")
            .update({
                status: "running",
                started_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
            })
            .eq("id", job.id)
            .eq("status", "pending");
    }

    // Soft cancel: mark item skipped, advance the job counters, return.
    if (job.cancel_requested_at) {
        await db
            .from("tabular_job_items")
            .update({
                status: "skipped",
                completed_at: new Date().toISOString(),
                lease_expires_at: null,
            })
            .eq("id", item.id);
        await db
            .from("tabular_jobs")
            .update({ updated_at: new Date().toISOString() })
            .eq("id", job.id);
        await maybeFinalizeJob(db, job.id);
        return;
    }

    // Load the review (columns + project_id + title for logs).
    const { data: review } = await db
        .from("tabular_reviews")
        .select("id, columns_config, title, project_id, user_id")
        .eq("id", job.review_id)
        .single();
    if (!review) {
        await markItemError(db, item.id, "Review not found");
        await db
            .from("tabular_jobs")
            .update({ updated_at: new Date().toISOString() })
            .eq("id", job.id);
        await maybeFinalizeJob(db, job.id);
        return;
    }
    const columns: Column[] =
        ((review as { columns_config?: Column[] }).columns_config) ?? [];

    // Load the document. If the doc was deleted between job creation and
    // processing, mark this item skipped — historical rather than an error.
    const { data: docRow } = await db
        .from("documents")
        .select("id, filename, file_type, page_count, user_id, project_id")
        .eq("id", item.document_id)
        .single();
    if (!docRow) {
        await db
            .from("tabular_job_items")
            .update({
                status: "skipped",
                completed_at: new Date().toISOString(),
                lease_expires_at: null,
                error: "Document deleted",
            })
            .eq("id", item.id);
        await db
            .from("tabular_jobs")
            .update({ updated_at: new Date().toISOString() })
            .eq("id", job.id);
        await maybeFinalizeJob(db, job.id);
        return;
    }
    const doc = docRow as {
        id: string;
        filename: string;
        file_type: string;
        page_count: number | null;
    };

    // User settings (model + api_keys) belong to the job *creator*, not
    // the worker — so that a shared review run by user A doesn't get
    // billed to user B's keys.
    const { tabular_model, api_keys } = await getUserModelSettings(
        job.user_id,
        db,
    );

    // Existing cells for this doc — only process columns that aren't
    // already done. Lets resume + re-run cases not redo finished work.
    const { data: existingCells } = await db
        .from("tabular_cells")
        .select("column_index, status, content")
        .eq("review_id", review.id)
        .eq("document_id", doc.id);
    const existing = new Map<number, { status: string; content: unknown }>();
    for (const c of (existingCells ?? []) as {
        column_index: number;
        status: string;
        content: unknown;
    }[]) {
        existing.set(c.column_index, { status: c.status, content: c.content });
    }

    const columnsToProcess = columns.filter((col) => {
        const cell = existing.get(col.index);
        return !(cell?.status === "done" && cell?.content);
    });

    if (columnsToProcess.length === 0) {
        await markItemCompleted(db, item.id);
        await db
            .from("tabular_jobs")
            .update({ updated_at: new Date().toISOString() })
            .eq("id", job.id);
        await maybeFinalizeJob(db, job.id);
        return;
    }

    // Mark cells as generating up front (DB only — no SSE in worker mode).
    for (const col of columnsToProcess) {
        if (existing.has(col.index)) {
            await db
                .from("tabular_cells")
                .update({ status: "generating", content: null })
                .eq("review_id", review.id)
                .eq("document_id", doc.id)
                .eq("column_index", col.index);
        } else {
            await db.from("tabular_cells").insert({
                review_id: review.id,
                document_id: doc.id,
                column_index: col.index,
                status: "generating",
            });
        }
    }

    // Download + extract markdown.
    let markdown = "";
    const active = await loadActiveVersion(doc.id, db);
    if (active) {
        const buf = await downloadFile(active.storage_path);
        if (buf) {
            try {
                markdown =
                    doc.file_type === "pdf"
                        ? await extractPdfMarkdown(buf)
                        : await extractDocxMarkdown(buf);
            } catch (err) {
                console.error(
                    `[tabular-worker] extraction error doc=${doc.id}`,
                    err,
                );
            }
        }
    }

    // Run the LLM. Each completed column writes a cell row.
    const receivedColumns = new Set<number>();
    try {
        await queryGeminiAllColumns(
            tabular_model,
            doc.filename,
            markdown,
            columnsToProcess,
            async (columnIndex, result) => {
                receivedColumns.add(columnIndex);
                await db
                    .from("tabular_cells")
                    .update({
                        content: JSON.stringify(result),
                        status: "done",
                    })
                    .eq("review_id", review.id)
                    .eq("document_id", doc.id)
                    .eq("column_index", columnIndex);
            },
            api_keys,
        );
    } catch (err) {
        console.error(
            `[tabular-worker] queryGeminiAllColumns error doc=${doc.id}`,
            err,
        );
    }

    // Cells the LLM didn't return → error.
    let perItemErrors = 0;
    for (const col of columnsToProcess) {
        if (!receivedColumns.has(col.index)) {
            perItemErrors += 1;
            await db
                .from("tabular_cells")
                .update({ status: "error" })
                .eq("review_id", review.id)
                .eq("document_id", doc.id)
                .eq("column_index", col.index);
        }
    }

    // Item-level outcome: mark completed if any cell succeeded, error if
    // every cell failed. completed_items / error_items on the job row
    // are computed on-demand by GET /tabular/jobs/:jobId from the items
    // table (no race-prone counter increments here). All we need to do
    // after marking the item is poke maybeFinalizeJob to flip the parent
    // job to its terminal state once every item has resolved.
    if (receivedColumns.size === 0 && columnsToProcess.length > 0) {
        await markItemError(
            db,
            item.id,
            `LLM produced no results for ${columnsToProcess.length} column(s)`,
        );
    } else {
        await markItemCompleted(db, item.id);
    }
    await db
        .from("tabular_jobs")
        .update({ updated_at: new Date().toISOString() })
        .eq("id", job.id);
    await maybeFinalizeJob(db, job.id);

    console.log(
        `[tabular-worker] doc=${doc.id} columns=${receivedColumns.size}/${columnsToProcess.length} errors=${perItemErrors} took=${Date.now() - t0}ms`,
    );
}

async function markItemCompleted(db: Db, itemId: string): Promise<void> {
    await db
        .from("tabular_job_items")
        .update({
            status: "completed",
            completed_at: new Date().toISOString(),
            lease_expires_at: null,
        })
        .eq("id", itemId);
}

async function markItemError(
    db: Db,
    itemId: string,
    message: string,
): Promise<void> {
    await db
        .from("tabular_job_items")
        .update({
            status: "error",
            completed_at: new Date().toISOString(),
            lease_expires_at: null,
            error: message.slice(0, 500),
        })
        .eq("id", itemId);
}

// User settings — dynamic import so the worker doesn't pull in routes
// that depend on userSettings's frontend-shaped types at module-init time.
async function getUserModelSettings(
    userId: string,
    db: Db,
): Promise<{
    tabular_model: string;
    api_keys: import("./llm").UserApiKeys | undefined;
}> {
    const { getUserModelSettings: real } = await import("./userSettings");
    return real(userId, db);
}

// ─────────────────────────────────────────────────────────────────────────────
// Worker pool
// ─────────────────────────────────────────────────────────────────────────────

export class TabularWorkerPool {
    private running = false;
    private workers: Promise<void>[] = [];

    constructor(
        private opts: {
            workerCount: number;
            leaseSeconds: number;
            idleSleepMs: number;
            dbFactory: () => Db;
        },
    ) {}

    start(): void {
        if (this.running) return;
        this.running = true;
        for (let i = 0; i < this.opts.workerCount; i++) {
            this.workers.push(this.workerLoop(i));
        }
        console.log(
            `[tabular-worker] pool started: ${this.opts.workerCount} workers, ${this.opts.leaseSeconds}s lease`,
        );
    }

    async stop(): Promise<void> {
        this.running = false;
        await Promise.all(this.workers).catch(() => {
            /* loop exits cleanly even on error */
        });
        this.workers = [];
        console.log("[tabular-worker] pool stopped");
    }

    private async workerLoop(workerId: number): Promise<void> {
        const db = this.opts.dbFactory();
        while (this.running) {
            try {
                const item = await claimNextItem(db, this.opts.leaseSeconds);
                if (!item) {
                    await sleep(this.opts.idleSleepMs);
                    continue;
                }
                await processOneJobItem(db, item);
            } catch (err) {
                console.error(`[tabular-worker ${workerId}] loop error:`, err);
                // Back off briefly on unexpected errors so we don't burn
                // CPU spinning on a broken DB connection.
                await sleep(2_000);
            }
        }
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export function readWorkerPoolConfig(): {
    workerCount: number;
    leaseSeconds: number;
    idleSleepMs: number;
} {
    return {
        workerCount: readPositiveInt("TABULAR_GENERATE_CONCURRENCY", 10),
        leaseSeconds: readPositiveInt("TABULAR_JOB_LEASE_SECONDS", 300),
        idleSleepMs: readPositiveInt("TABULAR_WORKER_IDLE_MS", 500),
    };
}

function readPositiveInt(envName: string, fallback: number): number {
    const raw = process.env[envName];
    if (!raw) return fallback;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}
