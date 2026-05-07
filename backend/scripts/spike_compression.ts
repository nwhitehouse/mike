/**
 * Spike: text-as-image compression vs text + PDF multi-page-per-image vs 1-up.
 * Standalone, no production code touched. Run with:
 *   cd backend && bunx tsx scripts/spike_compression.ts
 *
 * Output: backend/spike-out/text-compression/
 *   ├── SUMMARY.md
 *   └── <variant>/<query>.md (one paired report per cell)
 */

import "dotenv/config";
import {
    writeFileSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    rmSync,
} from "fs";
import { execFileSync } from "child_process";
import path from "path";
import { createCanvas, Image, type CanvasRenderingContext2D } from "canvas";
import { downloadFile } from "../src/lib/storage";
import { extractPdfText } from "../src/lib/chatTools";

// ─── Setup ──────────────────────────────────────────────────────────────────

// Round 3: lock-in test on a denser, currency-heavy doc.
const STORAGE_PATH =
    "documents/3baedd04-fc26-4557-a792-5a20be3c1de8/7a4d2b88-f752-4874-a62a-c789243e3e1b/source.pdf";
const DOC_LABEL = "sek-1300000000-eur-290000000";

const OLAVA_BASE_URL = process.env.OLAVA_BASE_URL!;
const OLAVA_AUTH_TOKEN = process.env.OLAVA_AUTH_TOKEN ?? "";
const MODEL = "Qwen/Qwen3.6-35B-A3B";

const OUT_DIR = path.join(__dirname, `../spike-out/text-compression-${DOC_LABEL}`);

// vLLM is configured with --limit-mm-per-prompt image=30, so any variant
// that produces more than 30 images is invalid for this test.
const VLLM_IMAGE_CAP = 30;

// ─── Test queries ───────────────────────────────────────────────────────────

type QueryDef = {
    id: string;
    label: string;
    fidelityType: "verbatim" | "numeric" | "date" | "names" | "summary";
    prompt: string;
};

const QUERIES: QueryDef[] = [
    {
        id: "verbatim",
        label: "Verbatim quote of an Events of Default clause",
        fidelityType: "verbatim",
        prompt:
            "Quote ONE complete Event of Default clause from this agreement EXACTLY as it appears in the document. Pick the first numbered/lettered Event of Default item. Do not paraphrase, do not summarize, do not add or omit a single word. Output only the verbatim quoted text in a fenced code block.",
    },
    {
        id: "numeric",
        label: "Principal amount(s) of the facility",
        fidelityType: "numeric",
        prompt:
            "What is the total principal amount of the loan or facility provided under this agreement? Give the EXACT figures (currency, number, units) as written. If multiple tranches or currencies are involved, list each with its exact amount. Two sentences max.",
    },
    {
        id: "date",
        label: "Date of the agreement",
        fidelityType: "date",
        prompt:
            "What is the date of this agreement? Quote the exact date as it appears on the agreement, including any 'as of' wording. One sentence.",
    },
    {
        id: "names",
        label: "Full legal names of the parties",
        fidelityType: "names",
        prompt:
            "List the FULL legal names of the parties to this agreement (borrower, lender, agent, guarantor — whichever apply), EXACTLY as written in the document, including any corporate suffixes (Inc., LLC, AB, NV, etc.) and country/state of incorporation if mentioned. Output as a bulleted list.",
    },
    {
        id: "summary",
        label: "Repayment terms summary",
        fidelityType: "summary",
        prompt:
            "Summarize the repayment terms of the loan/facility in 3-5 sentences. Cover the maturity date or term, any scheduled amortization, any prepayment provisions, and the interest rate basis (e.g. LIBOR + margin).",
    },
];

// ─── Text-as-image renderer (Spike A) ──────────────────────────────────────

type RenderOpts = {
    fontPx: number;
    /** chars per line — drives canvas width via fontPx */
    cols: number;
    /** lines per image — drives canvas height + page count */
    linesPerImage: number;
};

const SPIKE_A_VARIANTS: { name: string; opts: RenderOpts }[] = [
    // Round 3: only the round-1/2 winner candidate.
    { name: "text-img-6pt", opts: { fontPx: 8, cols: 150, linesPerImage: 100 } },
];

// Text-image multi-up grid: failed in round 2 (hallucinations on 10pt-4up).
// Skipped in round 3.
const SPIKE_AB_VARIANTS: {
    name: string;
    opts: RenderOpts;
    pagesPerImage: number;
    cols: number;
    rows: number;
}[] = [];

function renderTextAsImages(text: string, opts: RenderOpts): string[] {
    const lines = wrapTextToLines(text, opts.cols);
    const out: string[] = [];
    for (let i = 0; i < lines.length; i += opts.linesPerImage) {
        const slice = lines.slice(i, i + opts.linesPerImage);
        const png = renderLinesToPng(slice, opts);
        out.push(png);
    }
    return out;
}

function wrapTextToLines(text: string, cols: number): string[] {
    const out: string[] = [];
    for (const para of text.split(/\n/)) {
        if (para.length <= cols) {
            out.push(para);
            continue;
        }
        // Word-wrap on whitespace; fall back to hard break for runs > cols
        const words = para.split(/\s+/);
        let cur = "";
        for (const w of words) {
            if (!cur) {
                cur = w;
                continue;
            }
            if (cur.length + 1 + w.length <= cols) {
                cur += " " + w;
            } else {
                out.push(cur);
                cur = w;
            }
            // Hard-break runs longer than cols
            while (cur.length > cols) {
                out.push(cur.slice(0, cols));
                cur = cur.slice(cols);
            }
        }
        if (cur) out.push(cur);
    }
    return out;
}

function renderLinesToPng(lines: string[], opts: RenderOpts): string {
    // Estimate widths: monospace 16px ≈ 9.6 px/char in Courier
    const charPx = Math.round(opts.fontPx * 0.6);
    const lineHeight = Math.round(opts.fontPx * 1.25);
    const padding = 24;
    const width = padding * 2 + opts.cols * charPx;
    const height = padding * 2 + opts.linesPerImage * lineHeight;

    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = "#000000";
    ctx.font = `${opts.fontPx}px Courier`;
    ctx.textBaseline = "top";

    for (let i = 0; i < lines.length; i++) {
        ctx.fillText(lines[i], padding, padding + i * lineHeight);
    }
    return canvas.toBuffer("image/png").toString("base64");
}

/** Compose tiles into a grid. Each input tile is a base64 PNG; output is
 *  a base64 PNG of cols × rows tile slots. Last composite may be partial. */
function composeGrid(
    tilesBase64: string[],
    pagesPerImage: number,
    cols: number,
    rows: number,
): string[] {
    if (tilesBase64.length === 0) return [];
    if (pagesPerImage === 1) return tilesBase64;

    // Probe first tile dimensions
    const firstBytes = Buffer.from(tilesBase64[0], "base64");
    const tileWidth = firstBytes.readUInt32BE(16);
    const tileHeight = firstBytes.readUInt32BE(20);
    const compositeWidth = tileWidth * cols;
    const compositeHeight = tileHeight * rows;

    const composites: string[] = [];
    for (let i = 0; i < tilesBase64.length; i += pagesPerImage) {
        const slice = tilesBase64.slice(i, i + pagesPerImage);
        const canvas = createCanvas(compositeWidth, compositeHeight);
        const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, compositeWidth, compositeHeight);
        for (let j = 0; j < slice.length; j++) {
            const img = new Image();
            img.src = Buffer.from(slice[j], "base64");
            const col = j % cols;
            const row = Math.floor(j / cols);
            ctx.drawImage(img, col * tileWidth, row * tileHeight);
        }
        composites.push(canvas.toBuffer("image/png").toString("base64"));
    }
    return composites;
}

// ─── PDF multi-page-per-image renderer (Spike B) ───────────────────────────

const SPIKE_B_VARIANTS: {
    name: string;
    pagesPerImage: number;
    cols: number; // grid columns
    rows: number; // grid rows
}[] = [
    // Round 3: keep all three so we can see the same compression curve on a
    // different doc and confirm pdf-4up is still the sweet spot.
    { name: "pdf-1up", pagesPerImage: 1, cols: 1, rows: 1 },
    { name: "pdf-4up", pagesPerImage: 4, cols: 2, rows: 2 },
    { name: "pdf-8up", pagesPerImage: 8, cols: 2, rows: 4 },
];

type RenderedPage = { base64: string; width: number; height: number };

/** Render PDF pages to PNG via pdftoppm (poppler). pdfjs+node-canvas
 *  produces blank pages on this stack — see investigation in spike notes.
 *  pdftoppm is battle-tested and renders glyphs correctly. Spike-only
 *  workaround; production pipeline is a separate fix. */
function renderPagesViaPdftoppm(buf: Buffer, dpi: number): RenderedPage[] {
    const tmpDir = `/tmp/spike-pdftoppm-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    mkdirSync(tmpDir, { recursive: true });
    const pdfPath = path.join(tmpDir, "src.pdf");
    writeFileSync(pdfPath, buf);
    const outPrefix = path.join(tmpDir, "page");
    execFileSync(
        "pdftoppm",
        ["-png", "-r", String(dpi), pdfPath, outPrefix],
        { stdio: "ignore" },
    );
    // pdftoppm emits page-1.png, page-2.png, ... (1-indexed, padded if many)
    const files = readdirSync(tmpDir)
        .filter((f) => f.startsWith("page-") && f.endsWith(".png"))
        .sort((a, b) => {
            const na = parseInt(a.match(/page-(\d+)\.png/)?.[1] ?? "0", 10);
            const nb = parseInt(b.match(/page-(\d+)\.png/)?.[1] ?? "0", 10);
            return na - nb;
        });
    const pages: RenderedPage[] = [];
    for (const f of files) {
        const bytes = readFileSync(path.join(tmpDir, f));
        // Cheap PNG dimension parse: width = bytes[16..19], height = [20..23]
        const width = bytes.readUInt32BE(16);
        const height = bytes.readUInt32BE(20);
        pages.push({
            base64: bytes.toString("base64"),
            width,
            height,
        });
    }
    rmSync(tmpDir, { recursive: true, force: true });
    return pages;
}

function renderPdfMultiUp(
    buf: Buffer,
    pagesPerImage: number,
    cols: number,
    rows: number,
): string[] {
    const pages = renderPagesViaPdftoppm(buf, 144);
    if (pages.length === 0) return [];

    if (pagesPerImage === 1) {
        return pages.map((p) => p.base64);
    }

    const composites: string[] = [];
    const tileWidth = pages[0].width;
    const tileHeight = pages[0].height;
    const compositeWidth = tileWidth * cols;
    const compositeHeight = tileHeight * rows;

    for (let i = 0; i < pages.length; i += pagesPerImage) {
        const slice = pages.slice(i, i + pagesPerImage);
        const canvas = createCanvas(compositeWidth, compositeHeight);
        const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, compositeWidth, compositeHeight);

        for (let j = 0; j < slice.length; j++) {
            const img = new Image();
            img.src = Buffer.from(slice[j].base64, "base64");
            const col = j % cols;
            const row = Math.floor(j / cols);
            ctx.drawImage(img, col * tileWidth, row * tileHeight);
        }
        composites.push(canvas.toBuffer("image/png").toString("base64"));
    }
    return composites;
}

// ─── Olava client ──────────────────────────────────────────────────────────

type CallResult = {
    response: string;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    latencyMs: number;
    imageCount: number;
    error?: string;
};

async function callOlava(args: {
    query: string;
    text?: string;
    imagesBase64?: string[];
}): Promise<CallResult> {
    const { query, text, imagesBase64 } = args;

    const userContent: unknown[] = [{ type: "text", text: query }];
    if (text) {
        userContent.push({
            type: "text",
            text: `\n\nDOCUMENT TEXT:\n${text}`,
        });
    }
    if (imagesBase64) {
        for (const b64 of imagesBase64) {
            userContent.push({
                type: "image_url",
                image_url: {
                    url: `data:image/png;base64,${b64}`,
                    detail: "high",
                },
            });
        }
    }

    const body = {
        model: MODEL,
        messages: [
            {
                role: "system",
                content:
                    "You are a legal-document analyst. Read carefully. Answer the user's question concisely and accurately. If the user asks for a verbatim quote, quote exactly with no paraphrase. If asked for an exact figure or date, give it precisely. Skip preamble; answer directly.",
            },
            { role: "user", content: userContent },
        ],
        max_tokens: 4096,
        temperature: 0.1,
    };

    const t0 = Date.now();
    let resp: Response;
    try {
        resp = await fetch(`${OLAVA_BASE_URL}/chat/completions`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                ...(OLAVA_AUTH_TOKEN
                    ? { Authorization: `Bearer ${OLAVA_AUTH_TOKEN}` }
                    : {}),
            },
            body: JSON.stringify(body),
        });
    } catch (err) {
        return {
            response: "",
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0,
            latencyMs: Date.now() - t0,
            imageCount: imagesBase64?.length ?? 0,
            error: `fetch failed: ${err}`,
        };
    }
    const latencyMs = Date.now() - t0;

    if (!resp.ok) {
        const errText = await resp.text().catch(() => "");
        return {
            response: "",
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0,
            latencyMs,
            imageCount: imagesBase64?.length ?? 0,
            error: `HTTP ${resp.status}: ${errText.slice(0, 500)}`,
        };
    }
    const json = (await resp.json()) as {
        choices?: Array<{ message?: { content?: string | null } }>;
        usage?: {
            prompt_tokens?: number;
            completion_tokens?: number;
            total_tokens?: number;
        };
    };
    const responseText =
        stripThink(json.choices?.[0]?.message?.content ?? "") || "";
    return {
        response: responseText,
        promptTokens: json.usage?.prompt_tokens ?? 0,
        completionTokens: json.usage?.completion_tokens ?? 0,
        totalTokens: json.usage?.total_tokens ?? 0,
        latencyMs,
        imageCount: imagesBase64?.length ?? 0,
    };
}

function stripThink(text: string): string {
    return text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

// ─── Runner ────────────────────────────────────────────────────────────────

async function main() {
    mkdirSync(OUT_DIR, { recursive: true });

    console.log("[spike] downloading PDF…");
    const buf = await downloadFile(STORAGE_PATH);
    if (!buf) throw new Error(`failed to download ${DOC_LABEL}`);
    console.log(`[spike] PDF: ${buf.byteLength} bytes`);
    // pdfjs's Worker detaches the underlying ArrayBuffer when it constructs
    // the Uint8Array — subsequent consumers see a detached buffer. Stash
    // the bytes in a Buffer and clone an ArrayBuffer per consumer call.
    const pdfBytes = Buffer.from(buf);
    const cloneBuf = (): ArrayBuffer => {
        const ab = new ArrayBuffer(pdfBytes.length);
        new Uint8Array(ab).set(pdfBytes);
        return ab;
    };

    console.log("[spike] extracting text…");
    const docText = await extractPdfText(cloneBuf());
    console.log(`[spike] text: ${docText.length} chars`);

    // Build all variants up front
    type Variant = {
        name: string;
        kind: "text" | "image";
        text?: string;
        images?: string[];
    };

    const variants: Variant[] = [];
    variants.push({ name: "text-baseline", kind: "text", text: docText });

    for (const v of SPIKE_A_VARIANTS) {
        const t0 = Date.now();
        const imgs = renderTextAsImages(docText, v.opts);
        console.log(
            `[spike] ${v.name}: ${imgs.length} images in ${Date.now() - t0}ms`,
        );
        if (imgs.length > VLLM_IMAGE_CAP) {
            console.warn(
                `[spike] ${v.name} produced ${imgs.length} images (>${VLLM_IMAGE_CAP}). Truncating to first ${VLLM_IMAGE_CAP}.`,
            );
        }
        variants.push({
            name: v.name,
            kind: "image",
            images: imgs.slice(0, VLLM_IMAGE_CAP),
        });
    }

    for (const v of SPIKE_B_VARIANTS) {
        const t0 = Date.now();
        const imgs = renderPdfMultiUp(
            pdfBytes,
            v.pagesPerImage,
            v.cols,
            v.rows,
        );
        console.log(
            `[spike] ${v.name}: ${imgs.length} composites in ${Date.now() - t0}ms`,
        );
        if (imgs.length > VLLM_IMAGE_CAP) {
            console.warn(
                `[spike] ${v.name} produced ${imgs.length} images (>${VLLM_IMAGE_CAP}). Truncating to first ${VLLM_IMAGE_CAP}.`,
            );
        }
        variants.push({
            name: v.name,
            kind: "image",
            images: imgs.slice(0, VLLM_IMAGE_CAP),
        });
    }

    // Spike A+B: text rendered at small size, then composed into a grid.
    for (const v of SPIKE_AB_VARIANTS) {
        const t0 = Date.now();
        const tiles = renderTextAsImages(docText, v.opts);
        const imgs = composeGrid(tiles, v.pagesPerImage, v.cols, v.rows);
        console.log(
            `[spike] ${v.name}: ${tiles.length} tiles → ${imgs.length} composites in ${Date.now() - t0}ms`,
        );
        if (imgs.length > VLLM_IMAGE_CAP) {
            console.warn(
                `[spike] ${v.name} produced ${imgs.length} images (>${VLLM_IMAGE_CAP}). Truncating to first ${VLLM_IMAGE_CAP}.`,
            );
        }
        variants.push({
            name: v.name,
            kind: "image",
            images: imgs.slice(0, VLLM_IMAGE_CAP),
        });
    }

    // Run cells
    type Cell = {
        variant: string;
        query: string;
        result: CallResult;
    };
    const cells: Cell[] = [];

    for (const variant of variants) {
        mkdirSync(path.join(OUT_DIR, variant.name), { recursive: true });
        for (const q of QUERIES) {
            console.log(`[spike] running ${variant.name} / ${q.id}…`);
            const result = await callOlava({
                query: q.prompt,
                text: variant.text,
                imagesBase64: variant.images,
            });
            cells.push({ variant: variant.name, query: q.id, result });
            // Per-cell report
            const cellReport = [
                `# ${variant.name} / ${q.id}`,
                ``,
                `**Fidelity type:** ${q.fidelityType}`,
                `**Image count:** ${result.imageCount}`,
                `**Prompt tokens:** ${result.promptTokens}`,
                `**Completion tokens:** ${result.completionTokens}`,
                `**Total tokens:** ${result.totalTokens}`,
                `**Latency:** ${result.latencyMs}ms`,
                ``,
                result.error ? `## Error\n\n${result.error}` : "",
                `## Query`,
                ``,
                q.prompt,
                ``,
                `## Response`,
                ``,
                result.response || "(empty)",
            ].join("\n");
            writeFileSync(
                path.join(OUT_DIR, variant.name, `${q.id}.md`),
                cellReport,
            );
            console.log(
                `  ${result.totalTokens} tok in ${result.latencyMs}ms${result.error ? " ERR " + result.error.slice(0, 80) : ""}`,
            );
        }
    }

    // Summary matrix
    const variantNames = variants.map((v) => v.name);
    const queryIds = QUERIES.map((q) => q.id);

    let summary = "# Spike: text-as-image compression\n\n";
    summary += `Doc: Hawaiian Telcom Services.pdf (${docText.length} chars)\n`;
    summary += `Model: ${MODEL}\n`;
    summary += `vLLM image cap: ${VLLM_IMAGE_CAP}\n\n`;

    // Token usage
    summary += "## Total tokens (prompt + completion)\n\n";
    summary += `| variant | imgs | ` + queryIds.join(" | ") + " | avg |\n";
    summary += `|---|---|` + queryIds.map(() => "---").join("|") + "|---|\n";
    for (const v of variantNames) {
        const row = cells.filter((c) => c.variant === v);
        const imgCount = row[0]?.result.imageCount ?? 0;
        const totals = row.map((c) => c.result.totalTokens);
        const avg = Math.round(totals.reduce((a, b) => a + b, 0) / totals.length);
        summary +=
            `| ${v} | ${imgCount} | ` + totals.join(" | ") + ` | ${avg} |\n`;
    }

    // Latency
    summary += "\n## Latency (ms)\n\n";
    summary += `| variant | ` + queryIds.join(" | ") + " | avg |\n";
    summary += `|---|` + queryIds.map(() => "---").join("|") + "|---|\n";
    for (const v of variantNames) {
        const row = cells.filter((c) => c.variant === v);
        const lats = row.map((c) => c.result.latencyMs);
        const avg = Math.round(lats.reduce((a, b) => a + b, 0) / lats.length);
        summary += `| ${v} | ` + lats.join(" | ") + ` | ${avg} |\n`;
    }

    // Token reduction vs text-baseline
    const baseline = cells.filter((c) => c.variant === "text-baseline");
    const baselineByQuery: Record<string, number> = {};
    for (const c of baseline) baselineByQuery[c.query] = c.result.totalTokens;

    summary += "\n## Token reduction vs text-baseline (lower is more compression)\n\n";
    summary += `| variant | ` + queryIds.join(" | ") + " | avg |\n";
    summary += `|---|` + queryIds.map(() => "---").join("|") + "|---|\n";
    for (const v of variantNames) {
        const row = cells.filter((c) => c.variant === v);
        const ratios = row.map((c) => {
            const base = baselineByQuery[c.query];
            if (!base) return "—";
            return (c.result.totalTokens / base).toFixed(2) + "×";
        });
        const numericRatios = row
            .map((c) => {
                const base = baselineByQuery[c.query];
                return base ? c.result.totalTokens / base : null;
            })
            .filter((r): r is number => r !== null);
        const avg =
            numericRatios.length > 0
                ? (
                      numericRatios.reduce((a, b) => a + b, 0) /
                      numericRatios.length
                  ).toFixed(2) + "×"
                : "—";
        summary += `| ${v} | ` + ratios.join(" | ") + ` | ${avg} |\n`;
    }

    // Errors
    const errors = cells.filter((c) => c.result.error);
    if (errors.length) {
        summary += "\n## Errors\n\n";
        for (const e of errors) {
            summary += `- **${e.variant} / ${e.query}**: ${e.result.error}\n`;
        }
    }

    // Per-cell file links for fidelity review
    summary += "\n## Per-cell reports (for fidelity comparison)\n\n";
    for (const q of QUERIES) {
        summary += `### ${q.id} — ${q.label}\n\n`;
        for (const v of variantNames) {
            summary += `- [${v}](./${v}/${q.id}.md)\n`;
        }
        summary += "\n";
    }

    writeFileSync(path.join(OUT_DIR, "SUMMARY.md"), summary);
    console.log("[spike] done. SUMMARY.md written to", OUT_DIR);
}

main().catch((err) => {
    console.error("[spike] fatal:", err);
    process.exit(1);
});
