/**
 * feat-023 — Tabular review filter predicates.
 *
 * Pure functions only — no React, no store. The TRFilterBar builds an
 * array of TRFilter conditions; TabularReviewView feeds each (cell,
 * filter) pair through `cellMatches` and unions the result per
 * document_id to compute the visible row set.
 *
 * v1 is client-side: cells are already in memory after the initial
 * /tabular-review/:reviewId fetch. Server-side filtering becomes
 * worthwhile only when the initial payload itself starts being slow
 * (~500+ rows × columns). At that point this module can move to a
 * shared backend predicate without changing the frontend wiring.
 */

import type { TabularCell } from "../shared/types";

export type TextOperator =
    | "contains"
    | "does_not_contain"
    | "is"
    | "is_not"
    | "is_empty"
    | "is_not_empty";

export type FlagValue = "green" | "yellow" | "red" | "grey";

export type TRFilter =
    | { kind: "flag"; flags: FlagValue[] }
    | { kind: "verified"; state: "verified" | "unverified" }
    | {
          kind: "text";
          columnIndex: number;
          operator: TextOperator;
          value: string;
      };

/** Human-readable label for a text operator. Used in the active-filter pill. */
export const TEXT_OPERATOR_LABELS: Record<TextOperator, string> = {
    contains: "contains",
    does_not_contain: "does not contain",
    is: "is",
    is_not: "is not",
    is_empty: "is empty",
    is_not_empty: "is not empty",
};

/** Human-readable label for a flag. */
export const FLAG_LABELS: Record<FlagValue, string> = {
    green: "Green",
    yellow: "Yellow",
    red: "Red",
    grey: "Grey",
};

/**
 * Test a single cell against a single filter.
 *
 * For text predicates, `summary` is the substrate. Empty values
 * compare as empty strings (no nullish surprise). String comparison
 * is case-insensitive for `contains` / `does_not_contain` / `is` /
 * `is_not` — the user's typing the filter value in plain language.
 */
export function cellMatches(cell: TabularCell, filter: TRFilter): boolean {
    if (filter.kind === "flag") {
        const flag = (cell.content?.flag ?? "grey") as FlagValue;
        return filter.flags.includes(flag);
    }
    if (filter.kind === "verified") {
        const verified = !!cell.verified;
        return filter.state === "verified" ? verified : !verified;
    }
    // text predicate
    if (cell.column_index !== filter.columnIndex) return false;
    const summary = (cell.content?.summary ?? "").trim().toLowerCase();
    const target = filter.value.trim().toLowerCase();
    switch (filter.operator) {
        case "contains":
            return summary.includes(target);
        case "does_not_contain":
            return !summary.includes(target);
        case "is":
            return summary === target;
        case "is_not":
            return summary !== target;
        case "is_empty":
            return summary.length === 0;
        case "is_not_empty":
            return summary.length > 0;
    }
}

/**
 * Compute the document_ids whose cells satisfy *all* active filters.
 *
 * Conjunction across filters of different kinds (flag + verified + text)
 * is straightforward: every filter must hold.
 *
 * For per-column text filters the rule is "the cell at that column for
 * this doc must match" — silently false if no cell exists yet (pending
 * generate). Flag and verified filters apply to *any* cell on the doc;
 * a doc passes if at least one cell flags red, etc. — that matches the
 * Excel-filter mental model the user is reaching for.
 */
export function computeVisibleDocIds(
    documentIds: string[],
    cells: TabularCell[],
    filters: TRFilter[],
): Set<string> {
    if (filters.length === 0) return new Set(documentIds);

    // Index cells by document_id for O(N) lookups.
    const cellsByDoc = new Map<string, TabularCell[]>();
    for (const cell of cells) {
        const list = cellsByDoc.get(cell.document_id);
        if (list) list.push(cell);
        else cellsByDoc.set(cell.document_id, [cell]);
    }

    const visible = new Set<string>();
    for (const docId of documentIds) {
        const docCells = cellsByDoc.get(docId) ?? [];
        const passes = filters.every((f) => {
            if (f.kind === "text") {
                const cell = docCells.find(
                    (c) => c.column_index === f.columnIndex,
                );
                if (!cell) return false;
                return cellMatches(cell, f);
            }
            // flag / verified — any cell on the doc satisfies.
            return docCells.some((c) => cellMatches(c, f));
        });
        if (passes) visible.add(docId);
    }
    return visible;
}
