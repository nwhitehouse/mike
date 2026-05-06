"use client";

import { useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";

export type VisionRenderStatus = "pending" | "ready" | "failed" | "missing";

const API_BASE =
    process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001";

const POLL_INTERVAL_MS = 1000;
/** Cap on consecutive polls before we give up and treat as ready. Render
 *  on a 200-page doc is roughly 30s; 60 polls = 60s of patience covers
 *  everything we'd ever realistically render. */
const POLL_MAX_ATTEMPTS = 60;

/**
 * Track the vision-mode pre-render status for a list of PDF documents.
 * Returns a Map<documentId, VisionRenderStatus>. Polls the backend every
 * second per pending doc until status resolves or POLL_MAX_ATTEMPTS hits.
 *
 * Used by ChatInput to:
 *  - Shimmer the doc chip while status === "pending"
 *  - Disable the Send button if ANY attached doc is pending
 *
 * Non-PDF docs (DOCX etc.) immediately resolve to "ready" because vision
 * mode is gated to PDFs in the backend (visionContext.ts) — a DOCX never
 * sits in the pre-render queue.
 *
 * Initial state for a known doc is "pending" so the UI starts in the
 * waiting state and resolves to ready once the first poll lands. This
 * matches user expectation when they upload — they see the chip appear
 * shimmering immediately.
 */
export function useVisionStatus(
    docs: { id: string; file_type?: string | null }[],
): Map<string, VisionRenderStatus> {
    const [statuses, setStatuses] = useState<Map<string, VisionRenderStatus>>(
        () => new Map(),
    );
    // Active poll timers per-doc so we can clean them up on unmount or
    // when a doc is removed from the attached list.
    const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(
        new Map(),
    );

    useEffect(() => {
        const ids = docs.map((d) => d.id);
        const idSet = new Set(ids);

        // Drop tracking + cancel timers for docs that are no longer attached.
        for (const [id, timer] of timersRef.current) {
            if (!idSet.has(id)) {
                clearTimeout(timer);
                timersRef.current.delete(id);
            }
        }
        setStatuses((prev) => {
            const next = new Map(prev);
            for (const id of next.keys()) {
                if (!idSet.has(id)) next.delete(id);
            }
            // Seed pending for newly-attached PDFs.
            for (const d of docs) {
                if (next.has(d.id)) continue;
                if (d.file_type?.toLowerCase() === "pdf") {
                    next.set(d.id, "pending");
                } else {
                    next.set(d.id, "ready");
                }
            }
            return next;
        });

        // Kick off polling for any PDF whose status isn't resolved.
        for (const d of docs) {
            if (d.file_type?.toLowerCase() !== "pdf") continue;
            if (timersRef.current.has(d.id)) continue;
            // Capture id locally — `d` is reused per iteration.
            const docId = d.id;
            let attempts = 0;
            const tick = async () => {
                attempts++;
                let status: VisionRenderStatus = "ready";
                try {
                    const {
                        data: { session },
                    } = await supabase.auth.getSession();
                    const token = session?.access_token;
                    const resp = await fetch(
                        `${API_BASE}/single-documents/${docId}/vision-status`,
                        {
                            headers: token
                                ? { Authorization: `Bearer ${token}` }
                                : {},
                        },
                    );
                    if (resp.ok) {
                        const body = (await resp.json()) as {
                            status: VisionRenderStatus;
                        };
                        status = body.status;
                    } else {
                        // 404 or auth error — give up rather than thrash.
                        status = "ready";
                    }
                } catch {
                    // Network error: treat as ready so the user isn't
                    // stuck behind an unreachable backend.
                    status = "ready";
                }
                setStatuses((prev) => {
                    if (prev.get(docId) === status) return prev;
                    const next = new Map(prev);
                    next.set(docId, status);
                    return next;
                });
                if (status === "pending" && attempts < POLL_MAX_ATTEMPTS) {
                    timersRef.current.set(
                        docId,
                        setTimeout(tick, POLL_INTERVAL_MS),
                    );
                } else {
                    timersRef.current.delete(docId);
                    if (status === "pending") {
                        // Bail-out: treat as ready so UI doesn't lock up
                        // forever if backend is misbehaving.
                        setStatuses((prev) => {
                            const next = new Map(prev);
                            next.set(docId, "ready");
                            return next;
                        });
                    }
                }
            };
            // First poll fires immediately so newly-attached docs resolve
            // fast when they're already cached.
            timersRef.current.set(docId, setTimeout(tick, 0));
        }

        return () => {
            // Cleanup on unmount only — per-doc cleanup handled above.
        };
    }, [docs]);

    // Final unmount cleanup.
    useEffect(() => {
        const timers = timersRef.current;
        return () => {
            for (const t of timers.values()) clearTimeout(t);
            timers.clear();
        };
    }, []);

    return statuses;
}
