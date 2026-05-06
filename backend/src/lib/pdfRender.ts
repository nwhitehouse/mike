import {
    writeFileSync,
    readFileSync,
    readdirSync,
    rmSync,
    mkdirSync,
} from "fs";
import { execFileSync } from "child_process";
import path from "path";
import os from "os";
import {
    createCanvas,
    Image,
    type CanvasRenderingContext2D,
    type Canvas,
} from "canvas";

/**
 * Render a PDF buffer to one or more base64-encoded PNGs for vision-mode
 * chat. Each output image can contain a single page (1-up) or N pages laid
 * out in a grid (e.g. 4-up = 2×2). Multi-up gives ≈3× token compression
 * versus 1-up at no fidelity loss on legal-grade content (validated in
 * spike-out/text-compression on a 25-page services agreement and a 75-page
 * SEK financing doc).
 *
 * Rendering shells out to `pdftoppm` from poppler-utils — the in-process
 * pdfjs+node-canvas path produced blank pages on this stack (canvas v3
 * dropped Path2D, and the path2d polyfill didn't bridge pdfjs's glyph
 * code). `pdftoppm` is battle-tested and renders glyphs correctly.
 *
 * Caller (lib/visionContext.ts) caps the total number of returned images
 * at vLLM's --limit-mm-per-prompt. With pagesPerImage=4 and an image cap
 * of 100, that's 400 PDF pages of context per request.
 */

export type RenderedPage = {
    /** 1-indexed composite number (i.e. which N-page tile in the output). */
    pageNumber: number;
    /** PNG bytes encoded as base64 (no data:image/png;base64, prefix). */
    base64: string;
    width: number;
    height: number;
};

export type RenderPdfOptions = {
    /** Render-time DPI. 144 ≈ 2× the PDF's native point-per-inch. Lower
     *  reduces image bytes; higher costs vision tokens after vLLM's image
     *  resize and yields no visible benefit beyond ~150 DPI for legal text. */
    dpi?: number;
    /** Cap the number of output IMAGES (not pages). With pagesPerImage > 1
     *  the page capacity is `pagesPerImage × maxPages`. */
    maxPages?: number;
    /** How many PDF pages to compose into a single output image. 1 = each
     *  page on its own image. 4 = 2×2 grid (default — best token vs
     *  fidelity tradeoff on Olava per the spike). */
    pagesPerImage?: number;
};

const DEFAULT_PAGES_PER_IMAGE = 4;
const DEFAULT_DPI = 144;
const DEFAULT_MAX_IMAGES = 100;

export async function renderPdfPagesToBase64(
    buf: ArrayBuffer | Buffer,
    opts: RenderPdfOptions = {},
): Promise<RenderedPage[]> {
    const dpi = opts.dpi ?? DEFAULT_DPI;
    const pagesPerImage = opts.pagesPerImage ?? DEFAULT_PAGES_PER_IMAGE;
    const maxImages = opts.maxPages ?? DEFAULT_MAX_IMAGES;

    const pdfBytes = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);

    // Render every page individually via pdftoppm. We then either pass
    // through (1-up) or compose into a grid (N-up).
    const tiles = renderPagesViaPdftoppm(pdfBytes, dpi);
    if (tiles.length === 0) return [];

    if (pagesPerImage === 1) {
        return tiles
            .slice(0, maxImages)
            .map((t, i) => ({
                pageNumber: i + 1,
                base64: t.base64,
                width: t.width,
                height: t.height,
            }));
    }

    return composeGrid(tiles, pagesPerImage, maxImages);
}

// ─── pdftoppm shell-out ────────────────────────────────────────────────────

type RawTile = { base64: string; width: number; height: number };

function renderPagesViaPdftoppm(buf: Buffer, dpi: number): RawTile[] {
    const tmpDir = mkSafeTmpDir("mike-pdfrender");
    const pdfPath = path.join(tmpDir, "src.pdf");
    const outPrefix = path.join(tmpDir, "page");
    try {
        writeFileSync(pdfPath, buf);
        execFileSync(
            "pdftoppm",
            ["-png", "-r", String(dpi), pdfPath, outPrefix],
            { stdio: "ignore" },
        );
        const files = readdirSync(tmpDir)
            .filter((f) => f.startsWith("page-") && f.endsWith(".png"))
            .sort((a, b) => {
                const na = parseInt(
                    a.match(/page-(\d+)\.png/)?.[1] ?? "0",
                    10,
                );
                const nb = parseInt(
                    b.match(/page-(\d+)\.png/)?.[1] ?? "0",
                    10,
                );
                return na - nb;
            });
        const tiles: RawTile[] = [];
        for (const f of files) {
            const bytes = readFileSync(path.join(tmpDir, f));
            // PNG IHDR chunk: width = bytes[16..19], height = [20..23]
            // (big-endian uint32). Cheaper than constructing an Image just
            // to read dimensions.
            const width = bytes.readUInt32BE(16);
            const height = bytes.readUInt32BE(20);
            tiles.push({
                base64: bytes.toString("base64"),
                width,
                height,
            });
        }
        return tiles;
    } finally {
        rmSync(tmpDir, { recursive: true, force: true });
    }
}

function mkSafeTmpDir(prefix: string): string {
    const dir = path.join(
        os.tmpdir(),
        `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    );
    mkdirSync(dir, { recursive: true });
    return dir;
}

// ─── Grid composition (N-up) ───────────────────────────────────────────────

/**
 * Compose tiles into a grid. Default is 2×2 (4-up); we pick a grid that
 * keeps pages roughly portrait-oriented. Last composite may be partial
 * (white-padded). Returns RenderedPage[] with synthetic 1-indexed
 * pageNumber per composite (not per source page).
 */
function composeGrid(
    tiles: RawTile[],
    pagesPerImage: number,
    maxImages: number,
): RenderedPage[] {
    if (tiles.length === 0) return [];
    const { cols, rows } = pickGrid(pagesPerImage);

    const tileWidth = tiles[0].width;
    const tileHeight = tiles[0].height;
    const compositeWidth = tileWidth * cols;
    const compositeHeight = tileHeight * rows;

    const out: RenderedPage[] = [];
    for (let i = 0; i < tiles.length; i += pagesPerImage) {
        if (out.length >= maxImages) break;
        const slice = tiles.slice(i, i + pagesPerImage);
        const canvas: Canvas = createCanvas(compositeWidth, compositeHeight);
        const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
        // White background so partial composites read as a clean page rather
        // than transparent → undefined behavior in the vision encoder.
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, compositeWidth, compositeHeight);
        for (let j = 0; j < slice.length; j++) {
            const img = new Image();
            img.src = Buffer.from(slice[j].base64, "base64");
            const col = j % cols;
            const row = Math.floor(j / cols);
            ctx.drawImage(img, col * tileWidth, row * tileHeight);
        }
        out.push({
            pageNumber: out.length + 1,
            base64: canvas.toBuffer("image/png").toString("base64"),
            width: compositeWidth,
            height: compositeHeight,
        });
    }
    return out;
}

function pickGrid(pagesPerImage: number): { cols: number; rows: number } {
    // Match the spike's tested layouts. Beyond 4 we lean toward more rows
    // than columns to keep the per-tile aspect ratio close to portrait.
    switch (pagesPerImage) {
        case 1:
            return { cols: 1, rows: 1 };
        case 2:
            return { cols: 1, rows: 2 };
        case 4:
            return { cols: 2, rows: 2 };
        case 6:
            return { cols: 2, rows: 3 };
        case 8:
            return { cols: 2, rows: 4 };
        default: {
            const cols = Math.ceil(Math.sqrt(pagesPerImage));
            const rows = Math.ceil(pagesPerImage / cols);
            return { cols, rows };
        }
    }
}
