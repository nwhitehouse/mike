"use client";

import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { AlertCircle, Check, Expand } from "lucide-react";
import type { ColumnConfig, TabularCell as TCell } from "../shared/types";
import { preprocessCitations, type ParsedCitation } from "./citation-utils";
import { getPillClass } from "./pillUtils";
import { safeExternalHref, safeMarkdownUrl } from "@/lib/safeMarkdown";

interface Props {
    cell: TCell;
    column?: ColumnConfig;
    onExpand: () => void;
    onCitationClick?: (page: number, quote: string) => void;
    /** When true, cells expand vertically and content wraps instead of being
     *  truncated to a single line. */
    wrapText?: boolean;
    /** feat-023 — toggle the cell's verified state. Optional; when undefined
     *  the verify check is rendered read-only (or hidden). */
    onToggleVerify?: (cell: TCell, next: boolean) => void;
}

const FLAG_STYLES = {
    green: "bg-green-500",
    grey: "bg-muted-foreground/60",
    yellow: "bg-amber-400",
    red: "bg-red-500",
} as const;

// Replace citations and pills with inline-code tokens so ReactMarkdown passes
// them through its `code` component, where we render the final UI.
function preprocessCellMarkdown(text: string): {
    processed: string;
    citations: ParsedCitation[];
    pills: string[];
} {
    const { processed: withCits, citations } = preprocessCitations(text);
    const pills: string[] = [];
    let out = withCits.replace(/\[\[([^\]]+)\]\]/g, (_, content) => {
        const idx = pills.length;
        pills.push(content);
        return `\`§p${idx}§\`\u200B`;
    });
    out = out.replace(/§(\d+)§/g, (_, idx) => `\`§c${idx}§\`\u200B`);
    return { processed: out, citations, pills };
}

function CellMarkdown({
    text,
    citations,
    pills,
    column,
    onCitationClick,
    onExpand,
    inline,
}: {
    text: string;
    citations: ParsedCitation[];
    pills: string[];
    column?: ColumnConfig;
    onCitationClick?: (page: number, quote: string) => void;
    onExpand: () => void;
    inline?: boolean;
}) {
    return (
        <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            urlTransform={safeMarkdownUrl}
            components={{
                p: ({ node, ...props }) =>
                    inline ? (
                        <span {...props} />
                    ) : (
                        <p className="mb-1 last:mb-0 leading-relaxed" {...props} />
                    ),
                ul: ({ node, ...props }) => (
                    <ul className="list-disc pl-4 space-y-0.5" {...props} />
                ),
                ol: ({ node, ...props }) => (
                    <ol className="list-decimal pl-4 space-y-0.5" {...props} />
                ),
                li: ({ node, ...props }) => <li {...props} />,
                strong: ({ node, ...props }) => (
                    <strong className="font-semibold" {...props} />
                ),
                em: ({ node, ...props }) => <em className="italic" {...props} />,
                a: ({ node, href, children, ...props }) => {
                    const safeHref = safeExternalHref(href);
                    if (!safeHref) return <span>{children}</span>;
                    return (
                        <a
                            href={safeHref}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-blue-600 hover:text-blue-700 underline"
                            {...props}
                        >
                            {children}
                        </a>
                    );
                },
                code: ({ node, children, ...props }) => {
                    const t = String(children);
                    const citMatch = t.match(/^§c(\d+)§$/);
                    if (citMatch) {
                        const idx = parseInt(citMatch[1]);
                        const citation = citations[idx];
                        if (citation) {
                            return (
                                <span
                                    title={`Page ${citation.page}: "${citation.quote}"`}
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        if (onCitationClick) {
                                            onCitationClick(
                                                citation.page,
                                                citation.quote,
                                            );
                                        } else {
                                            onExpand();
                                        }
                                    }}
                                    className="mx-0.5 inline-flex items-center justify-center rounded-full bg-secondary w-3.5 h-3.5 text-[9px] font-medium text-foreground align-super cursor-pointer hover:bg-muted-foreground/30 transition-colors"
                                >
                                    {idx + 1}
                                </span>
                            );
                        }
                    }
                    const pillMatch = t.match(/^§p(\d+)§$/);
                    if (pillMatch) {
                        const content = pills[parseInt(pillMatch[1])];
                        if (content !== undefined) {
                            return (
                                <span
                                    className={`inline-block rounded-full px-1.5 py-0.5 text-[10px] font-medium leading-none ${getPillClass(content, column)}`}
                                >
                                    {content}
                                </span>
                            );
                        }
                    }
                    return (
                        <code
                            className="bg-muted px-1 py-0.5 rounded text-[11px] font-mono"
                            {...props}
                        >
                            {children}
                        </code>
                    );
                },
            }}
        >
            {text}
        </ReactMarkdown>
    );
}

export function TabularCell({
    cell,
    column,
    onExpand,
    onCitationClick,
    wrapText = false,
    onToggleVerify,
}: Props) {
    const [inlineExpanded, setInlineExpanded] = useState(false);
    const containerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!inlineExpanded) return;
        function handleClickOutside(e: MouseEvent) {
            if (
                containerRef.current &&
                !containerRef.current.contains(e.target as Node)
            ) {
                setInlineExpanded(false);
            }
        }
        document.addEventListener("mousedown", handleClickOutside);
        return () =>
            document.removeEventListener("mousedown", handleClickOutside);
    }, [inlineExpanded]);

    if (cell.status === "generating") {
        return (
            <div className="h-10 px-2 flex items-center">
                <div className="h-4 w-full rounded bg-muted animate-pulse" />
            </div>
        );
    }

    if (cell.status === "error") {
        return (
            <div className="h-10 flex items-center justify-center text-muted-foreground/50">
                <AlertCircle className="h-4 w-4 text-red-300" />
            </div>
        );
    }

    if (!cell.content?.summary) {
        return <div className="h-10" />;
    }

    const { processed, citations, pills } = preprocessCellMarkdown(
        cell.content.summary,
    );

    const firstLine = processed.split("\n").find((l) => l.trim()) ?? processed;
    const collapsedDisplay = firstLine.replace(/^[-*•]\s+/, "");

    function handleCitationClickInOverlay(page: number, quote: string) {
        setInlineExpanded(false);
        onCitationClick?.(page, quote);
    }

    function handleSeeDetails() {
        setInlineExpanded(false);
        onExpand();
    }

    return (
        <div ref={containerRef} className="relative">
            {/* Normal cell row — always visible, preserves table layout */}
            <div
                className={`group relative px-2 ${wrapText ? "py-2 min-h-10" : "h-10 flex items-center"} text-xs text-foreground leading-relaxed cursor-pointer hover:bg-muted transition-colors`}
                onClick={() => setInlineExpanded((v) => !v)}
            >
                {cell.content.flag && (
                    <span
                        className={`absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full ${FLAG_STYLES[cell.content.flag]}`}
                        title={cell.content.flag}
                    />
                )}
                {/* feat-023 — verify toggle. Always visible when verified
                    (subtle green check); fades in on hover when not. */}
                {onToggleVerify && cell.status === "done" && (
                    <button
                        type="button"
                        onClick={(e) => {
                            e.stopPropagation();
                            onToggleVerify(cell, !cell.verified);
                        }}
                        title={
                            cell.verified
                                ? "Verified — click to unverify"
                                : "Mark as verified"
                        }
                        className={`absolute left-1 top-1.5 rounded-full p-0.5 transition-opacity ${
                            cell.verified
                                ? "text-emerald-500 opacity-100"
                                : "text-muted-foreground/60 opacity-0 group-hover:opacity-100 hover:text-foreground"
                        }`}
                    >
                        <Check className="h-3 w-3" />
                    </button>
                )}
                <div
                    className={`w-full min-w-0 ${wrapText ? "whitespace-pre-wrap break-words" : "line-clamp-1"} ${onToggleVerify ? "pl-4" : ""}`}
                >
                    <CellMarkdown
                        text={collapsedDisplay}
                        citations={citations}
                        pills={pills}
                        column={column}
                        onCitationClick={onCitationClick}
                        onExpand={onExpand}
                        inline
                    />
                </div>
            </div>

            {/* Inline expanded overlay — absolutely positioned so it overlays without disrupting table layout */}
            {inlineExpanded && (
                <div className="absolute left-0 top-0 z-50 w-full bg-card border border-border shadow-lg rounded-sm">
                    <div className="relative p-2 pr-4 text-xs text-foreground leading-relaxed">
                        {cell.content.flag && (
                            <span
                                className={`absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full ${FLAG_STYLES[cell.content.flag]}`}
                                title={cell.content.flag}
                            />
                        )}
                        <CellMarkdown
                            text={processed}
                            citations={citations}
                            pills={pills}
                            column={column}
                            onCitationClick={handleCitationClickInOverlay}
                            onExpand={handleSeeDetails}
                        />
                    </div>
                    <div className="px-2 py-1.5 flex items-center justify-end">
                        <button
                            onClick={handleSeeDetails}
                            className="flex items-center gap-1 text-xs text-muted-foreground/70 hover:text-foreground transition-colors"
                        >
                            <Expand className="h-3 w-3" />
                            See details
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}
