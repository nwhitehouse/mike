"use client";

/**
 * feat-023 — Filter bar above the tabular review table.
 *
 * Active-filter pill row + a "+ Add filter" popover that lets the user
 * build flag / verified / per-column-text predicates. Filter state is
 * owned by TabularReviewView (localStorage-backed) — this component is
 * a controlled view over props.
 */

import { useEffect, useRef, useState } from "react";
import { ChevronDown, Filter, X } from "lucide-react";
import type { ColumnConfig } from "../shared/types";
import {
    type FlagValue,
    type TextOperator,
    type TRFilter,
    FLAG_LABELS,
    TEXT_OPERATOR_LABELS,
} from "./trFilterPredicate";

export interface TRFilterBarProps {
    columns: ColumnConfig[];
    filters: TRFilter[];
    onChange: (next: TRFilter[]) => void;
    /** Result count + total — drives the "Showing N of M" caption. */
    visibleCount: number;
    totalCount: number;
}

const FLAGS: FlagValue[] = ["green", "yellow", "red", "grey"];
const TEXT_OPERATORS: TextOperator[] = [
    "contains",
    "does_not_contain",
    "is",
    "is_not",
    "is_empty",
    "is_not_empty",
];

const FLAG_DOT: Record<FlagValue, string> = {
    green: "bg-emerald-500",
    yellow: "bg-amber-500",
    red: "bg-red-500",
    grey: "bg-muted-foreground/60",
};

export function TRFilterBar({
    columns,
    filters,
    onChange,
    visibleCount,
    totalCount,
}: TRFilterBarProps) {
    const [adderOpen, setAdderOpen] = useState(false);
    const adderRef = useRef<HTMLDivElement>(null);

    // Close the adder on outside click while it's open.
    useEffect(() => {
        if (!adderOpen) return;
        const handler = (e: MouseEvent) => {
            if (
                adderRef.current &&
                !adderRef.current.contains(e.target as Node)
            ) {
                setAdderOpen(false);
            }
        };
        document.addEventListener("mousedown", handler);
        return () => document.removeEventListener("mousedown", handler);
    }, [adderOpen]);

    function removeAt(index: number) {
        onChange(filters.filter((_, i) => i !== index));
    }
    function clearAll() {
        onChange([]);
    }

    const filtered = filters.length > 0;

    return (
        <div className="flex flex-wrap items-center gap-2 px-8 py-2 border-b border-border bg-card">
            <Filter className="h-3.5 w-3.5 text-muted-foreground/70 shrink-0" />

            {filters.map((f, idx) => (
                <ActiveFilterPill
                    key={idx}
                    filter={f}
                    columns={columns}
                    onRemove={() => removeAt(idx)}
                />
            ))}

            <div className="relative" ref={adderRef}>
                <button
                    type="button"
                    onClick={() => setAdderOpen((v) => !v)}
                    className="inline-flex items-center gap-1 rounded-full border border-dashed border-border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:border-foreground/40 hover:text-foreground"
                >
                    + Add filter
                </button>
                {adderOpen && (
                    <AddFilterPopover
                        columns={columns}
                        existing={filters}
                        onAdd={(f) => {
                            onChange([...filters, f]);
                            setAdderOpen(false);
                        }}
                        onClose={() => setAdderOpen(false)}
                    />
                )}
            </div>

            {filtered && (
                <button
                    type="button"
                    onClick={clearAll}
                    className="text-xs text-muted-foreground transition-colors hover:text-foreground"
                >
                    Clear all
                </button>
            )}

            <div className="ml-auto text-xs text-muted-foreground">
                {filtered
                    ? `Showing ${visibleCount} of ${totalCount} document${totalCount === 1 ? "" : "s"} matching ${filters.length} filter${filters.length === 1 ? "" : "s"}`
                    : `${totalCount} document${totalCount === 1 ? "" : "s"}`}
            </div>
        </div>
    );
}

function ActiveFilterPill({
    filter,
    columns,
    onRemove,
}: {
    filter: TRFilter;
    columns: ColumnConfig[];
    onRemove: () => void;
}) {
    let label: React.ReactNode;
    if (filter.kind === "flag") {
        label = (
            <>
                Flag: {filter.flags.map((f) => FLAG_LABELS[f]).join(", ")}
            </>
        );
    } else if (filter.kind === "verified") {
        label = (
            <>
                {filter.state === "verified" ? "Verified" : "Unverified"} only
            </>
        );
    } else {
        const col = columns.find((c) => c.index === filter.columnIndex);
        const opLabel = TEXT_OPERATOR_LABELS[filter.operator];
        const valueDisplay =
            filter.operator === "is_empty" || filter.operator === "is_not_empty"
                ? ""
                : ` "${filter.value}"`;
        label = (
            <>
                {col?.name ?? `col-${filter.columnIndex}`} {opLabel}
                {valueDisplay}
            </>
        );
    }
    return (
        <span className="inline-flex items-center gap-1 rounded-full border border-border bg-muted px-2.5 py-1 text-xs text-foreground">
            {label}
            <button
                type="button"
                onClick={onRemove}
                className="rounded-full p-0.5 text-muted-foreground/70 transition-colors hover:bg-card hover:text-foreground"
                aria-label="Remove filter"
            >
                <X className="h-3 w-3" />
            </button>
        </span>
    );
}

function AddFilterPopover({
    columns,
    existing,
    onAdd,
    onClose,
}: {
    columns: ColumnConfig[];
    existing: TRFilter[];
    onAdd: (f: TRFilter) => void;
    onClose: () => void;
}) {
    type Kind = "flag" | "verified" | "text";
    const [kind, setKind] = useState<Kind>("flag");

    // flag: multi-select
    const [flagSet, setFlagSet] = useState<Set<FlagValue>>(() => {
        const existingFlag = existing.find((f) => f.kind === "flag");
        return existingFlag ? new Set(existingFlag.flags) : new Set();
    });

    // verified
    const [verifiedState, setVerifiedState] = useState<
        "verified" | "unverified"
    >("verified");

    // text
    const [textColumn, setTextColumn] = useState<number | null>(
        columns[0]?.index ?? null,
    );
    const [textOperator, setTextOperator] = useState<TextOperator>("contains");
    const [textValue, setTextValue] = useState("");

    function commit() {
        if (kind === "flag") {
            if (flagSet.size === 0) return;
            onAdd({ kind: "flag", flags: [...flagSet] });
        } else if (kind === "verified") {
            onAdd({ kind: "verified", state: verifiedState });
        } else {
            if (textColumn === null) return;
            const valueRequired =
                textOperator !== "is_empty" &&
                textOperator !== "is_not_empty";
            if (valueRequired && textValue.trim().length === 0) return;
            onAdd({
                kind: "text",
                columnIndex: textColumn,
                operator: textOperator,
                value: textValue,
            });
        }
    }

    return (
        <div className="absolute left-0 top-full z-30 mt-1.5 w-80 rounded-xl border border-border bg-card p-3 shadow-lg">
            <div className="flex items-center justify-between mb-3">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Add filter
                </span>
                <button
                    type="button"
                    onClick={onClose}
                    className="rounded p-0.5 text-muted-foreground/70 transition-colors hover:bg-muted hover:text-foreground"
                >
                    <X className="h-3.5 w-3.5" />
                </button>
            </div>

            {/* Kind selector */}
            <div className="grid grid-cols-3 gap-1 rounded-md border border-border p-0.5 bg-muted">
                {(["flag", "verified", "text"] as const).map((k) => (
                    <button
                        key={k}
                        type="button"
                        onClick={() => setKind(k)}
                        className={`rounded px-2 py-1 text-xs capitalize transition-colors ${
                            kind === k
                                ? "bg-card text-foreground shadow-sm"
                                : "text-muted-foreground hover:text-foreground"
                        }`}
                    >
                        {k === "text" ? "Column value" : k}
                    </button>
                ))}
            </div>

            <div className="mt-3 space-y-2">
                {kind === "flag" && (
                    <div className="space-y-1.5">
                        {FLAGS.map((f) => (
                            <label
                                key={f}
                                className="flex items-center gap-2 cursor-pointer"
                            >
                                <input
                                    type="checkbox"
                                    checked={flagSet.has(f)}
                                    onChange={(e) => {
                                        const next = new Set(flagSet);
                                        if (e.target.checked) next.add(f);
                                        else next.delete(f);
                                        setFlagSet(next);
                                    }}
                                    className="h-3 w-3 rounded border-border accent-foreground"
                                />
                                <span
                                    className={`h-2 w-2 rounded-full ${FLAG_DOT[f]}`}
                                />
                                <span className="text-sm text-foreground">
                                    {FLAG_LABELS[f]}
                                </span>
                            </label>
                        ))}
                    </div>
                )}

                {kind === "verified" && (
                    <div className="space-y-1.5">
                        {(["verified", "unverified"] as const).map((s) => (
                            <label
                                key={s}
                                className="flex items-center gap-2 cursor-pointer"
                            >
                                <input
                                    type="radio"
                                    name="verified-state"
                                    checked={verifiedState === s}
                                    onChange={() => setVerifiedState(s)}
                                    className="h-3 w-3 accent-foreground"
                                />
                                <span className="text-sm text-foreground capitalize">
                                    {s}
                                </span>
                            </label>
                        ))}
                    </div>
                )}

                {kind === "text" && (
                    <>
                        <select
                            value={textColumn ?? ""}
                            onChange={(e) =>
                                setTextColumn(Number(e.target.value))
                            }
                            className="w-full rounded-md border border-border bg-card px-2 py-1 text-xs text-foreground focus:border-input focus:outline-none"
                        >
                            {columns.map((c) => (
                                <option key={c.index} value={c.index}>
                                    {c.name}
                                </option>
                            ))}
                        </select>
                        <select
                            value={textOperator}
                            onChange={(e) =>
                                setTextOperator(e.target.value as TextOperator)
                            }
                            className="w-full rounded-md border border-border bg-card px-2 py-1 text-xs text-foreground focus:border-input focus:outline-none"
                        >
                            {TEXT_OPERATORS.map((op) => (
                                <option key={op} value={op}>
                                    {TEXT_OPERATOR_LABELS[op]}
                                </option>
                            ))}
                        </select>
                        {textOperator !== "is_empty" &&
                            textOperator !== "is_not_empty" && (
                                <input
                                    type="text"
                                    value={textValue}
                                    onChange={(e) =>
                                        setTextValue(e.target.value)
                                    }
                                    placeholder="value"
                                    className="w-full rounded-md border border-border bg-card px-2 py-1 text-xs text-foreground placeholder:text-muted-foreground/60 focus:border-input focus:outline-none"
                                    autoFocus
                                />
                            )}
                    </>
                )}
            </div>

            <div className="mt-4 flex justify-end gap-2">
                <button
                    type="button"
                    onClick={onClose}
                    className="rounded-md border border-border bg-card px-2 py-1 text-xs text-foreground transition-colors hover:bg-muted"
                >
                    Cancel
                </button>
                <button
                    type="button"
                    onClick={commit}
                    className="rounded-md bg-foreground px-2 py-1 text-xs font-medium text-primary-foreground transition-colors hover:opacity-90"
                >
                    Add filter
                </button>
            </div>

            {/* Avoid an unused-icon warning while keeping the chevron available
                for future select-style triggers. */}
            <ChevronDown className="hidden h-3 w-3" />
        </div>
    );
}
