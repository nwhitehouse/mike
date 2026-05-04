import path from "path";
import {
    createCanvas,
    type CanvasRenderingContext2D,
    type Canvas,
} from "canvas";

const STANDARD_FONT_DATA_URL = (() => {
    try {
        const pkgPath = require.resolve("pdfjs-dist/package.json");
        return path.join(path.dirname(pkgPath), "standard_fonts") + path.sep;
    } catch {
        return undefined;
    }
})();

type CanvasAndContext = {
    canvas: Canvas | null;
    context: CanvasRenderingContext2D | null;
};

// pdfjs in Node needs a CanvasFactory implementation it can call into to
// allocate raster surfaces during page.render(). Uses node-canvas — the
// faster `@napi-rs/canvas` rejects pdfjs's internal Path2D objects in
// ctx.fill(), which breaks glyph rendering on the very first page.
class NodeCanvasFactory {
    create(width: number, height: number): CanvasAndContext {
        const canvas = createCanvas(width, height);
        const context = canvas.getContext("2d");
        return { canvas, context };
    }
    reset(c: CanvasAndContext, width: number, height: number) {
        if (!c.canvas) throw new Error("canvas is null");
        c.canvas.width = width;
        c.canvas.height = height;
    }
    destroy(c: CanvasAndContext) {
        if (c.canvas) {
            c.canvas.width = 0;
            c.canvas.height = 0;
        }
        c.canvas = null;
        c.context = null;
    }
}

type PdfJsLib = {
    getDocument: (opts: unknown) => {
        promise: Promise<{
            numPages: number;
            getPage: (n: number) => Promise<{
                getViewport: (opts: { scale: number }) => {
                    width: number;
                    height: number;
                };
                render: (opts: unknown) => { promise: Promise<void> };
                cleanup: () => void;
            }>;
            cleanup: () => void;
            destroy: () => void;
        }>;
    };
};

export type RenderedPage = {
    pageNumber: number;
    /** PNG bytes encoded as base64 (no data:image/png;base64, prefix). */
    base64: string;
    width: number;
    height: number;
};

export type RenderPdfOptions = {
    /** Render each page at this zoom (1.0 = 72 DPI). 2.0 ≈ 144 DPI is a
     *  reasonable starting point for vision OCR — readable small text
     *  without ballooning byte count. */
    scale?: number;
    /** Cap the number of pages we render. vLLM's --limit-mm-per-prompt
     *  caps images per request, so there's no point rendering past it. */
    maxPages?: number;
};

/**
 * Render a PDF buffer to a list of base64-encoded PNGs, one per page,
 * for vision-mode chat. Cleanup-safe: all canvases destroyed even on
 * error mid-loop.
 */
export async function renderPdfPagesToBase64(
    buf: ArrayBuffer,
    opts: RenderPdfOptions = {},
): Promise<RenderedPage[]> {
    const scale = opts.scale ?? 2.0;
    const maxPages = opts.maxPages ?? 30;

    const pdfjs = (await import(
        "pdfjs-dist/legacy/build/pdf.mjs" as string
    )) as unknown as PdfJsLib;

    const factory = new NodeCanvasFactory();
    const pdf = await pdfjs.getDocument({
        data: new Uint8Array(buf),
        standardFontDataUrl: STANDARD_FONT_DATA_URL,
        canvasFactory: factory,
    }).promise;

    const out: RenderedPage[] = [];
    const pageCount = Math.min(pdf.numPages, maxPages);
    try {
        for (let i = 1; i <= pageCount; i++) {
            const page = await pdf.getPage(i);
            const viewport = page.getViewport({ scale });
            const canvasAndContext = factory.create(
                Math.ceil(viewport.width),
                Math.ceil(viewport.height),
            );
            try {
                await page.render({
                    canvasContext: canvasAndContext.context,
                    viewport,
                    canvasFactory: factory,
                }).promise;
                if (!canvasAndContext.canvas) throw new Error("canvas vanished");
                const buffer = canvasAndContext.canvas.toBuffer("image/png");
                out.push({
                    pageNumber: i,
                    base64: buffer.toString("base64"),
                    width: Math.ceil(viewport.width),
                    height: Math.ceil(viewport.height),
                });
            } finally {
                factory.destroy(canvasAndContext);
                page.cleanup();
            }
        }
    } finally {
        pdf.cleanup();
        pdf.destroy();
    }

    return out;
}
