"use client";

/**
 * feat-022 — Citation chips under the cell explanation in TRDocDetailView.
 *
 * Renders a row of clickable pills, one per [[page:N||quote:…]] marker
 * parsed from the cell's summary + reasoning text. Click → jumps the
 * doc viewer to that page with the quote highlighted (handled by the
 * existing per-citation onJump callback in TRDocDetailView).
 *
 * Built generic so feat-024's RAG-chat retrieved-passage chips can
 * reuse it later — citation rows from anywhere with a {page, quote}
 * shape.
 */

import { Quote } from "lucide-react";
import type { ParsedCitation } from "./citation-utils";

export interface CellCitationChipsProps {
    citations: ParsedCitation[];
    /** Called with the citation when a chip is clicked. */
    onJump: (citation: ParsedCitation) => void;
}

/**
 * Try to label the chip with a section reference if one is at the start
 * of the quote (e.g. "Section 2.06 of the Loan Agreement..." → "Section
 * 2.06"). Falls back to "Page N". Keeps tooltips with the full quote so
 * the user can preview before clicking.
 */
function chipLabel(c: ParsedCitation): string {
    const m = c.quote.match(/^(?:§|Section)\s*\d+(?:\.\d+)*[A-Za-z]?/i);
    if (m) return m[0].replace(/^§/, "Section ").replace(/\s+/g, " ").trim();
    return `Page ${c.page}`;
}

export function CellCitationChips({
    citations,
    onJump,
}: CellCitationChipsProps) {
    if (citations.length === 0) return null;
    return (
        <div className="mt-2">
            <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">
                Citations
            </p>
            <div className="flex flex-wrap gap-1.5">
                {citations.map((c, i) => (
                    <button
                        key={`${c.page}-${i}`}
                        type="button"
                        onClick={() => onJump(c)}
                        title={c.quote}
                        className="inline-flex max-w-full items-center gap-1 rounded-full border border-border bg-card px-2 py-0.5 text-[11px] text-foreground transition-colors hover:bg-muted hover:border-foreground/30"
                    >
                        <Quote className="h-2.5 w-2.5 text-muted-foreground/70 shrink-0" />
                        <span className="truncate">{chipLabel(c)}</span>
                        <span className="shrink-0 text-muted-foreground/70">
                            · p{c.page}
                        </span>
                    </button>
                ))}
            </div>
        </div>
    );
}
