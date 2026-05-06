import { downloadFile } from "./storage";
import { renderPdfPagesToBase64 } from "./pdfRender";
import {
    visionCacheKey,
    visionCacheSet,
} from "./visionCache";
import {
    loadCompositesFromR2,
    saveCompositesToR2,
} from "./visionR2Cache";

/**
 * Background pre-render of attached PDFs into the vision cache. Called
 * fire-and-forget from upload routes the moment a new document version
 * lands in R2. By the time the user opens a chat against that doc, the
 * R2 manifest is already populated — the chat skips the ~10s pdftoppm
 * cost and goes straight to vLLM.
 *
 * Pipeline:
 *   upload completes → kickOffVisionPrerender(documentId, storagePath)
 *     → background fetch → render → write to R2 + memory cache
 *     → mark documentId ready in the in-process map
 *
 * Frontend polls visionStatusFor(documentId) and waits to enable the
 * Send button until status === "ready". The send-disable is the latency
 * the user FEELS, traded for the chat being instant once they're free
 * to send.
 *
 * Render parameters MUST match what visionContext.ts uses at chat time
 * — otherwise the cache key differs and the prerender result is unused.
 */

const PRERENDER_PAGES_PER_IMAGE = 4;
const PRERENDER_DPI = 144;

type RenderStatus = "pending" | "ready" | "failed";

/** documentId → status. Keys cleared on success/failure for memory hygiene
 *  EXCEPT failed ones, which we keep so the frontend can show a clear
 *  signal instead of looping back to "pending" via R2 miss. */
const inProgress = new Map<string, RenderStatus>();

/**
 * Kick off a background render for a freshly-uploaded document. Returns
 * immediately. Idempotent — if already pending or ready, no-op.
 *
 * Errors are logged and recorded as "failed" but never thrown. Chat-time
 * render is the safety net: a failed prerender just means the first chat
 * pays the live render cost (status quo before this feature).
 */
export function kickOffVisionPrerender(args: {
    documentId: string;
    storagePath: string;
}): void {
    const { documentId, storagePath } = args;
    if (inProgress.get(documentId) === "pending") return;
    if (inProgress.get(documentId) === "ready") return;

    inProgress.set(documentId, "pending");
    void runPrerender(documentId, storagePath);
}

async function runPrerender(
    documentId: string,
    storagePath: string,
): Promise<void> {
    const t0 = Date.now();
    try {
        // If R2 already has a manifest (e.g. earlier process pre-rendered
        // and the doc is being re-uploaded under a new version with the
        // same storagePath — unlikely but harmless), skip the work.
        const existing = await loadCompositesFromR2(
            storagePath,
            PRERENDER_PAGES_PER_IMAGE,
            PRERENDER_DPI,
        );
        if (existing) {
            console.log(
                `[prerender] doc=${documentId} cache hit (R2) in ${Date.now() - t0}ms — skipping render`,
            );
            visionCacheSet(
                visionCacheKey(
                    storagePath,
                    PRERENDER_PAGES_PER_IMAGE,
                    PRERENDER_DPI,
                ),
                existing,
            );
            inProgress.set(documentId, "ready");
            return;
        }

        const buf = await downloadFile(storagePath);
        if (!buf) {
            console.warn(
                `[prerender] doc=${documentId} download returned null`,
            );
            inProgress.set(documentId, "failed");
            return;
        }
        const composites = await renderPdfPagesToBase64(buf, {
            pagesPerImage: PRERENDER_PAGES_PER_IMAGE,
            dpi: PRERENDER_DPI,
        });
        visionCacheSet(
            visionCacheKey(
                storagePath,
                PRERENDER_PAGES_PER_IMAGE,
                PRERENDER_DPI,
            ),
            composites,
        );
        await saveCompositesToR2(
            storagePath,
            PRERENDER_PAGES_PER_IMAGE,
            PRERENDER_DPI,
            composites,
        );
        inProgress.set(documentId, "ready");
        console.log(
            `[prerender] doc=${documentId} rendered ${composites.length} composites in ${Date.now() - t0}ms`,
        );
    } catch (err) {
        console.warn(`[prerender] doc=${documentId} failed:`, err);
        inProgress.set(documentId, "failed");
    }
}

/**
 * Resolve current vision-render status for a document. Combines the
 * in-memory pending set with R2 existence so the answer is correct even
 * after a process restart wiped the in-memory state.
 *
 * Returns:
 *  - "pending"  — render is currently in flight (in this process)
 *  - "ready"    — composites are available (memory or R2)
 *  - "failed"   — last attempt errored; chat will fall back to live render
 *  - "missing"  — no record at all; chat will live-render on first use
 */
export async function visionStatusFor(args: {
    documentId: string;
    storagePath: string;
}): Promise<"pending" | "ready" | "failed" | "missing"> {
    const { documentId, storagePath } = args;
    const inMem = inProgress.get(documentId);
    if (inMem === "pending") return "pending";
    if (inMem === "failed") return "failed";
    if (inMem === "ready") return "ready";
    // Not in memory — could be a different process (restart) or never
    // pre-rendered. Cheapest check: see if R2 has the manifest.
    const fromR2 = await loadCompositesFromR2(
        storagePath,
        PRERENDER_PAGES_PER_IMAGE,
        PRERENDER_DPI,
    );
    if (fromR2) {
        // Promote to memory so subsequent calls answer instantly.
        inProgress.set(documentId, "ready");
        return "ready";
    }
    return "missing";
}
