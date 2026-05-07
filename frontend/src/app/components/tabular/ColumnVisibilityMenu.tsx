"use client";

/**
 * feat-021 — Manage Columns popover.
 *
 * Lives next to the "+ Add column" button in the table header. Lists every
 * column with an eye toggle (show/hide), a format pill, and a trash icon
 * that triggers the existing confirm-delete flow. Header offers
 * Show all / Hide all bulk actions.
 *
 * Visibility state is owned by TabularReviewView (localStorage-backed).
 * This component is a controlled view — render-only over props.
 */

import { useEffect, useRef, useState } from "react";
import { Eye, EyeOff, SlidersHorizontal, Trash2 } from "lucide-react";
import type { ColumnConfig } from "../shared/types";
import { formatLabel } from "./columnFormat";

export interface ColumnVisibilityMenuProps {
    columns: ColumnConfig[];
    hiddenColumnIndices: number[];
    onToggleColumn: (columnIndex: number) => void;
    onShowAll: () => void;
    onHideAll: () => void;
    onDeleteColumn: (columnIndex: number) => void;
    disabled?: boolean;
}

export function ColumnVisibilityMenu({
    columns,
    hiddenColumnIndices,
    onToggleColumn,
    onShowAll,
    onHideAll,
    onDeleteColumn,
    disabled,
}: ColumnVisibilityMenuProps) {
    const [open, setOpen] = useState(false);
    const containerRef = useRef<HTMLDivElement>(null);

    // Close on outside click. Keyed off `open` so the listener only mounts
    // while the popover is showing.
    useEffect(() => {
        if (!open) return;
        const handler = (e: MouseEvent) => {
            if (
                containerRef.current &&
                !containerRef.current.contains(e.target as Node)
            ) {
                setOpen(false);
            }
        };
        document.addEventListener("mousedown", handler);
        return () => document.removeEventListener("mousedown", handler);
    }, [open]);

    const visibleCount = columns.length - hiddenColumnIndices.length;
    const allVisible = hiddenColumnIndices.length === 0;
    const allHidden = visibleCount === 0;

    return (
        <div className="relative shrink-0" ref={containerRef}>
            <button
                type="button"
                onClick={() => setOpen((v) => !v)}
                disabled={disabled || columns.length === 0}
                title="Manage columns"
                className={`flex items-center justify-center transition-colors ${
                    disabled || columns.length === 0
                        ? "text-muted-foreground/30 cursor-default"
                        : "text-muted-foreground/70 hover:text-foreground"
                }`}
            >
                <SlidersHorizontal className="h-4 w-4" />
            </button>

            {open && (
                <div className="absolute right-0 top-full z-30 mt-1.5 w-80 rounded-xl border border-border bg-card shadow-lg">
                    <div className="flex items-center justify-between px-3 pt-3 pb-2">
                        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                            Columns
                        </span>
                        <span className="text-[10px] text-muted-foreground">
                            {visibleCount} of {columns.length} shown
                        </span>
                    </div>

                    {/* Bulk actions */}
                    <div className="flex items-center gap-3 px-3 pb-2 text-xs">
                        <button
                            type="button"
                            onClick={onShowAll}
                            disabled={allVisible}
                            className="text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40 disabled:cursor-default"
                        >
                            Show all
                        </button>
                        <span className="text-muted-foreground/40">·</span>
                        <button
                            type="button"
                            onClick={onHideAll}
                            disabled={allHidden}
                            className="text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40 disabled:cursor-default"
                        >
                            Hide all
                        </button>
                    </div>

                    <div className="max-h-[60vh] overflow-y-auto border-t border-border">
                        {columns.map((col) => {
                            const isHidden = hiddenColumnIndices.includes(
                                col.index,
                            );
                            return (
                                <div
                                    key={col.index}
                                    className="group flex items-center gap-2 px-3 py-2 hover:bg-muted transition-colors"
                                >
                                    <button
                                        type="button"
                                        onClick={() =>
                                            onToggleColumn(col.index)
                                        }
                                        title={
                                            isHidden
                                                ? "Show column"
                                                : "Hide column"
                                        }
                                        className="text-muted-foreground hover:text-foreground transition-colors shrink-0"
                                    >
                                        {isHidden ? (
                                            <EyeOff className="h-4 w-4" />
                                        ) : (
                                            <Eye className="h-4 w-4" />
                                        )}
                                    </button>
                                    <span
                                        className={`flex-1 truncate text-sm ${
                                            isHidden
                                                ? "text-muted-foreground line-through"
                                                : "text-foreground"
                                        }`}
                                        title={col.name}
                                    >
                                        {col.name}
                                    </span>
                                    <span className="shrink-0 text-[10px] uppercase tracking-wider text-muted-foreground/70">
                                        {formatLabel(col.format ?? "text")}
                                    </span>
                                    <button
                                        type="button"
                                        onClick={() =>
                                            onDeleteColumn(col.index)
                                        }
                                        title="Delete column"
                                        className="shrink-0 rounded p-0.5 text-muted-foreground/0 transition-all hover:text-red-500 group-hover:text-muted-foreground/70"
                                    >
                                        <Trash2 className="h-3.5 w-3.5" />
                                    </button>
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}
        </div>
    );
}
