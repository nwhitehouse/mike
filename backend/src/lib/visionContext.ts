import { downloadFile } from "./storage";
import { renderPdfPagesToBase64 } from "./pdfRender";
import type { DocStore } from "./chatTools";
import type { LlmContentBlock } from "./llm/types";

/**
 * vLLM is started with `--limit-mm-per-prompt image=30` — 30 images per
 * request. We cap rendered pages here so the request never exceeds it.
 */
export const VISION_MAX_PAGES_PER_REQUEST = 30;

/**
 * Apply this scale to PDF page rendering. 2.0 ≈ 144 DPI — a working
 * compromise between OCR-friendly resolution and image byte size /
 * vision token cost. Tune later from real-document test data.
 */
const VISION_RENDER_SCALE = 2.0;

type ApiMsg = { role: string; content: string | LlmContentBlock[] | null };

/**
 * Render every PDF in the chat's docStore to PNG and splice them into the
 * last user message of `apiMessages` as OpenAI-style `image_url` content
 * blocks. Returns a new array — does not mutate the input.
 *
 * Skips silently when there are no PDFs (text-only chat path is preserved).
 * Caps total pages across all PDFs at VISION_MAX_PAGES_PER_REQUEST so the
 * vLLM request never exceeds its `--limit-mm-per-prompt` cap; surplus pages
 * are dropped with a console warning so we can spot it in logs.
 */
export async function attachPdfImagesToLastUserMessage(
    apiMessages: ApiMsg[],
    docStore: DocStore,
): Promise<ApiMsg[]> {
    const pdfEntries = Array.from(docStore.entries()).filter(
        ([, info]) => info.file_type === "pdf",
    );
    if (pdfEntries.length === 0) return apiMessages;

    // Render PDFs in iteration order; stop once we hit the per-request cap.
    const blocks: LlmContentBlock[] = [];
    let pagesRemaining = VISION_MAX_PAGES_PER_REQUEST;
    for (const [docId, info] of pdfEntries) {
        if (pagesRemaining <= 0) {
            console.warn(
                `[vision] skipping ${info.filename} (${docId}) — already at the ${VISION_MAX_PAGES_PER_REQUEST}-image cap`,
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
        const t0 = Date.now();
        const pages = await renderPdfPagesToBase64(buf, {
            scale: VISION_RENDER_SCALE,
            maxPages: pagesRemaining,
        });
        console.log(
            `[vision] rendered ${pages.length} page(s) of ${info.filename} in ${Date.now() - t0}ms`,
        );
        for (const p of pages) {
            blocks.push({
                type: "image_url",
                image_url: {
                    url: `data:image/png;base64,${p.base64}`,
                    detail: "high",
                },
            });
        }
        pagesRemaining -= pages.length;
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
