"use client";

const PAGE_CITATION_RE = /\[\[page:(\d+)\|\|(?:quote:)?((?:[^\[\]]|\[[^\]]*\])+)\]\]/gi;

export interface ParsedCitation {
    page: number;
    quote: string;
}

/**
 * Replaces [[page:n||quote:...]] markers with `§idx§` placeholders.
 * Returns the processed string and an ordered array of extracted citation data.
 */
export function preprocessCitations(text: string): {
    processed: string;
    citations: ParsedCitation[];
} {
    const citations: ParsedCitation[] = [];
    PAGE_CITATION_RE.lastIndex = 0;
    const processed = text.replace(PAGE_CITATION_RE, (_, page, quote) => {
        const idx = citations.length;
        citations.push({ page: parseInt(page, 10), quote: quote.trim() });
        return `§${idx}§`;
    });
    return { processed, citations };
}

/**
 * feat-022 — fallback for cells where the LLM wrote "Page 5" in prose
 * instead of emitting a [[page:5||quote:...]] marker. Scans summary +
 * reasoning for prose page references and returns them as quoteless
 * citations, deduped against any already-parsed structured citations.
 *
 * Patterns matched (case-insensitive):
 *   "Page 5" / "page 5" / "PAGE 5"
 *   "p. 5" / "pp. 5"
 *
 * The empty-quote ParsedCitation is intentional — CellCitationChips
 * falls back to "Page N" labelling and the page-jump still works
 * because the doc-viewer flow only needs a page number to navigate.
 */
export function extractProsePageRefs(
    text: string,
    excludePages: Set<number> = new Set(),
): ParsedCitation[] {
    const out: ParsedCitation[] = [];
    const seen = new Set(excludePages);
    const re = /\b(?:page|pages|pp?\.)\s*(\d+)/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
        const page = parseInt(m[1], 10);
        if (!Number.isFinite(page) || page < 1) continue;
        if (seen.has(page)) continue;
        seen.add(page);
        out.push({ page, quote: "" });
    }
    return out;
}
