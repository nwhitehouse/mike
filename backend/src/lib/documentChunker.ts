/**
 * feat-024 — Markdown → chunks for embedding.
 *
 * Sliding window over the doc text: ~800 tokens per chunk, ~150 token
 * overlap. Mirrors the work___ sizing — small enough that a chunk's
 * embedding is a tight cluster, large enough that retrieved chunks
 * carry enough surrounding context to be useful as LLM context.
 *
 * Tokens are approximated as 4 characters each — fine for OpenAI
 * BPE on English/legal text; we don't need byte-perfect counting
 * because the cap is a budget, not a hard limit.
 *
 * Page tracking: the existing extractPdfMarkdown emits "## Page N"
 * headings between pages. We track which page boundaries fall inside
 * each chunk so retrieved chunks can carry a page_start/page_end
 * back to the chat for citation rendering. DOCX has no page concept;
 * those chunks get null page bounds.
 */

const TARGET_CHUNK_CHARS = 3200; // ~800 tokens at 4 chars/token
const OVERLAP_CHARS = 600; // ~150 tokens overlap

export interface DocumentChunk {
    content: string;
    /** 0-based position in the chunk stream for this doc. */
    chunkIndex: number;
    /** First page covered by this chunk (1-based). null when not a PDF. */
    pageStart: number | null;
    /** Last page covered by this chunk. */
    pageEnd: number | null;
}

interface PageMarker {
    /** Character offset where "## Page N" appears. */
    offset: number;
    page: number;
}

function findPageMarkers(text: string): PageMarker[] {
    const markers: PageMarker[] = [];
    const re = /^## Page (\d+)/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
        markers.push({ offset: m.index, page: parseInt(m[1], 10) });
    }
    return markers;
}

/** Returns the page number that contains a given character offset, or null
 *  if no page markers exist (i.e. DOCX). */
function pageAtOffset(markers: PageMarker[], offset: number): number | null {
    if (markers.length === 0) return null;
    let current: number | null = null;
    for (const m of markers) {
        if (m.offset <= offset) current = m.page;
        else break;
    }
    return current;
}

/**
 * Greedy chunker. Walks the text in TARGET_CHUNK_CHARS windows with
 * OVERLAP_CHARS overlap between successive chunks. Tries to break on
 * paragraph boundaries (double newline) when a candidate split is
 * within 200 chars of the target — keeps clauses intact.
 */
export function chunkDocument(text: string): DocumentChunk[] {
    if (!text || text.trim().length === 0) return [];
    // Strip NUL bytes — pdfjs occasionally emits them in extracted text,
    // and Postgres' text/jsonb encoding rejects   with "unsupported
    // Unicode escape sequence". Cheap to do upfront so the chunker and
    // the page-marker scanner both see clean text.
    text = text.replace(/\u0000/g, "");
    const markers = findPageMarkers(text);
    const out: DocumentChunk[] = [];
    let pos = 0;
    let idx = 0;
    const len = text.length;

    while (pos < len) {
        const remaining = len - pos;
        if (remaining <= TARGET_CHUNK_CHARS + OVERLAP_CHARS) {
            // Last chunk — take everything left, don't pad with overlap.
            const slice = text.slice(pos).trim();
            if (slice.length > 0) {
                const start = pos;
                const end = len - 1;
                out.push({
                    content: slice,
                    chunkIndex: idx++,
                    pageStart: pageAtOffset(markers, start),
                    pageEnd: pageAtOffset(markers, end),
                });
            }
            break;
        }

        // Initial split is at TARGET_CHUNK_CHARS — try to push to the next
        // paragraph boundary if one exists within +200 chars.
        const desiredEnd = pos + TARGET_CHUNK_CHARS;
        let splitEnd = desiredEnd;
        const lookaheadEnd = Math.min(len, desiredEnd + 200);
        const paragraphBreak = text.indexOf("\n\n", desiredEnd);
        if (paragraphBreak > 0 && paragraphBreak <= lookaheadEnd) {
            splitEnd = paragraphBreak;
        } else {
            // Otherwise try a sentence boundary in the same window.
            const sentenceBreak = text.slice(desiredEnd, lookaheadEnd).search(/[.!?]\s/);
            if (sentenceBreak >= 0) {
                splitEnd = desiredEnd + sentenceBreak + 1;
            }
        }

        const slice = text.slice(pos, splitEnd).trim();
        if (slice.length > 0) {
            out.push({
                content: slice,
                chunkIndex: idx++,
                pageStart: pageAtOffset(markers, pos),
                pageEnd: pageAtOffset(markers, splitEnd - 1),
            });
        }

        // Advance with overlap.
        pos = Math.max(splitEnd - OVERLAP_CHARS, splitEnd);
        // Defensive: if pos didn't move (degenerate text), break to avoid
        // an infinite loop.
        if (pos <= 0 || splitEnd <= pos - OVERLAP_CHARS) break;
    }

    return out;
}
