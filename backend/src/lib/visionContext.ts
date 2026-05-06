import { downloadFile } from "./storage";
import { renderPdfPagesToBase64, type RenderedPage } from "./pdfRender";
import {
    visionCacheGet,
    visionCacheKey,
    visionCacheSet,
} from "./visionCache";
import {
    loadCompositesFromR2,
    saveCompositesToR2,
} from "./visionR2Cache";
import type { DocStore } from "./chatTools";
import type { LlmContentBlock } from "./llm/types";

/** Render-time DPI passed to pdftoppm. Centralised here so the cache
 *  key matches the value used at render time. */
const VISION_DPI = 144;

/**
 * vLLM is started with `--limit-mm-per-prompt image=100` — 100 images per
 * request. We cap rendered output here so the request never exceeds it.
 *
 * With pagesPerImage=4 (the default in pdfRender), the practical doc-page
 * capacity is ≈ 100 × 4 = 400 pages — comfortably above any real legal
 * doc. If a single chat attaches multiple PDFs whose pages combined
 * exceed this, surplus is dropped with a console warning.
 */
export const VISION_MAX_IMAGES_PER_REQUEST = 100;

/**
 * Pages composed into each output image. 4 = 2×2 grid. Spike-validated
 * (backend/spike-out/text-compression*) to give ~3× token compression vs
 * 1-up at no fidelity loss on legal-grade content. Going higher (8-up)
 * caused the model to hallucinate dates and party names.
 */
const VISION_PAGES_PER_IMAGE = 4;

type ApiMsg = { role: string; content: string | LlmContentBlock[] | null };

/**
 * Render every PDF in the chat's docStore to PNG (4 pages per image by
 * default — see VISION_PAGES_PER_IMAGE) and splice them into the last
 * user message of `apiMessages` as OpenAI-style `image_url` content
 * blocks. Returns a new array — does not mutate the input.
 *
 * Skips silently when there are no PDFs (text-only chat path is
 * preserved). Caps total images across all PDFs at
 * VISION_MAX_IMAGES_PER_REQUEST so the vLLM request never exceeds its
 * `--limit-mm-per-prompt` cap; surplus is dropped with a console warning
 * so we can spot it in logs.
 *
 * If a `write` callback is passed (the SSE writer from chat.ts), emit
 * vision_render_start / vision_render_done events around each PDF so the
 * frontend can show "Reading <filename>…" while pdftoppm runs (~10s+ on
 * a 75-page doc) instead of a dead spinner.
 */
export async function attachPdfImagesToLastUserMessage(
    apiMessages: ApiMsg[],
    docStore: DocStore,
    write?: (line: string) => void,
): Promise<ApiMsg[]> {
    const pdfEntries = Array.from(docStore.entries()).filter(
        ([, info]) => info.file_type === "pdf",
    );
    if (pdfEntries.length === 0) return apiMessages;

    // Render PDFs in iteration order; stop once we hit the per-request cap.
    const blocks: LlmContentBlock[] = [];
    let imagesRemaining = VISION_MAX_IMAGES_PER_REQUEST;
    for (const [docId, info] of pdfEntries) {
        if (imagesRemaining <= 0) {
            console.warn(
                `[vision] skipping ${info.filename} (${docId}) — already at the ${VISION_MAX_IMAGES_PER_REQUEST}-image cap`,
            );
            break;
        }
        let buf: ArrayBuffer | null;
        try {
            buf = await downloadFile(info.storage_path);
        } catch (err) {
            console.warn(`[vision] download failed for ${info.filename}:`, err);
            continue;
        }
        if (!buf) {
            console.warn(`[vision] empty download for ${info.filename}`);
            continue;
        }
        const cacheKey = visionCacheKey(
            info.storage_path,
            VISION_PAGES_PER_IMAGE,
            VISION_DPI,
        );
        let composites: RenderedPage[];

        // Tiered cache: memory → R2 → live render. Memory is sub-ms, R2
        // is one HTTP round-trip but persists across restarts, and the
        // render is the expensive ~10s+ pdftoppm path. Each successful
        // path warms the layers above so subsequent turns hit the fastest.
        const fromMemory = visionCacheGet(cacheKey);
        if (fromMemory) {
            composites = fromMemory.slice(0, imagesRemaining);
            console.log(
                `[vision] cache hit (memory) for ${info.filename} (${composites.length} composites, ${VISION_PAGES_PER_IMAGE}-up)`,
            );
        } else {
            const fromR2 = await loadCompositesFromR2(
                info.storage_path,
                VISION_PAGES_PER_IMAGE,
                VISION_DPI,
            );
            if (fromR2) {
                composites = fromR2.slice(0, imagesRemaining);
                visionCacheSet(cacheKey, fromR2);
                console.log(
                    `[vision] cache hit (R2) for ${info.filename} (${composites.length} composites, ${VISION_PAGES_PER_IMAGE}-up)`,
                );
            } else {
                if (write) {
                    write(
                        `data: ${JSON.stringify({
                            type: "vision_render_start",
                            filename: info.filename,
                            pages_per_image: VISION_PAGES_PER_IMAGE,
                        })}\n\n`,
                    );
                }
                const t0 = Date.now();
                composites = await renderPdfPagesToBase64(buf, {
                    pagesPerImage: VISION_PAGES_PER_IMAGE,
                    maxPages: imagesRemaining,
                    dpi: VISION_DPI,
                });
                const latencyMs = Date.now() - t0;
                console.log(
                    `[vision] rendered ${composites.length} composite(s) of ${info.filename} (${VISION_PAGES_PER_IMAGE}-up) in ${latencyMs}ms`,
                );
                visionCacheSet(cacheKey, composites);
                // Fire-and-forget R2 write so subsequent restarts can hit
                // it. Don't await — chat continues without waiting for the
                // upload, errors are swallowed inside saveCompositesToR2.
                void saveCompositesToR2(
                    info.storage_path,
                    VISION_PAGES_PER_IMAGE,
                    VISION_DPI,
                    composites,
                );
                if (write) {
                    write(
                        `data: ${JSON.stringify({
                            type: "vision_render_done",
                            filename: info.filename,
                            composites: composites.length,
                            pages_per_image: VISION_PAGES_PER_IMAGE,
                            latency_ms: latencyMs,
                        })}\n\n`,
                    );
                }
            }
        }
        for (const c of composites) {
            blocks.push({
                type: "image_url",
                image_url: {
                    url: `data:image/png;base64,${c.base64}`,
                    detail: "high",
                },
            });
        }
        imagesRemaining -= composites.length;
    }

    if (blocks.length === 0) return apiMessages;

    // Find the last user message and replace its content with a multimodal
    // array. Preserve original text content as the leading text block.
    const lastUserIdx = lastUserIndex(apiMessages);
    if (lastUserIdx < 0) {
        console.warn("[vision] no user message to attach images to");
        return apiMessages;
    }
    const userMsg = apiMessages[lastUserIdx];
    const originalText =
        typeof userMsg.content === "string" ? userMsg.content : "";
    const newContent: LlmContentBlock[] = [
        { type: "text", text: originalText },
        ...blocks,
    ];
    const out = apiMessages.slice();
    out[lastUserIdx] = { ...userMsg, content: newContent };
    return out;
}

function lastUserIndex(msgs: ApiMsg[]): number {
    for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].role === "user") return i;
    }
    return -1;
}
