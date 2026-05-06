import { downloadFile } from "./storage";
import { renderPdfPagesToBase64 } from "./pdfRender";
import type { DocStore } from "./chatTools";
import type { LlmContentBlock } from "./llm/types";

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
        const t0 = Date.now();
        const composites = await renderPdfPagesToBase64(buf, {
            pagesPerImage: VISION_PAGES_PER_IMAGE,
            maxPages: imagesRemaining,
        });
        console.log(
            `[vision] rendered ${composites.length} composite(s) of ${info.filename} (${VISION_PAGES_PER_IMAGE}-up) in ${Date.now() - t0}ms`,
        );
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
