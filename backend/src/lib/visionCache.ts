import type { RenderedPage } from "./pdfRender";

/**
 * Process-local LRU cache of rendered PDF composites. Eliminates the
 * per-chat-turn render cost on the hot path (a 75-page doc takes ~10s
 * with parallel pdftoppm — second turn against the same doc would re-pay
 * that without this cache).
 *
 * Composites are large (~1-2MB base64 each, × 19 composites for a 75-page
 * doc ≈ 30MB). With a 5-entry cap that's a worst-case ~150MB resident.
 * Acceptable on Railway (~512MB allotment) given there's only one process
 * per replica.
 *
 * Eviction is access-order LRU: get() promotes the entry to most-recent;
 * insert past the cap evicts the oldest. Clear() exposed for tests.
 *
 * No persistence across process restarts — that's lib/visionCache R2 (TBD).
 */

const MAX_ENTRIES = 5;
const cache = new Map<string, RenderedPage[]>();

/**
 * Cache key. Storage path uniquely identifies the bytes (it includes
 * document_id and version_id), and (pagesPerImage, dpi) capture the
 * render parameters that affect output. Changing any of these — e.g.
 * bumping the default pages-per-image — invalidates cleanly without
 * a wipe.
 */
export function visionCacheKey(
    storagePath: string,
    pagesPerImage: number,
    dpi: number,
): string {
    return `${storagePath}|p${pagesPerImage}|d${dpi}`;
}

export function visionCacheGet(key: string): RenderedPage[] | undefined {
    const v = cache.get(key);
    if (!v) return undefined;
    // Promote to most-recent for LRU ordering.
    cache.delete(key);
    cache.set(key, v);
    return v;
}

export function visionCacheSet(key: string, value: RenderedPage[]): void {
    if (cache.has(key)) {
        cache.delete(key);
    } else if (cache.size >= MAX_ENTRIES) {
        // Evict oldest (Map iterates in insertion order).
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, value);
}

export function visionCacheClear(): void {
    cache.clear();
}

export function visionCacheStats(): { entries: number; max: number } {
    return { entries: cache.size, max: MAX_ENTRIES };
}
