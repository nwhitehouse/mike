import { downloadFile, uploadFile } from "./storage";
import type { RenderedPage } from "./pdfRender";

/**
 * Persistent R2-backed cache for rendered PDF composites. Sits behind the
 * in-memory cache (lib/visionCache.ts) — when a chat starts and memory
 * misses, we try R2 here before falling back to a fresh pdftoppm render.
 *
 * Storage layout: each cache entry is a single JSON manifest at
 *   vision-cache/<doc-fingerprint>.json
 * containing the array of base64 composites plus the render parameters
 * the bytes correspond to.
 *
 * Survives backend restarts and Railway redeploys, so the (~10s on a
 * 75-page doc) pdftoppm cost is paid once per (doc, version, render
 * params) tuple — ever.
 *
 * Write-through: visionContext renders + writes here in one go on cache
 * miss. There's no separate background prerender at upload time; that's
 * a follow-on optimisation if hot chats need it.
 */

type Manifest = {
    pagesPerImage: number;
    dpi: number;
    composites: RenderedPage[];
    /** ISO timestamp — handy for debugging cache age. */
    createdAt: string;
};

/**
 * Build the R2 storage key for a (storagePath, pagesPerImage, dpi) tuple.
 * `storagePath` already includes the document_id and version_id, so this
 * is enough to uniquely identify the bytes + render params. We base64url-
 * encode it so the resulting key is filesystem-/URL-safe.
 */
function r2KeyFor(
    storagePath: string,
    pagesPerImage: number,
    dpi: number,
): string {
    const fingerprint = Buffer.from(
        `${storagePath}|p${pagesPerImage}|d${dpi}`,
    )
        .toString("base64url");
    return `vision-cache/${fingerprint}.json`;
}

export async function loadCompositesFromR2(
    storagePath: string,
    pagesPerImage: number,
    dpi: number,
): Promise<RenderedPage[] | null> {
    const key = r2KeyFor(storagePath, pagesPerImage, dpi);
    let buf: ArrayBuffer | null;
    try {
        buf = await downloadFile(key);
    } catch (err) {
        // Treat any error (including 404) as a miss. R2 download throws on
        // network problems too — no point distinguishing here, the caller
        // just falls back to a fresh render either way.
        console.warn(`[vision-r2] load failed for ${key}:`, err);
        return null;
    }
    if (!buf) return null;
    try {
        const text = Buffer.from(buf).toString("utf8");
        const manifest = JSON.parse(text) as Manifest;
        if (
            manifest.pagesPerImage !== pagesPerImage ||
            manifest.dpi !== dpi
        ) {
            // Stale manifest from a different render config. Treat as miss.
            return null;
        }
        return manifest.composites;
    } catch (err) {
        console.warn(`[vision-r2] parse failed for ${key}:`, err);
        return null;
    }
}

export async function saveCompositesToR2(
    storagePath: string,
    pagesPerImage: number,
    dpi: number,
    composites: RenderedPage[],
): Promise<void> {
    const key = r2KeyFor(storagePath, pagesPerImage, dpi);
    const manifest: Manifest = {
        pagesPerImage,
        dpi,
        composites,
        createdAt: new Date().toISOString(),
    };
    const body = Buffer.from(JSON.stringify(manifest), "utf8");
    // uploadFile takes ArrayBuffer; slice the Buffer's underlying buffer
    // to the exact range to avoid sending pool-shared bytes.
    const ab = body.buffer.slice(
        body.byteOffset,
        body.byteOffset + body.byteLength,
    ) as ArrayBuffer;
    try {
        await uploadFile(key, ab, "application/json");
    } catch (err) {
        // Cache write is best-effort. Don't fail the chat if R2 hiccups.
        console.warn(`[vision-r2] save failed for ${key}:`, err);
    }
}
