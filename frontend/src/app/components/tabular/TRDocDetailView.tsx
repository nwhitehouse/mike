"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
    ArrowLeft,
    ChevronLeft,
    ChevronRight,
    Pencil,
    Search,
    X,
} from "lucide-react";
import type { ColumnConfig, MikeDocument, TabularCell } from "../shared/types";
import { preprocessCitations } from "./citation-utils";
import { DocView } from "../shared/DocView";
import { DocxView } from "../shared/DocxView";
import { MarkdownContent } from "./TRSidePanel";
import { updateTabularCell } from "@/app/lib/mikeApi";

function isDocxDocument(d: {
    file_type?: string | null;
    filename?: string;
}): boolean {
    const ft = (d.file_type ?? "").toLowerCase();
    if (ft === "docx" || ft === "doc") return true;
    const ext = d.filename?.split(".").pop()?.toLowerCase();
    return ext === "docx" || ext === "doc";
}

function escapeForHtml(s: string): string {
    return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

interface Props {
    reviewId: string;
    documentId: string;
    documents: MikeDocument[];
    columns: ColumnConfig[];
    cells: TabularCell[];
    initialColumnIndex?: number;
    onBack: () => void;
    onChangeDocument: (docId: string) => void;
    onCellUpdated: (cell: TabularCell) => void;
}

export function TRDocDetailView({
    reviewId,
    documentId,
    documents,
    columns,
    cells,
    initialColumnIndex,
    onBack,
    onChangeDocument,
    onCellUpdated,
}: Props) {
    const doc = documents.find((d) => d.id === documentId);
    const sortedColumns = useMemo(
        () => [...columns].sort((a, b) => a.index - b.index),
        [columns],
    );
    const [selectedColIdx, setSelectedColIdx] = useState<number | null>(
        initialColumnIndex ?? sortedColumns[0]?.index ?? null,
    );

    const selectedColumn = sortedColumns.find(
        (c) => c.index === selectedColIdx,
    );
    const selectedCell = cells.find(
        (c) =>
            c.document_id === documentId && c.column_index === selectedColIdx,
    );

    // Edit state
    const [editing, setEditing] = useState(false);
    const [draftSummary, setDraftSummary] = useState("");
    const [draftReasoning, setDraftReasoning] = useState("");
    const [saving, setSaving] = useState(false);

    // Citation state
    const summary = selectedCell?.content?.summary ?? "";
    const reasoning = selectedCell?.content?.reasoning ?? "";
    const { processed: summaryText, citations: summaryCitations } =
        preprocessCitations(summary);
    const { processed: reasoningText, citations: reasoningCitations } =
        preprocessCitations(reasoning);
    const allCitations = useMemo(
        () => [...summaryCitations, ...reasoningCitations],
        [summaryCitations, reasoningCitations],
    );
    const [activeCitationIdx, setActiveCitationIdx] = useState(0);
    const activeCitation = allCitations[activeCitationIdx];

    // Search state
    const [searchTerm, setSearchTerm] = useState("");
    const [matchCount, setMatchCount] = useState(0);
    const [matchIdx, setMatchIdx] = useState(0);
    const docPaneRef = useRef<HTMLDivElement>(null);

    // Reset edit + citation index when switching column or doc
    useEffect(() => {
        setEditing(false);
        setActiveCitationIdx(0);
    }, [selectedColIdx, documentId]);

    // Multi-match search highlighter. DocView's built-in highlightQuote
    // only finds the first occurrence per quote (right for citations,
    // wrong for search). When a search term is set we suppress the
    // citation prop on DocView (so it clears its own highlights) and
    // walk every text-layer span ourselves, wrapping every occurrence
    // in <mark.finch-search-match>. Cleanup restores div.textContent
    // from data-finch-search-orig when the search is cleared.
    const trimmedSearchForEffect = searchTerm.trim();
    useEffect(() => {
        const root = docPaneRef.current;
        if (!root) return;

        function clearAllSearchMarks(rootEl: HTMLElement) {
            const wrapped = rootEl.querySelectorAll<HTMLElement>(
                "[data-finch-search-orig]",
            );
            wrapped.forEach((div) => {
                const orig = div.getAttribute("data-finch-search-orig");
                if (orig != null) {
                    div.textContent = orig;
                    div.removeAttribute("data-finch-search-orig");
                }
            });
        }

        if (!trimmedSearchForEffect) {
            clearAllSearchMarks(root);
            setMatchCount(0);
            setMatchIdx(0);
            return;
        }

        let cancelled = false;
        const needle = trimmedSearchForEffect.toLowerCase();
        const needleLen = trimmedSearchForEffect.length;

        function applyMarks(rootEl: HTMLElement): number {
            clearAllSearchMarks(rootEl);
            const spans = rootEl.querySelectorAll<HTMLElement>(
                ".pdf-text-layer span",
            );
            if (spans.length === 0) return 0;
            let count = 0;
            spans.forEach((div) => {
                if (div.children.length > 0) return; // skip wrappers
                const orig = div.textContent ?? "";
                if (!orig) return;
                const haystack = orig.toLowerCase();
                let idx = haystack.indexOf(needle);
                if (idx === -1) return;
                div.setAttribute("data-finch-search-orig", orig);
                let html = "";
                let pos = 0;
                while (idx !== -1) {
                    html += escapeForHtml(orig.slice(pos, idx));
                    html += `<mark class="finch-search-match" style="background:rgba(251,191,36,0.4);color:inherit;padding:0;border-radius:2px;">${escapeForHtml(
                        orig.slice(idx, idx + needleLen),
                    )}</mark>`;
                    pos = idx + needleLen;
                    count++;
                    idx = haystack.indexOf(needle, pos);
                }
                html += escapeForHtml(orig.slice(pos));
                div.innerHTML = html;
            });
            return count;
        }

        // Poll a few times — text layers render asynchronously per page
        // and we want to catch the count as more pages come in.
        const tries = [50, 200, 500, 1200];
        const timers = tries.map((ms) =>
            setTimeout(() => {
                if (cancelled) return;
                const c = applyMarks(root);
                setMatchCount(c);
                setMatchIdx(0);
            }, ms),
        );

        return () => {
            cancelled = true;
            timers.forEach(clearTimeout);
        };
    }, [trimmedSearchForEffect]);

    function scrollToMatch(idx: number) {
        const root = docPaneRef.current;
        if (!root) return;
        const matches = root.querySelectorAll<HTMLElement>(
            "mark.finch-search-match",
        );
        if (matches.length === 0) return;
        matches.forEach((m) => {
            m.style.background = "rgba(251,191,36,0.4)"; // amber, transparent
        });
        const target = matches[idx];
        if (!target) return;
        target.style.background = "rgba(251,146,60,0.6)"; // orange, current
        let scroller: HTMLElement | null = target.parentElement;
        while (scroller) {
            const style = getComputedStyle(scroller);
            if (
                /(auto|scroll)/.test(style.overflowY) &&
                scroller.scrollHeight > scroller.clientHeight
            )
                break;
            scroller = scroller.parentElement;
        }
        if (!scroller) {
            target.scrollIntoView({ behavior: "smooth", block: "center" });
            return;
        }
        const scrollerRect = scroller.getBoundingClientRect();
        const targetRect = target.getBoundingClientRect();
        const top =
            scroller.scrollTop +
            (targetRect.top - scrollerRect.top) -
            scroller.clientHeight / 2 +
            targetRect.height / 2;
        scroller.scrollTo({
            top: Math.max(0, top),
            behavior: "smooth",
        });
    }

    function handlePrevMatch() {
        if (matchCount === 0) return;
        const next = (matchIdx - 1 + matchCount) % matchCount;
        setMatchIdx(next);
        scrollToMatch(next);
    }

    function handleNextMatch() {
        if (matchCount === 0) return;
        const next = (matchIdx + 1) % matchCount;
        setMatchIdx(next);
        scrollToMatch(next);
    }

    if (!doc) {
        return (
            <div className="flex h-full items-center justify-center bg-white">
                <div className="text-sm text-gray-500">
                    Document not found.
                </div>
            </div>
        );
    }

    const colPos =
        selectedColIdx !== null
            ? sortedColumns.findIndex((c) => c.index === selectedColIdx)
            : -1;

    const selectColumn = (index: number) => {
        setSelectedColIdx(index);
    };

    function startEditing() {
        setDraftSummary(selectedCell?.content?.summary ?? "");
        setDraftReasoning(selectedCell?.content?.reasoning ?? "");
        setEditing(true);
    }

    function handleCancel() {
        setEditing(false);
    }

    async function handleSave() {
        if (!selectedColumn || !selectedCell) return;
        setSaving(true);
        try {
            const result = await updateTabularCell(
                reviewId,
                documentId,
                selectedColumn.index,
                {
                    summary: draftSummary,
                    reasoning: draftReasoning,
                    flag: selectedCell.content?.flag ?? "grey",
                },
            );
            onCellUpdated({
                ...selectedCell,
                content: result.content,
                status: "done",
            });
            setEditing(false);
        } catch (err) {
            console.error("[TRDocDetail] save failed", err);
            window.alert("Failed to save cell. Please try again.");
        } finally {
            setSaving(false);
        }
    }

    // What to highlight in the doc — search term overrides the active citation
    const trimmedSearch = searchTerm.trim();
    const docQuote = trimmedSearch || activeCitation?.quote;
    const docPage = trimmedSearch ? undefined : activeCitation?.page;

    return (
        <div className="flex h-full w-full flex-col bg-white overflow-hidden">
            {/* Top bar */}
            {(() => {
                const docIdx = documents.findIndex((d) => d.id === documentId);
                const prevDoc =
                    docIdx > 0 ? documents[docIdx - 1] : null;
                const nextDoc =
                    docIdx >= 0 && docIdx < documents.length - 1
                        ? documents[docIdx + 1]
                        : null;
                return (
                    <div className="flex items-center gap-3 px-4 py-2 border-b border-gray-200 shrink-0">
                        <button
                            onClick={onBack}
                            className="flex items-center gap-1.5 text-sm text-gray-600 hover:text-gray-900 px-2 py-1 rounded hover:bg-gray-100"
                        >
                            <ArrowLeft className="h-4 w-4" />
                            Back
                        </button>
                        <span
                            className="text-sm font-medium text-gray-800 truncate"
                            title={doc.filename}
                        >
                            {doc.filename}
                        </span>
                        <div className="ml-auto flex items-center gap-1 text-xs text-gray-500 shrink-0">
                            <button
                                onClick={() =>
                                    prevDoc && onChangeDocument(prevDoc.id)
                                }
                                disabled={!prevDoc}
                                title={
                                    prevDoc
                                        ? `Previous: ${prevDoc.filename}`
                                        : "No previous document"
                                }
                                className="p-1 rounded hover:bg-gray-100 disabled:opacity-30 disabled:hover:bg-transparent"
                            >
                                <ChevronLeft className="h-4 w-4" />
                            </button>
                            <span className="tabular-nums">
                                {docIdx >= 0 ? docIdx + 1 : "—"}/
                                {documents.length}
                            </span>
                            <button
                                onClick={() =>
                                    nextDoc && onChangeDocument(nextDoc.id)
                                }
                                disabled={!nextDoc}
                                title={
                                    nextDoc
                                        ? `Next: ${nextDoc.filename}`
                                        : "No next document"
                                }
                                className="p-1 rounded hover:bg-gray-100 disabled:opacity-30 disabled:hover:bg-transparent"
                            >
                                <ChevronRight className="h-4 w-4" />
                            </button>
                        </div>
                    </div>
                );
            })()}

            {/* 3-pane body */}
            <div className="flex-1 flex overflow-hidden min-h-0">
                {/* Pane 1 — Columns (25%) */}
                <div className="w-1/4 shrink-0 border-r border-gray-200 flex flex-col min-w-0">
                    <div className="flex items-center justify-between px-4 py-2.5 border-b border-gray-200 shrink-0">
                        <span className="text-base font-medium text-gray-900">
                            Columns
                        </span>
                        {sortedColumns.length > 0 && colPos >= 0 && (
                            <span className="text-xs text-gray-400">
                                {colPos + 1}/{sortedColumns.length}
                            </span>
                        )}
                    </div>
                    <div className="flex-1 overflow-auto">
                        {sortedColumns.map((col) => {
                            const isSel = col.index === selectedColIdx;
                            return (
                                <button
                                    key={col.index}
                                    onClick={() => selectColumn(col.index)}
                                    className={`w-full text-left px-4 py-2.5 text-sm border-b border-gray-100 truncate ${
                                        isSel
                                            ? "bg-gray-100 text-gray-900 font-medium"
                                            : "text-gray-700 hover:bg-gray-50"
                                    }`}
                                    title={col.name}
                                >
                                    {col.name}
                                </button>
                            );
                        })}
                    </div>
                </div>

                {/* Pane 2 — Cell value (25%) */}
                <div className="w-1/4 shrink-0 border-r border-gray-200 flex flex-col overflow-hidden min-w-0">
                    <div className="flex items-center justify-between px-4 py-2.5 border-b border-gray-200 shrink-0 gap-2">
                        <span
                            className="text-base font-medium text-gray-900 truncate"
                            title={selectedColumn?.name}
                        >
                            {selectedColumn?.name ?? "—"}
                        </span>
                        {!editing && selectedCell?.content && (
                            <button
                                onClick={startEditing}
                                className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700 shrink-0"
                                title="Edit cell"
                            >
                                <Pencil className="h-3 w-3" />
                                Edit
                            </button>
                        )}
                        {editing && (
                            <span className="text-xs text-gray-400 italic shrink-0">
                                Editing…
                            </span>
                        )}
                    </div>
                    <div className="flex-1 overflow-auto px-4 py-4 space-y-4">
                        {/* Cell value */}
                        <div>
                            <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider mb-1.5">
                                Cell Value
                            </p>
                            {editing ? (
                                <textarea
                                    value={draftSummary}
                                    onChange={(e) =>
                                        setDraftSummary(e.target.value)
                                    }
                                    rows={4}
                                    className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm leading-relaxed text-gray-800 focus:border-gray-400 focus:outline-none resize-y"
                                />
                            ) : (
                                <div className="rounded-md border border-gray-200 bg-gray-50 px-3 py-2.5 text-sm text-gray-800 leading-relaxed">
                                    {selectedColumn ? (
                                        <MarkdownContent
                                            citations={summaryCitations}
                                            onCitationClick={(c) => {
                                                const idx =
                                                    summaryCitations.findIndex(
                                                        (sc) =>
                                                            sc.page === c.page &&
                                                            sc.quote === c.quote,
                                                    );
                                                if (idx >= 0)
                                                    setActiveCitationIdx(idx);
                                            }}
                                            column={selectedColumn}
                                        >
                                            {summaryText || "—"}
                                        </MarkdownContent>
                                    ) : (
                                        "—"
                                    )}
                                </div>
                            )}
                        </div>

                        {/* Explanation */}
                        {(reasoning || editing) && selectedColumn && (
                            <div>
                                <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider mb-1.5">
                                    Explanation
                                </p>
                                {editing ? (
                                    <textarea
                                        value={draftReasoning}
                                        onChange={(e) =>
                                            setDraftReasoning(e.target.value)
                                        }
                                        rows={5}
                                        className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm leading-relaxed text-gray-700 focus:border-gray-400 focus:outline-none resize-y"
                                    />
                                ) : (
                                    <div className="rounded-md border border-gray-200 bg-gray-50 px-3 py-2.5 text-sm text-gray-700 leading-relaxed">
                                        <MarkdownContent
                                            citations={reasoningCitations}
                                            onCitationClick={(c) => {
                                                const idx =
                                                    reasoningCitations.findIndex(
                                                        (rc) =>
                                                            rc.page === c.page &&
                                                            rc.quote === c.quote,
                                                    );
                                                if (idx >= 0)
                                                    setActiveCitationIdx(
                                                        summaryCitations.length +
                                                            idx,
                                                    );
                                            }}
                                            citationOffset={
                                                summaryCitations.length
                                            }
                                            column={selectedColumn}
                                            inline
                                        >
                                            {reasoningText}
                                        </MarkdownContent>
                                    </div>
                                )}
                            </div>
                        )}

                        {/* Save / Cancel — only when editing */}
                        {editing && (
                            <div className="flex items-center gap-2 pt-1">
                                <button
                                    onClick={handleCancel}
                                    disabled={saving}
                                    className="flex-1 px-3 py-2 rounded-md border border-gray-300 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                                >
                                    Cancel
                                </button>
                                <button
                                    onClick={handleSave}
                                    disabled={saving}
                                    className="flex-1 px-3 py-2 rounded-md bg-indigo-600 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
                                >
                                    {saving ? "Saving…" : "Save"}
                                </button>
                            </div>
                        )}
                    </div>
                </div>

                {/* Pane 3 — Document preview (50%) */}
                <div className="w-1/2 flex flex-col overflow-hidden min-w-0">
                    <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-200 shrink-0">
                        {/* Search */}
                        <div className="relative w-64 shrink-0">
                            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-400 pointer-events-none" />
                            <input
                                type="text"
                                value={searchTerm}
                                onChange={(e) => setSearchTerm(e.target.value)}
                                placeholder="Search in document"
                                className="w-full pl-7 pr-7 py-1 text-xs rounded-md border border-gray-200 focus:border-gray-400 focus:outline-none"
                            />
                            {searchTerm && (
                                <button
                                    type="button"
                                    onClick={() => setSearchTerm("")}
                                    className="absolute right-1.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                                >
                                    <X className="h-3 w-3" />
                                </button>
                            )}
                        </div>

                        {trimmedSearch ? (
                            <div className="flex items-center gap-1 ml-2 text-xs text-gray-500 shrink-0">
                                <span className="mr-1">
                                    {matchCount === 0
                                        ? "No matches"
                                        : `${matchIdx + 1} of ${matchCount}`}
                                </span>
                                <button
                                    onClick={handlePrevMatch}
                                    disabled={matchCount === 0}
                                    title="Previous match"
                                    className="p-1 rounded hover:bg-gray-100 disabled:opacity-30 disabled:hover:bg-transparent"
                                >
                                    <ChevronLeft className="h-3.5 w-3.5" />
                                </button>
                                <button
                                    onClick={handleNextMatch}
                                    disabled={matchCount === 0}
                                    title="Next match"
                                    className="p-1 rounded hover:bg-gray-100 disabled:opacity-30 disabled:hover:bg-transparent"
                                >
                                    <ChevronRight className="h-3.5 w-3.5" />
                                </button>
                            </div>
                        ) : (
                            <>
                                <span className="text-xs text-gray-500 ml-2 truncate">
                                    {allCitations.length > 0
                                        ? `From ${allCitations.length} relevant reference${allCitations.length === 1 ? "" : "s"}`
                                        : "No references"}
                                </span>
                                {allCitations.length > 1 && (
                                    <div className="flex items-center gap-1 ml-auto text-xs text-gray-500 shrink-0">
                                        <button
                                            onClick={() =>
                                                setActiveCitationIdx((i) =>
                                                    Math.max(0, i - 1),
                                                )
                                            }
                                            disabled={activeCitationIdx === 0}
                                            className="p-1 rounded hover:bg-gray-100 disabled:opacity-30 disabled:hover:bg-transparent"
                                        >
                                            <ChevronLeft className="h-3.5 w-3.5" />
                                        </button>
                                        <span>
                                            {activeCitationIdx + 1}/
                                            {allCitations.length}
                                        </span>
                                        <button
                                            onClick={() =>
                                                setActiveCitationIdx((i) =>
                                                    Math.min(
                                                        allCitations.length - 1,
                                                        i + 1,
                                                    ),
                                                )
                                            }
                                            disabled={
                                                activeCitationIdx ===
                                                allCitations.length - 1
                                            }
                                            className="p-1 rounded hover:bg-gray-100 disabled:opacity-30 disabled:hover:bg-transparent"
                                        >
                                            <ChevronRight className="h-3.5 w-3.5" />
                                        </button>
                                    </div>
                                )}
                            </>
                        )}
                    </div>
                    {/* Doc viewer must be a flex container so DocView's
                        flex-1 overflow-auto scroll region resolves a real
                        height — without `flex` here the inner scroll region
                        collapses and nothing scrolls (mouse wheel, keyboard,
                        or programmatic jumps to citations all dead). The
                        ref is used by the search next/prev buttons to
                        query and scroll to .pdf-text-highlight nodes. */}
                    <div
                        ref={docPaneRef}
                        className="flex-1 flex flex-col overflow-hidden min-h-0"
                    >
                        {isDocxDocument(doc) && !doc.pdf_storage_path ? (
                            <DocxView
                                documentId={doc.id}
                                quotes={
                                    docQuote
                                        ? [
                                              {
                                                  page: docPage ?? 1,
                                                  quote: docQuote,
                                              },
                                          ]
                                        : []
                                }
                            />
                        ) : (
                            <DocView
                                doc={{ document_id: doc.id }}
                                quote={docQuote}
                                fallbackPage={docPage}
                                rounded={false}
                                bordered={false}
                            />
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}
