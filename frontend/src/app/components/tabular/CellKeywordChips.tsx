"use client";

/**
 * feat-022 — Related-search keyword chips under the cell explanation.
 *
 * Renders LLM-suggested doc-search terms; clicking a chip drives the
 * doc-viewer's search input. Useful when the user wants to scan
 * adjacent language to verify a cell's value beyond the cited
 * passages.
 *
 * Pure render-only component — keyword extraction happens in the
 * backend prompt; ranking + dedupe happens in tabularJobs.ts'
 * sanitiseKeywords. No client-side filtering here other than skipping
 * an empty array.
 */

import { Search } from "lucide-react";

export interface CellKeywordChipsProps {
    keywords: string[];
    /** Called with the keyword string when a chip is clicked. */
    onSearch: (keyword: string) => void;
}

export function CellKeywordChips({
    keywords,
    onSearch,
}: CellKeywordChipsProps) {
    if (keywords.length === 0) return null;
    return (
        <div className="mt-2">
            <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">
                Related searches
            </p>
            <div className="flex flex-wrap gap-1.5">
                {keywords.map((kw, i) => (
                    <button
                        key={`${kw}-${i}`}
                        type="button"
                        onClick={() => onSearch(kw)}
                        title={`Search the document for "${kw}"`}
                        className="inline-flex items-center gap-1 rounded-full border border-border bg-card px-2 py-0.5 text-[11px] text-foreground transition-colors hover:bg-muted hover:border-foreground/30"
                    >
                        <Search className="h-2.5 w-2.5 text-muted-foreground/70 shrink-0" />
                        <span className="truncate max-w-[200px]">{kw}</span>
                    </button>
                ))}
            </div>
        </div>
    );
}
