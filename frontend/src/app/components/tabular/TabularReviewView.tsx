"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
    Plus,
    Loader2,
    Play,
    ChevronDown,
    MessageSquare,
    Download,
    Users,
    WrapText,
} from "lucide-react";
import { HeaderSearchBtn } from "../shared/HeaderSearchBtn";

import {
    cancelTabularJob,
    clearTabularCells,
    deleteTabularColumn,
    getActiveTabularJob,
    getProject,
    getTabularJob,
    getTabularJobCells,
    getTabularReview,
    getTabularReviewPeople,
    regenerateTabularCell,
    reprocessTabularColumn,
    startTabularGenerate,
    updateTabularReview,
    type TabularJobStatus,
} from "@/app/lib/mikeApi";
import type {
    ColumnConfig,
    MikeDocument,
    MikeProject,
    TabularCell,
    TabularReview,
} from "../shared/types";
import { AddColumnModal } from "./AddColumnModal";
import { AddDocumentsModal } from "../shared/AddDocumentsModal";
import { AddProjectDocsModal } from "../shared/AddProjectDocsModal";
import { PeopleModal } from "../shared/PeopleModal";
import { OwnerOnlyModal } from "../shared/OwnerOnlyModal";
import { ApiKeyMissingModal } from "../shared/ApiKeyMissingModal";
import { RenameableTitle } from "../shared/RenameableTitle";
import { useAuth } from "@/contexts/AuthContext";
import { useUserProfile } from "@/contexts/UserProfileContext";
import {
    getModelProvider,
    isModelAvailable,
    type ModelProvider,
} from "@/app/lib/modelAvailability";
import { TRSidePanel } from "./TRSidePanel";
import { TRTable } from "./TRTable";
import type { TRTableHandle } from "./TRTable";
import { TRChatPanel } from "./TRChatPanel";
import { TRDocDetailView } from "./TRDocDetailView";
import { exportTabularReviewToExcel } from "./exportToExcel";
import { useSidebar } from "@/app/contexts/SidebarContext";

interface Props {
    reviewId: string;
    projectId?: string;
}

export function TRView({ reviewId, projectId }: Props) {
    const { setSidebarOpen } = useSidebar();
    const [review, setReview] = useState<TabularReview | null>(null);
    const [project, setProject] = useState<MikeProject | null>(null);
    const [cells, setCells] = useState<TabularCell[]>([]);
    const [documents, setDocuments] = useState<MikeDocument[]>([]);
    const [columns, setColumns] = useState<ColumnConfig[]>([]);
    const [loading, setLoading] = useState(true);
    const [generating, setGenerating] = useState(false);
    // bug-007 — durable-job tabular generate: track the in-flight job so
    // the polling loop can keep going across remounts and the progress UI
    // can show "12/200 done" instead of an indeterminate spinner.
    const [jobStatus, setJobStatus] = useState<TabularJobStatus | null>(null);
    const activeJobIdRef = useRef<string | null>(null);
    const pollAbortRef = useRef<{ cancelled: boolean } | null>(null);

    // feat-021 — hidden column indices, persisted per-(review, device) in
    // localStorage. Restored on mount; updated as the user hides/shows.
    const hiddenColumnsKey = `olava.tabular.hiddenColumns.${reviewId}`;
    const [hiddenColumnIndices, setHiddenColumnIndices] = useState<number[]>(
        [],
    );
    useEffect(() => {
        try {
            const raw = window.localStorage.getItem(hiddenColumnsKey);
            if (!raw) return;
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed) && parsed.every((n) => typeof n === "number")) {
                setHiddenColumnIndices(parsed);
            }
        } catch {
            /* malformed — start fresh */
        }
    }, [hiddenColumnsKey]);
    function persistHiddenColumns(next: number[]) {
        setHiddenColumnIndices(next);
        try {
            window.localStorage.setItem(hiddenColumnsKey, JSON.stringify(next));
        } catch {
            /* private browsing etc. — state still updates in memory */
        }
    }
    const visibleColumns = columns.filter(
        (c) => !hiddenColumnIndices.includes(c.index),
    );

    // feat-021 — confirmation modal for column delete (destructive).
    const [columnPendingDelete, setColumnPendingDelete] =
        useState<ColumnConfig | null>(null);
    const [deletingColumn, setDeletingColumn] = useState(false);
    const [savingColumn, setSavingColumn] = useState(false);
    const [savingColumnsConfig, setSavingColumnsConfig] = useState(false);
    const [addColOpen, setAddColOpen] = useState(false);
    const [addDocsOpen, setAddDocsOpen] = useState(false);
    const [peopleModalOpen, setPeopleModalOpen] = useState(false);
    const [ownerOnlyAction, setOwnerOnlyAction] = useState<string | null>(null);
    const { user } = useAuth();
    const [expandedCell, setExpandedCell] = useState<TabularCell | null>(null);
    const [expandedCellCitation, setExpandedCellCitation] = useState<
        { quote: string; page: number } | undefined
    >(undefined);
    const [selectedDocIds, setSelectedDocIds] = useState<string[]>([]);
    const [actionsOpen, setActionsOpen] = useState(false);
    const [search, setSearch] = useState("");
    const searchParams = useSearchParams();
    const initialChatParamRef = useRef<string | null>(
        searchParams.get("chat"),
    );
    const [chatOpen, setChatOpen] = useState(!!initialChatParamRef.current);
    const [selectedChatId, setSelectedChatId] = useState<string | null>(
        initialChatParamRef.current && initialChatParamRef.current !== "new"
            ? initialChatParamRef.current
            : null,
    );
    const [highlightedCell, setHighlightedCell] = useState<{ colIdx: number; rowIdx: number } | null>(null);
    const [docDetailDocId, setDocDetailDocId] = useState<string | null>(null);
    const [wrapText, setWrapText] = useState(false);
    const [apiKeyModalProvider, setApiKeyModalProvider] =
        useState<ModelProvider | null>(null);
    const actionsRef = useRef<HTMLDivElement>(null);
    const tableRef = useRef<TRTableHandle>(null);
    const router = useRouter();
    const { profile } = useUserProfile();
    const apiKeys = {
        claudeApiKey: profile?.claudeApiKey ?? null,
        geminiApiKey: profile?.geminiApiKey ?? null,
        serverKeys: profile?.serverKeys ?? null,
    };
    const tabularModel = profile?.tabularModel ?? "olava-extract";

    useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        if (chatOpen) {
            params.set("chat", selectedChatId ?? "new");
        } else {
            params.delete("chat");
        }
        const query = params.toString();
        const newUrl = `${window.location.pathname}${query ? `?${query}` : ""}`;
        window.history.replaceState(null, "", newUrl);
    }, [chatOpen, selectedChatId]);

    useEffect(() => {
        if (!actionsOpen) return;
        function handleClickOutside(e: MouseEvent) {
            if (
                actionsRef.current &&
                !actionsRef.current.contains(e.target as Node)
            )
                setActionsOpen(false);
        }
        document.addEventListener("mousedown", handleClickOutside);
        return () =>
            document.removeEventListener("mousedown", handleClickOutside);
    }, [actionsOpen]);

    useEffect(() => {
        const fetches: Promise<unknown>[] = [
            getTabularReview(reviewId).then(({ review, cells, documents }) => {
                setReview(review);
                setCells(cells);
                setDocuments(documents);
                setColumns(review.columns_config || []);
            }),
        ];
        if (projectId) {
            fetches.push(
                getProject(projectId)
                    .then(setProject)
                    .catch(() => {}),
            );
        }
        Promise.all(fetches).finally(() => setLoading(false));
    }, [reviewId, projectId]);

    function getNextColumnIndex() {
        return (
            columns.reduce((max, column) => Math.max(max, column.index), -1) + 1
        );
    }

    async function saveColumnsConfig(nextColumns: ColumnConfig[]) {
        setSavingColumnsConfig(true);
        try {
            const updated = await updateTabularReview(reviewId, {
                columns_config: nextColumns,
                document_ids: documents.map((document) => document.id),
            });
            setReview(updated);
            setColumns(updated.columns_config || nextColumns);
        } finally {
            setSavingColumnsConfig(false);
        }
    }

    async function handleAddDocuments(newDocs: MikeDocument[]) {
        const toAdd = newDocs.filter(
            (d) => !documents.some((existing) => existing.id === d.id),
        );
        if (!toAdd.length) return;
        const allIds = [
            ...documents.map((d) => d.id),
            ...toAdd.map((d) => d.id),
        ];

        await updateTabularReview(reviewId, {
            document_ids: allIds,
            columns_config: columns,
        });
        setDocuments((prev) => [...prev, ...toAdd]);
        if (columns.length > 0) {
            setCells((prev) => [
                ...prev,
                ...toAdd.flatMap((doc) =>
                    columns.map((col) => ({
                        id: `new-${doc.id}-${col.index}`,
                        review_id: reviewId,
                        document_id: doc.id,
                        column_index: col.index,
                        content: null,
                        status: "pending" as const,
                        created_at: new Date().toISOString(),
                    })),
                ),
            ]);
        }
    }

    async function handleRegenerateCell(docId: string, colIndex: number) {
        setCells((prev) =>
            prev.map((c) =>
                c.document_id === docId && c.column_index === colIndex
                    ? { ...c, status: "generating" as const, content: null }
                    : c,
            ),
        );
        setExpandedCell((prev) =>
            prev
                ? { ...prev, status: "generating" as const, content: null }
                : null,
        );
        try {
            const result = await regenerateTabularCell(
                reviewId,
                docId,
                colIndex,
            );
            setCells((prev) =>
                prev.map((c) =>
                    c.document_id === docId && c.column_index === colIndex
                        ? { ...c, status: "done" as const, content: result }
                        : c,
                ),
            );
            setExpandedCell((prev) =>
                prev
                    ? { ...prev, status: "done" as const, content: result }
                    : null,
            );
        } catch (err) {
            console.error("Regeneration failed", err);
            setCells((prev) =>
                prev.map((c) =>
                    c.document_id === docId && c.column_index === colIndex
                        ? { ...c, status: "error" as const }
                        : c,
                ),
            );
            setExpandedCell((prev) =>
                prev ? { ...prev, status: "error" as const } : null,
            );
        }
    }

    // bug-007 — poll a single job until it reaches a terminal state.
    // Survives remount because the loop state lives in refs; reentrancy
    // is prevented via activeJobIdRef + pollAbortRef.
    async function pollJob(jobId: string) {
        const myToken = { cancelled: false };
        // Cancel any prior poller (e.g. user remounted while one was running).
        if (pollAbortRef.current) pollAbortRef.current.cancelled = true;
        pollAbortRef.current = myToken;
        activeJobIdRef.current = jobId;

        const intervalMs = Number(
            process.env.NEXT_PUBLIC_TABULAR_POLL_MS ?? "1500",
        );
        let since = "1970-01-01";

        try {
            while (!myToken.cancelled) {
                let snapshot: TabularJobStatus | null = null;
                try {
                    snapshot = await getTabularJob(jobId);
                } catch (err) {
                    console.warn("[tabular-poll] status fetch failed", err);
                }
                if (myToken.cancelled) return;
                if (snapshot) setJobStatus(snapshot);

                // Pick up cells whose items completed since last poll.
                try {
                    const { cells: deltaCells, lastCompletedAt } =
                        await getTabularJobCells(jobId, since);
                    if (deltaCells.length > 0) {
                        setCells((prev) =>
                            prev.map((c) => {
                                const update = deltaCells.find(
                                    (d) =>
                                        d.document_id === c.document_id &&
                                        d.column_index === c.column_index,
                                );
                                if (!update) return c;
                                return {
                                    ...c,
                                    content: update.content,
                                    status: update.status as typeof c.status,
                                };
                            }),
                        );
                    }
                    since = lastCompletedAt;
                } catch (err) {
                    console.warn("[tabular-poll] cells fetch failed", err);
                }

                if (
                    snapshot &&
                    (snapshot.status === "completed" ||
                        snapshot.status === "cancelled" ||
                        snapshot.status === "failed")
                ) {
                    break;
                }

                await new Promise((r) => setTimeout(r, intervalMs));
            }
        } finally {
            if (activeJobIdRef.current === jobId) {
                activeJobIdRef.current = null;
                setGenerating(false);
            }
        }
    }

    // On mount: detect an in-flight job (started in another tab, or
    // before a backend restart, or before this user reloaded) and resume
    // polling. Doesn't kick off a new generate run on its own.
    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const { job } = await getActiveTabularJob(reviewId);
                if (cancelled || !job) return;
                setGenerating(true);
                void pollJob(job.id);
            } catch (err) {
                console.warn(
                    "[tabular-poll] active-job lookup failed",
                    err,
                );
            }
        })();
        return () => {
            cancelled = true;
            if (pollAbortRef.current) {
                pollAbortRef.current.cancelled = true;
                pollAbortRef.current = null;
            }
        };
        // Intentional: only run on reviewId change. pollJob's identity is
        // stable enough for this resume-on-mount check.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [reviewId]);

    async function handleGenerate() {
        if (!review || generating) return;

        // If columns changed since last save, update the review first
        if (columns.length === 0) return;

        if (!isModelAvailable(tabularModel, apiKeys)) {
            setApiKeyModalProvider(getModelProvider(tabularModel));
            return;
        }

        setGenerating(true);

        // Optimistically set empty/pending/error cells to generating (skip done cells).
        // The polling loop replaces these with the real values as items complete.
        setCells((prev) =>
            documents.flatMap((doc) =>
                columns.map((col) => {
                    const existing = prev.find(
                        (c) =>
                            c.document_id === doc.id &&
                            c.column_index === col.index,
                    );
                    if (existing?.status === "done" && existing?.content) {
                        return existing;
                    }
                    return existing
                        ? {
                              ...existing,
                              status: "generating" as const,
                              content: null,
                          }
                        : {
                              id: `${doc.id}-${col.index}`,
                              review_id: reviewId,
                              document_id: doc.id,
                              column_index: col.index,
                              content: null,
                              status: "generating" as const,
                              created_at: new Date().toISOString(),
                          };
                }),
            ),
        );

        try {
            const { jobId } = await startTabularGenerate(reviewId);
            await pollJob(jobId);
        } catch (err) {
            console.error("Generation failed", err);
            setGenerating(false);
        }
    }

    async function handleCancelGenerate() {
        const jobId = activeJobIdRef.current;
        if (!jobId) return;
        try {
            await cancelTabularJob(jobId);
        } catch (err) {
            console.warn("[tabular-cancel] failed", err);
        }
        // Don't stop the poller — let it observe the status flip naturally
        // so the UI updates from the canonical source.
    }

    async function handleAddColumn(newColumns: ColumnConfig[]) {
        const startIndex = getNextColumnIndex();
        const normalizedColumns = newColumns.map((column, index) => ({
            ...column,
            index: startIndex + index,
        }));
        const newCols = [...columns, ...normalizedColumns];
        setSavingColumn(true);
        setColumns(newCols);
        setCells((prev) => [
            ...prev,
            ...documents
                .filter((doc) =>
                    normalizedColumns.some(
                        (column) =>
                            !prev.some(
                                (cell) =>
                                    cell.document_id === doc.id &&
                                    cell.column_index === column.index,
                            ),
                    ),
                )
                .flatMap((doc) =>
                    normalizedColumns
                        .filter(
                            (column) =>
                                !prev.some(
                                    (cell) =>
                                        cell.document_id === doc.id &&
                                        cell.column_index === column.index,
                                ),
                        )
                        .map((column) => ({
                            id: `new-${doc.id}-${column.index}`,
                            review_id: reviewId,
                            document_id: doc.id,
                            column_index: column.index,
                            content: null,
                            status: "pending" as const,
                            created_at: new Date().toISOString(),
                        })),
                ),
        ]);
        try {
            await saveColumnsConfig(newCols);
        } catch (err) {
            setColumns(columns);
            setCells((prev) =>
                prev.filter(
                    (cell) =>
                        !normalizedColumns.some(
                            (column) => column.index === cell.column_index,
                        ),
                ),
            );
            console.error("Failed to save column", err);
        } finally {
            setSavingColumn(false);
        }
    }

    async function handleUpdateColumn(
        nextColumn: ColumnConfig,
        options?: { reprocess?: boolean },
    ) {
        const nextColumns = columns.map((column) =>
            column.index === nextColumn.index ? nextColumn : column,
        );
        const previousColumns = columns;
        setColumns(nextColumns);
        try {
            await saveColumnsConfig(nextColumns);
            if (options?.reprocess) {
                await handleReprocessColumn(nextColumn.index);
            }
        } catch (err) {
            setColumns(previousColumns);
            console.error("Failed to update column", err);
        }
    }

    // feat-021 — open the confirm modal; actual delete happens in
    // confirmDeleteColumn after the user explicitly confirms.
    function handleDeleteColumn(columnIndex: number) {
        const target = columns.find((c) => c.index === columnIndex);
        if (!target) return;
        setColumnPendingDelete(target);
    }

    async function confirmDeleteColumn() {
        if (!columnPendingDelete) return;
        const previousColumns = columns;
        const previousCells = cells;
        const targetIndex = columnPendingDelete.index;
        // Optimistic: remove the column + its cells locally.
        setColumns(columns.filter((c) => c.index !== targetIndex));
        setCells(cells.filter((c) => c.column_index !== targetIndex));
        setDeletingColumn(true);
        try {
            const { columns_config } = await deleteTabularColumn(
                reviewId,
                targetIndex,
            );
            // Trust server's columns_config as canonical.
            setColumns(columns_config);
            setColumnPendingDelete(null);
        } catch (err) {
            console.error("Failed to delete column", err);
            setColumns(previousColumns);
            setCells(previousCells);
            alert("Failed to delete column. Please try again.");
        } finally {
            setDeletingColumn(false);
        }
    }

    // feat-021 — hide column (localStorage-persisted, no server change).
    function handleHideColumn(columnIndex: number) {
        if (hiddenColumnIndices.includes(columnIndex)) return;
        persistHiddenColumns([...hiddenColumnIndices, columnIndex]);
    }
    function handleShowAllColumns() {
        persistHiddenColumns([]);
    }

    // feat-021 — reprocess one column. Server wipes its cells and starts
    // a job; we then run our normal poller so the run-button shows progress.
    async function handleReprocessColumn(columnIndex: number) {
        if (generating) return;
        setGenerating(true);
        // Optimistic: flip just this column's cells to generating so the
        // user gets immediate visual feedback.
        setCells((prev) =>
            prev.map((c) =>
                c.column_index === columnIndex
                    ? { ...c, status: "generating" as const, content: null }
                    : c,
            ),
        );
        try {
            const { jobId } = await reprocessTabularColumn(
                reviewId,
                columnIndex,
            );
            await pollJob(jobId);
        } catch (err) {
            console.error("Reprocess failed", err);
            setGenerating(false);
            alert(
                "Couldn't start reprocess — another run may already be in progress.",
            );
        }
    }

    function handleTabularCitationClick(colIdx: number, rowIdx: number) {
        setSearch("");
        setHighlightedCell({ colIdx, rowIdx });
        setTimeout(() => {
            tableRef.current?.scrollToCell(colIdx, rowIdx);
        }, 50);
        setTimeout(() => setHighlightedCell(null), 3000);
    }

    async function handleDeleteDocuments() {
        const remaining = documents.filter(
            (d) => !selectedDocIds.includes(d.id),
        );
        setDocuments(remaining);
        setCells((prev) =>
            prev.filter((c) => !selectedDocIds.includes(c.document_id)),
        );
        setSelectedDocIds([]);
        setActionsOpen(false);
        await updateTabularReview(reviewId, {
            document_ids: remaining.map((d) => d.id),
            columns_config: columns,
        });
    }

    async function handleClearResults() {
        const docIds = [...selectedDocIds];
        if (docIds.length === 0) return;
        setCells((prev) =>
            prev.map((c) =>
                docIds.includes(c.document_id)
                    ? { ...c, content: null, status: "pending" }
                    : c,
            ),
        );
        setSelectedDocIds([]);
        setActionsOpen(false);
        await clearTabularCells(reviewId, docIds);
    }

    async function handleTitleCommit(newTitle: string) {
        if (!newTitle || newTitle === review?.title) return;
        setReview((prev) => (prev ? { ...prev, title: newTitle } : prev));
        await updateTabularReview(reviewId, { title: newTitle });
    }

    const q = search.toLowerCase();
    const filteredDocuments = q
        ? documents.filter((d) => d.filename.toLowerCase().includes(q))
        : documents;

    if (docDetailDocId) {
        return (
            <div className="flex h-full overflow-hidden bg-card">
                <div className="flex flex-1 flex-col overflow-hidden">
                    <TRDocDetailView
                        reviewId={reviewId}
                        documentId={docDetailDocId}
                        documents={documents}
                        columns={columns}
                        cells={cells}
                        onBack={() => setDocDetailDocId(null)}
                        onChangeDocument={(id) => setDocDetailDocId(id)}
                        onCellUpdated={(updated) =>
                            setCells((prev) =>
                                prev.map((c) =>
                                    c.id === updated.id ? updated : c,
                                ),
                            )
                        }
                    />
                </div>
            </div>
        );
    }

    return (
        <div className="flex h-full overflow-hidden bg-card">
            <div className="flex flex-1 flex-col overflow-hidden">
                {/* Header */}
                <div className="bg-card px-8 py-4 flex items-start justify-between shrink-0 gap-4">
                    <div className="flex items-center gap-1.5 text-2xl font-medium font-serif">
                        {projectId && (
                            <>
                                <button
                                    onClick={() => router.push("/projects")}
                                    className="text-muted-foreground hover:text-foreground transition-colors"
                                >
                                    Projects
                                </button>
                                <span className="text-muted-foreground/50">›</span>
                                <button
                                    onClick={() =>
                                        router.push(`/projects/${projectId}`)
                                    }
                                    className="text-muted-foreground hover:text-foreground transition-colors"
                                >
                                    {loading ? (
                                        <div className="h-6 w-32 rounded bg-muted animate-pulse" />
                                    ) : (
                                        <>
                                            {project?.name ?? ""}
                                            {project?.cm_number && (
                                                <span className="ml-1 text-muted-foreground/70">
                                                    (#{project.cm_number})
                                                </span>
                                            )}
                                        </>
                                    )}
                                </button>
                                <span className="text-muted-foreground/50">›</span>
                                <button
                                    onClick={() =>
                                        router.push(
                                            `/projects/${projectId}?tab=reviews`,
                                        )
                                    }
                                    className="text-muted-foreground hover:text-foreground transition-colors"
                                >
                                    Tabular Reviews
                                </button>
                            </>
                        )}
                        {!projectId && (
                            <button
                                onClick={() => router.push("/tabular-reviews")}
                                className="text-muted-foreground hover:text-foreground transition-colors"
                            >
                                Tabular Reviews
                            </button>
                        )}
                        <span className="text-muted-foreground/50">›</span>
                        {loading ? (
                            <div className="h-6 w-40 rounded bg-muted animate-pulse" />
                        ) : (
                            <RenameableTitle
                                value={review?.title || "Untitled Review"}
                                onCommit={handleTitleCommit}
                            />
                        )}
                    </div>
                    {!loading && (
                        <div className="flex items-center gap-2">
                            <HeaderSearchBtn value={search} onChange={setSearch} placeholder="Search documents…" />
                            {!projectId && (
                                <button
                                    onClick={() => setPeopleModalOpen(true)}
                                    disabled={loading}
                                    className={`flex h-8 w-8 items-center justify-center text-sm transition-colors ${
                                        loading
                                            ? "text-muted-foreground/50 cursor-default"
                                            : "text-muted-foreground hover:text-foreground cursor-pointer"
                                    }`}
                                    title="People with access"
                                    aria-label="People with access"
                                >
                                    <Users className="h-4 w-4" />
                                </button>
                            )}
                            <button
                                onClick={() =>
                                    exportTabularReviewToExcel({
                                        reviewTitle: review?.title || "Tabular Review",
                                        columns,
                                        documents,
                                        cells,
                                    })
                                }
                                disabled={columns.length === 0 || documents.length === 0}
                                title="Export to Excel"
                                className={`flex h-8 items-center justify-center gap-1.5 px-3 text-sm transition-colors ${
                                    columns.length === 0 || documents.length === 0
                                        ? "text-muted-foreground/50 cursor-default"
                                        : "text-foreground hover:text-foreground cursor-pointer"
                                }`}
                            >
                                <Download className="h-4 w-4" />
                                Export
                            </button>
                            {generating ? (
                                <button
                                    onClick={handleCancelGenerate}
                                    disabled={!!jobStatus?.cancel_requested_at}
                                    className={`flex h-8 items-center justify-center gap-1.5 px-3 text-sm transition-colors ${
                                        jobStatus?.cancel_requested_at
                                            ? "text-muted-foreground/50 cursor-default"
                                            : "text-foreground hover:text-red-600 cursor-pointer"
                                    }`}
                                    title={
                                        jobStatus?.cancel_requested_at
                                            ? "Cancelling…"
                                            : "Cancel run"
                                    }
                                >
                                    <Loader2 className="h-4 w-4 animate-spin" />
                                    {jobStatus
                                        ? `${jobStatus.completed_items + jobStatus.error_items + jobStatus.skipped_items}/${jobStatus.total_items}${jobStatus.cancel_requested_at ? " — cancelling" : ""}`
                                        : "Running…"}
                                </button>
                            ) : (
                                <button
                                    onClick={handleGenerate}
                                    disabled={
                                        columns.length === 0 ||
                                        documents.length === 0 ||
                                        savingColumnsConfig
                                    }
                                    className={`flex h-8 items-center justify-center gap-1.5 px-3 text-sm transition-colors ${
                                        columns.length === 0 ||
                                        documents.length === 0 ||
                                        savingColumnsConfig
                                            ? "text-muted-foreground/50 cursor-default"
                                            : "text-foreground hover:text-foreground cursor-pointer"
                                    }`}
                                >
                                    <Play className="h-4 w-4" />
                                    Run
                                </button>
                            )}
                        </div>
                    )}
                </div>

                {/* Toolbar */}
                <div className="flex items-center h-10 px-8 border-b border-border gap-4">
                    <button
                        onClick={() => {
                            if (!chatOpen) setSidebarOpen(false);
                            if (chatOpen) setSelectedChatId(null);
                            setChatOpen((v) => !v);
                        }}
                        disabled={loading || columns.length === 0 || documents.length === 0}
                        className={`flex items-center gap-1 text-xs font-medium transition-colors ${
                            loading || columns.length === 0 || documents.length === 0
                                ? "text-muted-foreground/50 cursor-default"
                                : "text-foreground hover:text-foreground"
                        }`}
                    >
                        <MessageSquare className="h-3.5 w-3.5" />
                        Assistant in Tabular Review
                    </button>
                    <button
                        onClick={() => setWrapText((v) => !v)}
                        title={wrapText ? "Unwrap text" : "Wrap text"}
                        className={`flex items-center gap-1 text-xs font-medium transition-colors ${
                            wrapText
                                ? "text-foreground"
                                : "text-muted-foreground hover:text-foreground"
                        }`}
                    >
                        <WrapText className="h-3.5 w-3.5" />
                        {wrapText ? "Unwrap text" : "Wrap text"}
                    </button>
                    {/* feat-021 — show how many columns are hidden, with a
                        one-click restore. Hidden via the column 3-dot menu. */}
                    {hiddenColumnIndices.length > 0 && (
                        <button
                            onClick={handleShowAllColumns}
                            className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
                            title="Show all hidden columns"
                        >
                            {hiddenColumnIndices.length} hidden — Show all
                        </button>
                    )}
                    <div className="ml-auto flex items-center gap-4">
                        {selectedDocIds.length > 0 && (
                            <div ref={actionsRef} className="relative">
                                <button
                                    onClick={() => setActionsOpen((v) => !v)}
                                    className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
                                >
                                    Actions
                                    <ChevronDown className="h-3.5 w-3.5" />
                                </button>
                                {actionsOpen && (
                                    <div className="absolute top-full right-0 mt-1 w-36 rounded-lg border border-border bg-card shadow-lg z-50 overflow-hidden">
                                        <button
                                            onClick={handleClearResults}
                                            className="w-full px-3 py-1.5 text-left text-xs text-foreground hover:bg-muted transition-colors"
                                        >
                                            Clear results
                                        </button>
                                        <button
                                            onClick={handleDeleteDocuments}
                                            className="w-full px-3 py-1.5 text-left text-xs text-red-600 hover:bg-red-50 transition-colors"
                                        >
                                            Delete
                                        </button>
                                    </div>
                                )}
                            </div>
                        )}
                        <button
                            onClick={() => setAddDocsOpen(true)}
                            disabled={loading || savingColumnsConfig}
                            className={`flex items-center gap-1 text-xs font-medium transition-colors ${
                                loading || savingColumnsConfig
                                    ? "text-muted-foreground/50 cursor-default"
                                    : "text-foreground hover:text-foreground"
                            }`}
                        >
                            <Plus className="h-3.5 w-3.5" />
                            Add Documents
                        </button>
                        <button
                            onClick={() => setAddColOpen(true)}
                            disabled={
                                loading || savingColumn || savingColumnsConfig
                            }
                            className={`flex items-center gap-1 text-xs font-medium transition-colors ${
                                loading || savingColumn || savingColumnsConfig
                                    ? "text-muted-foreground/50 cursor-default"
                                    : "text-foreground hover:text-foreground"
                            }`}
                        >
                            <Plus className="h-3.5 w-3.5" />
                            Add Columns
                        </button>
                    </div>
                </div>

                {/* Table area */}
                <div className="flex flex-1 overflow-hidden">
                    {chatOpen && (
                        <TRChatPanel
                            reviewId={reviewId}
                            reviewTitle={review?.title ?? null}
                            projectName={project?.name ?? null}
                            columns={columns}
                            documents={documents}
                            onCitationClick={handleTabularCitationClick}
                            onClose={() => {
                                setSelectedChatId(null);
                                setChatOpen(false);
                            }}
                            initialChatId={selectedChatId}
                            onChatIdChange={setSelectedChatId}
                        />
                    )}
                    <TRTable
                        ref={tableRef}
                        loading={loading}
                        columns={visibleColumns}
                        documents={filteredDocuments}
                        cells={cells}
                        highlightedCell={highlightedCell}
                        savingColumn={savingColumn}
                        savingColumnsConfig={savingColumnsConfig}
                        selectedDocIds={selectedDocIds}
                        onSelectionChange={setSelectedDocIds}
                        onExpand={(cell) => {
                            setExpandedCell(cell);
                            setExpandedCellCitation(undefined);
                        }}
                        onCitationClick={(cell, page, quote) => {
                            setExpandedCell(cell);
                            setExpandedCellCitation({ quote, page });
                        }}
                        onUpdateColumn={handleUpdateColumn}
                        onDeleteColumn={handleDeleteColumn}
                        onReorderColumns={(next) => {
                            // Optimistic update + persist via existing saver.
                            setColumns(next);
                            saveColumnsConfig(next);
                        }}
                        onAddColumn={() => setAddColOpen(true)}
                        onAddDocuments={() => setAddDocsOpen(true)}
                        onDocumentClick={(docId) => setDocDetailDocId(docId)}
                        wrapText={wrapText}
                        onHideColumn={handleHideColumn}
                        onReprocessColumn={handleReprocessColumn}
                    />
                </div>
            </div>

            {/* Cell detail side panel */}
            {expandedCell &&
                (() => {
                    const expandedDoc = documents.find(
                        (d) => d.id === expandedCell.document_id,
                    );
                    const expandedCol = columns.find(
                        (c) => c.index === expandedCell.column_index,
                    );
                    if (!expandedDoc || !expandedCol) return null;
                    return (
                        <TRSidePanel
                            cell={expandedCell}
                            document={expandedDoc}
                            column={expandedCol}
                            columns={columns}
                            onClose={() => {
                                setExpandedCell(null);
                                setExpandedCellCitation(undefined);
                            }}
                            onNavigate={(columnIndex) => {
                                const nextCell = cells.find(
                                    (c) =>
                                        c.document_id ===
                                            expandedCell.document_id &&
                                        c.column_index === columnIndex,
                                );
                                if (nextCell) {
                                    setExpandedCell(nextCell);
                                    setExpandedCellCitation(undefined);
                                }
                            }}
                            onRegenerate={() =>
                                handleRegenerateCell(
                                    expandedCell.document_id,
                                    expandedCell.column_index,
                                )
                            }
                            displayDocument={expandedCellCitation !== undefined}
                            citationQuote={expandedCellCitation?.quote}
                            citationPage={expandedCellCitation?.page}
                        />
                    );
                })()}

            <AddColumnModal
                open={addColOpen}
                existingCount={columns.length}
                onClose={() => setAddColOpen(false)}
                onAdd={handleAddColumn}
            />

            {project ? (
                <AddProjectDocsModal
                    open={addDocsOpen}
                    onClose={() => setAddDocsOpen(false)}
                    onSelect={(docs: MikeDocument[]) =>
                        handleAddDocuments(docs)
                    }
                    breadcrumb={[
                        "Projects",
                        project.name +
                            (project.cm_number
                                ? ` (#${project.cm_number})`
                                : ""),
                        "Tabular Reviews",
                        ...(review ? [review.title || "Untitled Review"] : []),
                        "Add Documents",
                    ]}
                    projectId={project.id}
                    excludeDocIds={new Set(documents.map((d) => d.id))}
                />
            ) : (
                <AddDocumentsModal
                    open={addDocsOpen}
                    onClose={() => setAddDocsOpen(false)}
                    onSelect={(docs: MikeDocument[]) =>
                        handleAddDocuments(docs)
                    }
                    breadcrumb={[
                        "Tabular Reviews",
                        ...(review ? [review.title || "Untitled Review"] : []),
                        "Add Documents",
                    ]}
                />
            )}

            <PeopleModal
                open={peopleModalOpen}
                onClose={() => setPeopleModalOpen(false)}
                resource={review}
                fetchPeople={getTabularReviewPeople}
                currentUserEmail={user?.email ?? null}
                breadcrumb={[
                    "Tabular Reviews",
                    review?.title || "Untitled Review",
                    "People",
                ]}
                // Only the review owner may modify the member list. PeopleModal
                // hides the add/remove controls when this prop is undefined.
                onSharedWithChange={
                    review?.is_owner === false
                        ? undefined
                        : async (next) => {
                              const updated = await updateTabularReview(
                                  reviewId,
                                  { shared_with: next },
                              );
                              setReview((prev) =>
                                  prev
                                      ? {
                                            ...prev,
                                            shared_with: updated.shared_with,
                                        }
                                      : prev,
                              );
                          }
                }
            />

            <OwnerOnlyModal
                open={!!ownerOnlyAction}
                action={ownerOnlyAction ?? undefined}
                onClose={() => setOwnerOnlyAction(null)}
            />

            <ApiKeyMissingModal
                open={apiKeyModalProvider !== null}
                provider={apiKeyModalProvider}
                onClose={() => setApiKeyModalProvider(null)}
            />

            {/* feat-021 — confirm-delete-column. Inline because the modal is
                tiny and only used here. Counts cells that will be deleted so
                the user knows the blast radius. */}
            {columnPendingDelete && (
                <div
                    className="fixed inset-0 z-[100] flex items-center justify-center bg-foreground/40"
                    onClick={() =>
                        !deletingColumn && setColumnPendingDelete(null)
                    }
                >
                    <div
                        className="w-full max-w-sm rounded-xl border border-border bg-card p-5 shadow-xl"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <h3 className="text-base font-medium text-foreground mb-2">
                            Delete column?
                        </h3>
                        <p className="text-sm text-muted-foreground mb-4">
                            <span className="text-foreground font-medium">
                                {columnPendingDelete.name}
                            </span>{" "}
                            and{" "}
                            {
                                cells.filter(
                                    (c) =>
                                        c.column_index ===
                                        columnPendingDelete.index,
                                ).length
                            }{" "}
                            cell
                            {cells.filter(
                                (c) =>
                                    c.column_index ===
                                    columnPendingDelete.index,
                            ).length === 1
                                ? ""
                                : "s"}{" "}
                            will be permanently deleted. This cannot be undone.
                        </p>
                        <div className="flex items-center justify-end gap-2">
                            <button
                                type="button"
                                onClick={() => setColumnPendingDelete(null)}
                                disabled={deletingColumn}
                                className="rounded-md border border-border bg-card px-3 py-1.5 text-sm text-foreground hover:bg-muted transition-colors disabled:opacity-50"
                            >
                                Cancel
                            </button>
                            <button
                                type="button"
                                onClick={confirmDeleteColumn}
                                disabled={deletingColumn}
                                className="rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 transition-colors disabled:opacity-50"
                            >
                                {deletingColumn
                                    ? "Deleting…"
                                    : "Delete column"}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
