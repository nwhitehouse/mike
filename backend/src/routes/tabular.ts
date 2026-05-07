import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { createServerSupabase } from "../lib/supabase";
import { downloadFile } from "../lib/storage";
import { loadActiveVersion } from "../lib/documentVersions";
import {
    runLLMStream,
    TABULAR_TOOLS,
    type ChatMessage,
    type TabularCellStore,
} from "../lib/chatTools";
import { completeText } from "../lib/llm";
import { getUserApiKeys, getUserModelSettings } from "../lib/userSettings";
import {
    checkProjectAccess,
    ensureDocAccess,
    ensureReviewAccess,
    listAccessibleProjectIds,
} from "../lib/access";
// bug-007 — tabular extraction + LLM helpers + the durable-job worker
// pool live in lib/tabularJobs.ts. Importing them here so the per-cell
// regenerate route can reuse the helpers and POST /generate can create a
// job instead of running the work inline.
import {
    extractPdfMarkdown,
    extractDocxMarkdown,
    queryGemini,
    createGenerateJob,
} from "../lib/tabularJobs";

export const tabularRouter = Router();

type AccessDocRow = {
    id: string;
    user_id: string;
    project_id: string | null;
};

export async function requireAccessibleDocumentIds(
    documentIds: string[],
    userId: string,
    userEmail: string | undefined,
    db: ReturnType<typeof createServerSupabase>,
): Promise<{ ok: true; ids: string[] } | { ok: false }> {
    const ids = [...new Set(documentIds.filter(Boolean))];
    if (ids.length === 0) return { ok: true, ids: [] };

    const { data: docs, error } = await db
        .from("documents")
        .select("id, user_id, project_id")
        .in("id", ids);
    if (error || !docs || docs.length !== ids.length) return { ok: false };

    for (const doc of docs as AccessDocRow[]) {
        const access = await ensureDocAccess(doc, userId, userEmail, db);
        if (!access.ok) return { ok: false };
    }
    return { ok: true, ids };
}

async function filterAccessibleDocuments<T extends AccessDocRow>(
    docs: T[],
    userId: string,
    userEmail: string | undefined,
    db: ReturnType<typeof createServerSupabase>,
): Promise<T[]> {
    const checks = await Promise.all(
        docs.map(async (doc) => ({
            doc,
            access: await ensureDocAccess(doc, userId, userEmail, db),
        })),
    );
    return checks.filter((x) => x.access.ok).map((x) => x.doc);
}

// GET /tabular-review
tabularRouter.get("/", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const db = createServerSupabase();

    // Optional ?project_id= scopes results to a single project. Project-page
    // callers pass it; the global tabular-reviews page omits it. We still
    // enforce access via listAccessibleProjectIds so a stranger can't request
    // an arbitrary project_id.
    const projectIdFilter =
        typeof req.query.project_id === "string" && req.query.project_id
            ? (req.query.project_id as string)
            : null;

    // Visible reviews = user's own + reviews in any accessible project.
    const projectIds = await listAccessibleProjectIds(userId, userEmail, db);

    if (projectIdFilter && !projectIds.includes(projectIdFilter)) {
        // No access to that project — also covers "project doesn't exist".
        return void res.json([]);
    }

    let ownQuery = db
        .from("tabular_reviews")
        .select("*")
        .eq("user_id", userId)
        .order("created_at", { ascending: false });
    if (projectIdFilter) ownQuery = ownQuery.eq("project_id", projectIdFilter);

    const sharedProjectIds = projectIdFilter ? [projectIdFilter] : projectIds;
    // Three sources to merge:
    //  - own:           reviews this user created
    //  - sharedProj:    reviews in a project the user has access to
    //  - sharedDirect:  standalone reviews (project_id null) where the
    //                   user's email is in tabular_reviews.shared_with
    const [
        { data: own, error: ownErr },
        { data: shared, error: sharedErr },
        { data: sharedDirect, error: sharedDirectErr },
    ] = await Promise.all([
        ownQuery,
        sharedProjectIds.length > 0
            ? db
                  .from("tabular_reviews")
                  .select("*")
                  .in("project_id", sharedProjectIds)
                  .neq("user_id", userId)
                  .order("created_at", { ascending: false })
            : Promise.resolve({
                  data: [] as Record<string, unknown>[],
                  error: null,
              }),
        // Skip the direct-share lookup when the caller is filtering to a
        // specific project — direct shares are inherently project-id-null.
        userEmail && !projectIdFilter
            ? db
                  .from("tabular_reviews")
                  .select("*")
                  .contains("shared_with", JSON.stringify([userEmail]))
                  .neq("user_id", userId)
                  .order("created_at", { ascending: false })
            : Promise.resolve({
                  data: [] as Record<string, unknown>[],
                  error: null,
              }),
    ]);
    if (ownErr) return void res.status(500).json({ detail: ownErr.message });
    // Don't fail the whole list when an auxiliary share query errors — most
    // commonly the tabular_reviews.shared_with column hasn't been migrated
    // yet. Log and continue so the user still sees their own reviews.
    if (sharedErr)
        console.warn(
            "[tabular] shared-by-project query failed:",
            sharedErr.message,
        );
    if (sharedDirectErr)
        console.warn(
            "[tabular] shared-by-email query failed:",
            sharedDirectErr.message,
        );
    const seen = new Set<string>();
    const reviews: Record<string, unknown>[] = [];
    for (const r of [
        ...(own ?? []),
        ...(shared ?? []),
        ...(sharedDirect ?? []),
    ]) {
        const id = (r as { id: string }).id;
        if (seen.has(id)) continue;
        seen.add(id);
        reviews.push(r as Record<string, unknown>);
    }

    // Fetch distinct document counts per review
    const reviewIds = reviews.map((r) => (r as { id: string }).id);
    let docCounts: Record<string, number> = {};
    if (reviewIds.length > 0) {
        const { data: cells } = await db
            .from("tabular_cells")
            .select("review_id, document_id")
            .in("review_id", reviewIds);
        if (cells) {
            const seen = new Set<string>();
            for (const cell of cells) {
                const key = `${cell.review_id}:${cell.document_id}`;
                if (!seen.has(key)) {
                    seen.add(key);
                    docCounts[cell.review_id] =
                        (docCounts[cell.review_id] ?? 0) + 1;
                }
            }
        }
    }

    res.json(
        reviews.map((r) => {
            const id = (r as { id: string }).id;
            return { ...r, document_count: docCounts[id] ?? 0 };
        }),
    );
});

// POST /tabular-review
tabularRouter.post("/", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { title, document_ids, columns_config, workflow_id, project_id } =
        req.body as {
            title?: string;
            document_ids: string[];
            columns_config: { index: number; name: string; prompt: string }[];
            workflow_id?: string;
            project_id?: string;
        };

    const db = createServerSupabase();
    if (!Array.isArray(document_ids))
        return void res.status(400).json({ detail: "document_ids is required" });
    const docAccess = await requireAccessibleDocumentIds(
        document_ids,
        userId,
        userEmail,
        db,
    );
    if (!docAccess.ok)
        return void res.status(404).json({ detail: "Document not found" });

    if (project_id) {
        const access = await checkProjectAccess(
            project_id,
            userId,
            userEmail,
            db,
        );
        if (!access.ok)
            return void res.status(404).json({ detail: "Project not found" });
    }
    const { data: review, error } = await db
        .from("tabular_reviews")
        .insert({
            user_id: userId,
            title: title ?? null,
            columns_config,
            project_id: project_id ?? null,
            workflow_id: workflow_id ?? null,
        })
        .select("*")
        .single();
    if (error || !review)
        return void res
            .status(500)
            .json({ detail: error?.message ?? "Failed to create review" });

    const cells = docAccess.ids.flatMap((docId) =>
        columns_config.map((col) => ({
            review_id: review.id,
            document_id: docId,
            column_index: col.index,
            status: "pending",
        })),
    );
    if (cells.length) await db.from("tabular_cells").insert(cells);

    res.status(201).json(review);
});

// POST /tabular-review/prompt (must come before /:reviewId routes)
tabularRouter.post("/prompt", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const title =
        typeof req.body.title === "string" ? req.body.title.trim() : "";
    if (!title)
        return void res.status(400).json({ detail: "title is required" });

    const format: string =
        typeof req.body.format === "string" ? req.body.format : "text";
    const documentName: string =
        typeof req.body.documentName === "string"
            ? req.body.documentName.trim()
            : "";
    const tags: string[] = Array.isArray(req.body.tags)
        ? req.body.tags.filter((t: unknown) => typeof t === "string")
        : [];

    const formatDescriptions: Record<string, string> = {
        text: "free-form text",
        bulleted_list: "a bulleted list",
        number: "a single number",
        percentage: "a percentage value",
        monetary_amount: "a monetary amount",
        currency: "a currency code",
        yes_no: "Yes or No",
        date: "a date",
        tag: tags.length ? `one of these tags: ${tags.join(", ")}` : "a tag",
    };
    const formatHint = formatDescriptions[format] ?? "free-form text";
    const tagsNote =
        format === "tag" && tags.length
            ? `\nAvailable tags: ${tags.join(", ")}`
            : "";
    const docNote = documentName ? `\nDocument type/name: ${documentName}` : "";

    const userMessage =
        `Column title: ${title}` +
        docNote +
        `\nExpected response format: ${formatHint}` +
        tagsNote +
        `\n\nWrite the best extraction prompt for a legal tabular review column with this title. ` +
        `Do NOT include any instruction about the response format in the prompt — ` +
        `format handling is applied separately and must not be duplicated inside the prompt text.`;

    try {
        const { title_model, api_keys } = await getUserModelSettings(userId);
        const raw = await completeText({
            model: title_model,
            systemPrompt:
                'You write high-quality column prompts for legal tabular review workflows. Return only valid JSON with a single field: {"prompt": string}. The prompt you write must focus solely on what to extract — never on how to format the response.',
            user: userMessage,
            maxTokens: 512,
            apiKeys: api_keys,
        });
        const parsed = JSON.parse(
            raw
                .replace(/^```(?:json)?\n?/i, "")
                .replace(/\n?```$/, "")
                .trim(),
        ) as { prompt?: unknown };
        if (typeof parsed.prompt === "string" && parsed.prompt.trim()) {
            res.json({ prompt: parsed.prompt.trim(), source: "llm" });
        } else {
            res.status(502).json({ detail: "LLM returned an empty prompt" });
        }
    } catch {
        res.status(502).json({ detail: "Failed to generate prompt from LLM" });
    }
});

// GET /tabular-review/:reviewId
tabularRouter.get("/:reviewId", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { reviewId } = req.params;
    const db = createServerSupabase();

    const { data: review, error } = await db
        .from("tabular_reviews")
        .select("*")
        .eq("id", reviewId)
        .single();
    if (error || !review)
        return void res.status(404).json({ detail: "Review not found" });
    const access = await ensureReviewAccess(review, userId, userEmail, db);
    if (!access.ok)
        return void res.status(404).json({ detail: "Review not found" });

    const { data: cells } = await db
        .from("tabular_cells")
        .select("*")
        .eq("review_id", reviewId);
    const docIds = [...new Set((cells ?? []).map((c) => c.document_id))];
    const docsResult =
        docIds.length > 0
            ? await db
                  .from("documents")
                  .select("*")
                  .in("id", docIds)
            : review.project_id
              ? await db
                    .from("documents")
                    .select("*")
                    .eq("project_id", review.project_id)
                    .order("created_at", { ascending: true })
              : { data: [] as Record<string, unknown>[] };

    const accessibleDocs = await filterAccessibleDocuments(
        (docsResult.data ?? []) as (Record<string, unknown> & AccessDocRow)[],
        userId,
        userEmail,
        db,
    );
    const accessibleDocIds = new Set(accessibleDocs.map((doc) => doc.id));

    res.json({
        review: { ...review, is_owner: access.isOwner },
        cells: (cells ?? [])
            .filter((cell) => accessibleDocIds.has(cell.document_id))
            .map((cell) => ({
                ...cell,
                content: parseCellContent(cell.content),
            })),
        documents: accessibleDocs,
    });
});

// GET /tabular-review/:reviewId/people
// Owner email + display_name plus member display_names — the analog of
// /projects/:id/people. Used by the standalone TR detail page's People
// modal so the roster can show display_names alongside emails.
tabularRouter.get("/:reviewId/people", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { reviewId } = req.params;
    const db = createServerSupabase();

    const { data: review } = await db
        .from("tabular_reviews")
        .select("id, user_id, project_id, shared_with")
        .eq("id", reviewId)
        .single();
    if (!review)
        return void res.status(404).json({ detail: "Review not found" });
    const access = await ensureReviewAccess(review, userId, userEmail, db);
    if (!access.ok)
        return void res.status(404).json({ detail: "Review not found" });

    const sharedWith: string[] = (
        Array.isArray(review.shared_with)
            ? (review.shared_with as string[])
            : []
    ).map((e) => (e ?? "").toLowerCase());

    // Same pattern as /projects/:id/people: walk auth.users to map emails
    // to user_ids, then pull display_names from user_profiles by user_id.
    const { data: usersData } = await db.auth.admin.listUsers({
        perPage: 1000,
    });
    const allUsers = usersData?.users ?? [];
    const userByEmail = new Map<string, { id: string; email: string }>();
    const userById = new Map<string, { id: string; email: string }>();
    for (const u of allUsers) {
        if (!u.email) continue;
        const lower = u.email.toLowerCase();
        userByEmail.set(lower, { id: u.id, email: u.email });
        userById.set(u.id, { id: u.id, email: u.email });
    }

    const memberUserIds: string[] = [];
    for (const email of sharedWith) {
        const u = userByEmail.get(email);
        if (u) memberUserIds.push(u.id);
    }

    const profileIds = [review.user_id as string, ...memberUserIds].filter(
        (x, i, arr) => arr.indexOf(x) === i,
    );

    const profileByUserId = new Map<string, string | null>();
    if (profileIds.length > 0) {
        const { data: profiles } = await db
            .from("user_profiles")
            .select("user_id, display_name")
            .in("user_id", profileIds);
        for (const p of profiles ?? []) {
            profileByUserId.set(
                p.user_id as string,
                (p.display_name as string | null) ?? null,
            );
        }
    }

    const ownerInfo = userById.get(review.user_id as string);
    res.json({
        owner: {
            user_id: review.user_id,
            email: ownerInfo?.email ?? null,
            display_name: profileByUserId.get(review.user_id as string) ?? null,
        },
        members: sharedWith.map((email) => {
            const u = userByEmail.get(email);
            const display_name = u ? (profileByUserId.get(u.id) ?? null) : null;
            return { email, display_name };
        }),
    });
});

// PATCH /tabular-review/:reviewId
tabularRouter.patch("/:reviewId", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { reviewId } = req.params;
    const updates: Record<string, unknown> = {};
    if (req.body.title != null) updates.title = req.body.title;
    if (req.body.columns_config != null)
        updates.columns_config = req.body.columns_config;
    if (req.body.project_id !== undefined)
        updates.project_id = req.body.project_id;
    // shared_with edits are owner-only — gated below after we know who's
    // making the call. Normalize lowercase + dedupe + drop empties.
    let sharedWithUpdate: string[] | undefined;
    if (Array.isArray(req.body.shared_with)) {
        const seen = new Set<string>();
        const cleaned: string[] = [];
        for (const raw of req.body.shared_with) {
            if (typeof raw !== "string") continue;
            const e = raw.trim().toLowerCase();
            if (!e || seen.has(e)) continue;
            seen.add(e);
            cleaned.push(e);
        }
        sharedWithUpdate = cleaned;
    }
    updates.updated_at = new Date().toISOString();

    const db = createServerSupabase();
    const { data: existingReview, error: reviewError } = await db
        .from("tabular_reviews")
        .select("*")
        .eq("id", reviewId)
        .single();
    if (reviewError || !existingReview)
        return void res.status(404).json({ detail: "Review not found" });
    const access = await ensureReviewAccess(
        existingReview,
        userId,
        userEmail,
        db,
    );
    if (!access.ok)
        return void res.status(404).json({ detail: "Review not found" });
    if (typeof updates.project_id === "string" && updates.project_id) {
        const projectAccess = await checkProjectAccess(
            updates.project_id,
            userId,
            userEmail,
            db,
        );
        if (!projectAccess.ok)
            return void res.status(404).json({ detail: "Project not found" });
    }
    if (sharedWithUpdate !== undefined) {
        if (!access.isOwner)
            return void res
                .status(403)
                .json({ detail: "Only the review owner can change sharing" });
        updates.shared_with = sharedWithUpdate;
    }

    const { data: updatedReview, error: updateError } = await db
        .from("tabular_reviews")
        .update(updates)
        .eq("id", reviewId)
        .select("*")
        .single();
    if (updateError || !updatedReview)
        return void res.status(500).json({
            detail: updateError?.message ?? "Failed to update review",
        });

    if (
        Array.isArray(req.body.columns_config) ||
        Array.isArray(req.body.document_ids)
    ) {
        const { data: existingCells } = await db
            .from("tabular_cells")
            .select("document_id,column_index")
            .eq("review_id", reviewId);
        const existingKeys = new Set(
            (existingCells ?? []).map(
                (cell) => `${cell.document_id}:${cell.column_index}`,
            ),
        );

        let documentIds: string[];

        if (Array.isArray(req.body.document_ids)) {
            // document_ids is the new source of truth — delete removed docs' cells
            const docAccess = await requireAccessibleDocumentIds(
                req.body.document_ids as string[],
                userId,
                userEmail,
                db,
            );
            if (!docAccess.ok)
                return void res
                    .status(404)
                    .json({ detail: "Document not found" });
            const newDocIds = docAccess.ids;
            const existingDocIds = (existingCells ?? []).map(
                (cell) => cell.document_id,
            );
            const removedDocIds = existingDocIds.filter(
                (id) => !newDocIds.includes(id),
            );

            if (removedDocIds.length > 0) {
                const { error: deleteError } = await db
                    .from("tabular_cells")
                    .delete()
                    .eq("review_id", reviewId)
                    .in("document_id", removedDocIds);
                if (deleteError)
                    return void res
                        .status(500)
                        .json({ detail: deleteError.message });
            }

            documentIds = newDocIds;
        } else {
            // No document change — derive from existing cells
            documentIds = [
                ...new Set(
                    (existingCells ?? []).map((cell) => cell.document_id),
                ),
            ];
            if (documentIds.length === 0 && existingReview.project_id) {
                const { data: projectDocs } = await db
                    .from("documents")
                    .select("id")
                    .eq("project_id", existingReview.project_id);
                documentIds = (projectDocs ?? []).map((doc) => doc.id);
            }
        }

        const activeColumns = Array.isArray(req.body.columns_config)
            ? req.body.columns_config
            : (updatedReview.columns_config ?? []);
        const newCells = documentIds.flatMap((documentId) =>
            activeColumns
                .filter(
                    (column: { index: number }) =>
                        !existingKeys.has(`${documentId}:${column.index}`),
                )
                .map((column: { index: number }) => ({
                    review_id: reviewId,
                    document_id: documentId,
                    column_index: column.index,
                    status: "pending",
                })),
        );

        if (newCells.length > 0) {
            const { error: insertError } = await db
                .from("tabular_cells")
                .insert(newCells);
            if (insertError)
                return void res
                    .status(500)
                    .json({ detail: insertError.message });
        }
    }

    res.json(updatedReview);
});

// DELETE /tabular-review/:reviewId
tabularRouter.delete("/:reviewId", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const { reviewId } = req.params;
    const db = createServerSupabase();
    const { error } = await db
        .from("tabular_reviews")
        .delete()
        .eq("id", reviewId)
        .eq("user_id", userId);
    if (error) return void res.status(500).json({ detail: error.message });
    res.status(204).send();
});

// POST /tabular-review/:reviewId/clear-cells
// Reset cells to an empty/pending state for the given document_ids. Does not
// delete the rows — it blanks `content` and sets `status` back to "pending".
tabularRouter.post("/:reviewId/clear-cells", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { reviewId } = req.params;
    const { document_ids } = req.body as { document_ids?: string[] };

    if (!Array.isArray(document_ids) || document_ids.length === 0)
        return void res
            .status(400)
            .json({ detail: "document_ids is required" });

    const db = createServerSupabase();
    const { data: review, error: reviewError } = await db
        .from("tabular_reviews")
        .select("id, user_id, project_id")
        .eq("id", reviewId)
        .single();
    if (reviewError || !review)
        return void res.status(404).json({ detail: "Review not found" });
    const access = await ensureReviewAccess(review, userId, userEmail, db);
    if (!access.ok)
        return void res.status(404).json({ detail: "Review not found" });

    const { error } = await db
        .from("tabular_cells")
        .update({ content: null, status: "pending" })
        .eq("review_id", reviewId)
        .in("document_id", document_ids);
    if (error) return void res.status(500).json({ detail: error.message });
    res.status(204).send();
});

// PATCH /tabular-review/:reviewId/cells/verify
//
// feat-023 — toggles a single cell's verified state. Used by the in-table
// hover ✓ button + drives the "Verified state" filter predicate. Records
// who toggled it and when so a future audit story can use that without a
// schema change.
tabularRouter.patch(
    "/:reviewId/cells/verify",
    requireAuth,
    async (req, res) => {
        const userId = res.locals.userId as string;
        const userEmail = res.locals.userEmail as string | undefined;
        const { reviewId } = req.params;
        const { document_id, column_index, verified } = req.body as {
            document_id?: string;
            column_index?: number;
            verified?: boolean;
        };

        if (
            typeof document_id !== "string" ||
            typeof column_index !== "number" ||
            typeof verified !== "boolean"
        ) {
            return void res.status(400).json({
                detail:
                    "document_id (string), column_index (number), verified (boolean) are required",
            });
        }

        const db = createServerSupabase();
        const { data: review } = await db
            .from("tabular_reviews")
            .select("id, user_id, shared_with, project_id")
            .eq("id", reviewId)
            .single();
        if (!review)
            return void res.status(404).json({ detail: "Review not found" });
        const access = await ensureReviewAccess(review, userId, userEmail, db);
        if (!access.ok)
            return void res.status(404).json({ detail: "Review not found" });

        const { error } = await db
            .from("tabular_cells")
            .update({
                verified,
                verified_at: verified ? new Date().toISOString() : null,
                verified_by: verified ? userId : null,
            })
            .eq("review_id", reviewId)
            .eq("document_id", document_id)
            .eq("column_index", column_index);
        if (error) return void res.status(500).json({ detail: error.message });
        res.json({ ok: true });
    },
);

// PATCH /tabular-review/:reviewId/cells
// Manually edit a single cell's content (summary / reasoning / flag).
// Sets status to "done".
tabularRouter.patch(
    "/:reviewId/cells",
    requireAuth,
    async (req, res) => {
        const userId = res.locals.userId as string;
        const userEmail = res.locals.userEmail as string | undefined;
        const { reviewId } = req.params;
        const { document_id, column_index, content } = req.body as {
            document_id?: string;
            column_index?: number;
            content?: { summary?: string; reasoning?: string; flag?: string };
        };

        if (!document_id || column_index == null || !content) {
            return void res.status(400).json({
                detail: "document_id, column_index, content are required",
            });
        }

        const db = createServerSupabase();
        const { data: review, error: reviewError } = await db
            .from("tabular_reviews")
            .select("*")
            .eq("id", reviewId)
            .single();
        if (reviewError || !review)
            return void res.status(404).json({ detail: "Review not found" });
        const access = await ensureReviewAccess(review, userId, userEmail, db);
        if (!access.ok)
            return void res.status(404).json({ detail: "Review not found" });

        const validFlags = ["green", "grey", "yellow", "red"] as const;
        const next = {
            summary: typeof content.summary === "string" ? content.summary : "",
            flag:
                typeof content.flag === "string" &&
                (validFlags as readonly string[]).includes(content.flag)
                    ? content.flag
                    : "grey",
            reasoning:
                typeof content.reasoning === "string" ? content.reasoning : "",
        };

        const { error } = await db
            .from("tabular_cells")
            .update({
                content: JSON.stringify(next),
                status: "done",
            })
            .eq("review_id", reviewId)
            .eq("document_id", document_id)
            .eq("column_index", column_index);
        if (error) return void res.status(500).json({ detail: error.message });

        res.json({ ok: true, content: next });
    },
);

// POST /tabular-review/:reviewId/regenerate-cell
tabularRouter.post(
    "/:reviewId/regenerate-cell",
    requireAuth,
    async (req, res) => {
        const userId = res.locals.userId as string;
        const userEmail = res.locals.userEmail as string | undefined;
        const { reviewId } = req.params;
        const { document_id, column_index } = req.body as {
            document_id: string;
            column_index: number;
        };

        if (!document_id || column_index == null)
            return void res
                .status(400)
                .json({ detail: "document_id and column_index are required" });

        const db = createServerSupabase();
        const { data: review, error: reviewError } = await db
            .from("tabular_reviews")
            .select("*")
            .eq("id", reviewId)
            .single();
        if (reviewError || !review)
            return void res.status(404).json({ detail: "Review not found" });
        const access = await ensureReviewAccess(review, userId, userEmail, db);
        if (!access.ok)
            return void res.status(404).json({ detail: "Review not found" });

        const column = (
            review.columns_config as {
                index: number;
                name: string;
                prompt: string;
                format?: string;
                tags?: string[];
            }[]
        ).find((c) => c.index === column_index);
        if (!column)
            return void res.status(400).json({ detail: "Column not found" });

        const { data: doc } = await db
            .from("documents")
            .select("id, filename, file_type, user_id, project_id")
            .eq("id", document_id)
            .single();
        if (!doc)
            return void res.status(404).json({ detail: "Document not found" });
        const docAccess = await ensureDocAccess(
            doc as AccessDocRow,
            userId,
            userEmail,
            db,
        );
        if (!docAccess.ok)
            return void res.status(404).json({ detail: "Document not found" });
        const docActive = await loadActiveVersion(document_id, db);

        await db
            .from("tabular_cells")
            .update({ status: "generating", content: null })
            .eq("review_id", reviewId)
            .eq("document_id", document_id)
            .eq("column_index", column_index);

        let markdown = "";
        if (docActive) {
            const buf = await downloadFile(docActive.storage_path);
            if (buf) {
                try {
                    markdown =
                        (doc.file_type as string) === "pdf"
                            ? await extractPdfMarkdown(buf)
                            : await extractDocxMarkdown(buf);
                } catch (err) {
                    console.error(
                        `[regenerate-cell] extraction error doc=${document_id}`,
                        err,
                    );
                }
            }
        }

        const { tabular_model, api_keys } = await getUserModelSettings(
            userId,
            db,
        );
        const result = await queryGemini(
            tabular_model,
            doc.filename as string,
            markdown,
            column.prompt,
            column.format,
            column.tags,
            api_keys,
        );

        if (!result) {
            await db
                .from("tabular_cells")
                .update({ status: "error" })
                .eq("review_id", reviewId)
                .eq("document_id", document_id)
                .eq("column_index", column_index);
            return void res.status(500).json({ detail: "Generation failed" });
        }

        await db
            .from("tabular_cells")
            .update({ content: JSON.stringify(result), status: "done" })
            .eq("review_id", reviewId)
            .eq("document_id", document_id)
            .eq("column_index", column_index);

        res.json(result);
    },
);

// POST /tabular-review/:reviewId/generate
//
// bug-007 — used to be a long-lived SSE stream that ran the per-doc LLM
// fan-out inline in the request handler. Now creates a durable job +
// items rows and returns immediately; an in-process worker pool processes
// items in the background and the frontend polls for updates. Survives
// browser tab close, proxy idle timeout, and backend restart.
tabularRouter.post("/:reviewId/generate", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { reviewId } = req.params;
    const db = createServerSupabase();

    const { data: review, error: reviewError } = await db
        .from("tabular_reviews")
        .select("*")
        .eq("id", reviewId)
        .single();
    if (reviewError || !review)
        return void res.status(404).json({ detail: "Review not found" });
    const access = await ensureReviewAccess(review, userId, userEmail, db);
    if (!access.ok)
        return void res.status(404).json({ detail: "Review not found" });

    const columns: {
        index: number;
        name: string;
        prompt: string;
        format?: string;
        tags?: string[];
    }[] = review.columns_config ?? [];
    if (columns.length === 0)
        return void res.status(400).json({ detail: "No columns configured" });

    // Prevent overlapping runs on the same review. If a job is already
    // pending or running, point the caller at it instead of creating a
    // second one — workers in the second job would race against the first
    // on the same cells.
    const { data: existing } = await db
        .from("tabular_jobs")
        .select("id, total_items")
        .eq("review_id", reviewId)
        .in("status", ["pending", "running"])
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
    if (existing) {
        return void res.json({
            jobId: existing.id,
            totalItems: existing.total_items,
            resumed: true,
        });
    }

    // Resolve the docs list — same logic as before. Either the docs that
    // already have cells (re-run case) or every doc in the project.
    const { data: cells } = await db
        .from("tabular_cells")
        .select("document_id")
        .eq("review_id", reviewId);
    const docIdsFromCells = [
        ...new Set((cells ?? []).map((c) => c.document_id as string)),
    ];

    let accessibleDocIds: string[];
    if (docIdsFromCells.length > 0) {
        const { data } = await db
            .from("documents")
            .select("id, user_id, project_id")
            .in("id", docIdsFromCells);
        const accessible = await filterAccessibleDocuments(
            (data ?? []) as (Record<string, unknown> & AccessDocRow)[],
            userId,
            userEmail,
            db,
        );
        accessibleDocIds = accessible.map((d) => d.id);
    } else if (review.project_id) {
        const { data } = await db
            .from("documents")
            .select("id, user_id, project_id")
            .eq("project_id", review.project_id)
            .order("created_at", { ascending: true });
        const accessible = await filterAccessibleDocuments(
            (data ?? []) as (Record<string, unknown> & AccessDocRow)[],
            userId,
            userEmail,
            db,
        );
        accessibleDocIds = accessible.map((d) => d.id);
    } else {
        accessibleDocIds = [];
    }

    if (accessibleDocIds.length === 0) {
        return void res.status(400).json({ detail: "No documents to process" });
    }

    const result = await createGenerateJob({
        db,
        reviewId,
        userId,
        documentIds: accessibleDocIds,
    });
    if ("error" in result) {
        console.error("[tabular/generate] job creation failed", result.error);
        return void res.status(500).json({ detail: result.error });
    }

    res.json({
        jobId: result.jobId,
        totalItems: result.totalItems,
        resumed: false,
    });
});

// POST /tabular-review/:reviewId/reprocess-column
//
// feat-021 — wipes the named column's cells back to pending and creates a
// tabular_jobs run scoped to those cells. Reuses the bug-007 worker pool
// (the worker's existing "skip done cells" filter naturally picks up the
// wiped cells; see processOneJobItem in lib/tabularJobs.ts). Returns the
// jobId so the frontend can poll the same way as /generate.
tabularRouter.post(
    "/:reviewId/reprocess-column",
    requireAuth,
    async (req, res) => {
        const userId = res.locals.userId as string;
        const userEmail = res.locals.userEmail as string | undefined;
        const { reviewId } = req.params;
        const columnIndex =
            typeof req.body?.columnIndex === "number"
                ? req.body.columnIndex
                : NaN;
        if (!Number.isFinite(columnIndex) || columnIndex < 0) {
            return void res
                .status(400)
                .json({ detail: "columnIndex (number) is required" });
        }

        const db = createServerSupabase();
        const { data: review } = await db
            .from("tabular_reviews")
            .select("*")
            .eq("id", reviewId)
            .single();
        if (!review)
            return void res.status(404).json({ detail: "Review not found" });
        const access = await ensureReviewAccess(review, userId, userEmail, db);
        if (!access.ok)
            return void res.status(404).json({ detail: "Review not found" });

        const columns: { index: number }[] = review.columns_config ?? [];
        const found = columns.find((c) => c.index === columnIndex);
        if (!found)
            return void res
                .status(404)
                .json({ detail: "Column not found in this review" });

        // Refuse if a job is already in flight on this review — workers
        // would race against each other on the cells we're about to wipe.
        // User cancels or waits.
        const { data: existing } = await db
            .from("tabular_jobs")
            .select("id, status")
            .eq("review_id", reviewId)
            .in("status", ["pending", "running"])
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();
        if (existing) {
            return void res.status(409).json({
                detail: "A run is already in progress on this review.",
                inFlightJobId: existing.id,
            });
        }

        // Wipe the column's cells so the worker treats them as needing work.
        const { error: wipeErr } = await db
            .from("tabular_cells")
            .update({ status: "pending", content: null })
            .eq("review_id", reviewId)
            .eq("column_index", columnIndex);
        if (wipeErr) {
            console.error("[tabular/reprocess-column] wipe failed", wipeErr);
            return void res.status(500).json({ detail: wipeErr.message });
        }

        // Resolve docs the same way /generate does — either docs that
        // already have cells, or all project docs.
        const { data: cells } = await db
            .from("tabular_cells")
            .select("document_id")
            .eq("review_id", reviewId);
        const docIdsFromCells = [
            ...new Set((cells ?? []).map((c) => c.document_id as string)),
        ];
        let accessibleDocIds: string[];
        if (docIdsFromCells.length > 0) {
            const { data } = await db
                .from("documents")
                .select("id, user_id, project_id")
                .in("id", docIdsFromCells);
            const accessible = await filterAccessibleDocuments(
                (data ?? []) as (Record<string, unknown> & AccessDocRow)[],
                userId,
                userEmail,
                db,
            );
            accessibleDocIds = accessible.map((d) => d.id);
        } else if (review.project_id) {
            const { data } = await db
                .from("documents")
                .select("id, user_id, project_id")
                .eq("project_id", review.project_id)
                .order("created_at", { ascending: true });
            const accessible = await filterAccessibleDocuments(
                (data ?? []) as (Record<string, unknown> & AccessDocRow)[],
                userId,
                userEmail,
                db,
            );
            accessibleDocIds = accessible.map((d) => d.id);
        } else {
            accessibleDocIds = [];
        }
        if (accessibleDocIds.length === 0) {
            return void res
                .status(400)
                .json({ detail: "No documents to process" });
        }

        const result = await createGenerateJob({
            db,
            reviewId,
            userId,
            documentIds: accessibleDocIds,
        });
        if ("error" in result) {
            console.error(
                "[tabular/reprocess-column] job creation failed",
                result.error,
            );
            return void res.status(500).json({ detail: result.error });
        }
        res.json({
            jobId: result.jobId,
            totalItems: result.totalItems,
            columnIndex,
        });
    },
);

// DELETE /tabular-review/:reviewId/columns/:columnIndex
//
// feat-021 — removes a column from the review's columns_config and deletes
// every tabular_cells row for that column. Hard delete; no undo. Returns
// the updated columns_config so the frontend can rerender without an extra
// fetch.
tabularRouter.delete(
    "/:reviewId/columns/:columnIndex",
    requireAuth,
    async (req, res) => {
        const userId = res.locals.userId as string;
        const userEmail = res.locals.userEmail as string | undefined;
        const { reviewId } = req.params;
        const columnIndex = Number.parseInt(req.params.columnIndex, 10);
        if (!Number.isFinite(columnIndex) || columnIndex < 0) {
            return void res
                .status(400)
                .json({ detail: "columnIndex must be a non-negative integer" });
        }

        const db = createServerSupabase();
        const { data: review } = await db
            .from("tabular_reviews")
            .select("*")
            .eq("id", reviewId)
            .single();
        if (!review)
            return void res.status(404).json({ detail: "Review not found" });
        const access = await ensureReviewAccess(review, userId, userEmail, db);
        if (!access.ok)
            return void res.status(404).json({ detail: "Review not found" });

        const columns: { index: number }[] = review.columns_config ?? [];
        const found = columns.find((c) => c.index === columnIndex);
        if (!found)
            return void res
                .status(404)
                .json({ detail: "Column not found in this review" });

        const newColumns = columns.filter((c) => c.index !== columnIndex);

        const { error: cellsErr } = await db
            .from("tabular_cells")
            .delete()
            .eq("review_id", reviewId)
            .eq("column_index", columnIndex);
        if (cellsErr) {
            console.error("[tabular/delete-column] cells delete failed", cellsErr);
            return void res.status(500).json({ detail: cellsErr.message });
        }

        const { error: updErr } = await db
            .from("tabular_reviews")
            .update({ columns_config: newColumns })
            .eq("id", reviewId);
        if (updErr) {
            console.error("[tabular/delete-column] columns update failed", updErr);
            return void res.status(500).json({ detail: updErr.message });
        }

        res.json({ ok: true, columns_config: newColumns });
    },
);

// GET /tabular-review/reviews/:reviewId/active-job
//
// Returns the currently in-flight job for a review (status pending or
// running), if any. The frontend calls this on review-page mount to
// detect a run that's still happening — possibly started in another tab
// or before a backend restart — and resume polling without a fresh POST.
tabularRouter.get(
    "/reviews/:reviewId/active-job",
    requireAuth,
    async (req, res) => {
        const userId = res.locals.userId as string;
        const userEmail = res.locals.userEmail as string | undefined;
        const { reviewId } = req.params;
        const db = createServerSupabase();

        const { data: review } = await db
            .from("tabular_reviews")
            .select("id, user_id, shared_with, project_id")
            .eq("id", reviewId)
            .single();
        if (!review) return void res.status(404).json({ detail: "Not found" });
        const access = await ensureReviewAccess(review, userId, userEmail, db);
        if (!access.ok)
            return void res.status(404).json({ detail: "Not found" });

        const { data: job } = await db
            .from("tabular_jobs")
            .select("id, status, total_items, started_at, created_at")
            .eq("review_id", reviewId)
            .in("status", ["pending", "running"])
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();

        res.json({ job: job ?? null });
    },
);

// GET /tabular-review/jobs/:jobId
//
// Status snapshot for the progress bar. completed_items / error_items /
// skipped_items computed from the items table on demand — no race-prone
// counter columns to keep in sync.
tabularRouter.get("/jobs/:jobId", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { jobId } = req.params;
    const db = createServerSupabase();

    const { data: job } = await db
        .from("tabular_jobs")
        .select(
            "id, review_id, status, total_items, started_at, completed_at, cancel_requested_at, error, created_at, updated_at",
        )
        .eq("id", jobId)
        .single();
    if (!job) return void res.status(404).json({ detail: "Job not found" });

    // Access via parent review (RLS would also enforce this; we
    // double-check here for nicer 404 instead of empty response).
    const { data: review } = await db
        .from("tabular_reviews")
        .select("id, user_id, shared_with, project_id")
        .eq("id", job.review_id)
        .single();
    if (!review) return void res.status(404).json({ detail: "Job not found" });
    const access = await ensureReviewAccess(review, userId, userEmail, db);
    if (!access.ok)
        return void res.status(404).json({ detail: "Job not found" });

    // Counts from the items table — single grouped query.
    const { data: itemRows } = await db
        .from("tabular_job_items")
        .select("status")
        .eq("job_id", jobId);
    const counts = {
        pending: 0,
        running: 0,
        completed: 0,
        error: 0,
        skipped: 0,
    };
    for (const row of (itemRows ?? []) as { status: keyof typeof counts }[]) {
        if (row.status in counts) counts[row.status] += 1;
    }

    res.json({
        ...job,
        completed_items: counts.completed,
        error_items: counts.error,
        skipped_items: counts.skipped,
        running_items: counts.running,
        pending_items: counts.pending,
    });
});

// GET /tabular-review/jobs/:jobId/cells?since=<iso>
//
// Incremental cell payload for the frontend poll loop. Returns cells for
// items that completed since `since`; the frontend tracks the most recent
// completed_at it has seen and feeds it back as the next `since`. Cells
// for in-flight (status=running) items aren't returned until the item
// finishes — matches the user's mental model that a doc's whole row of
// cells appears together when its turn finishes.
tabularRouter.get("/jobs/:jobId/cells", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { jobId } = req.params;
    const since =
        typeof req.query.since === "string" ? req.query.since : "1970-01-01";
    const db = createServerSupabase();

    const { data: job } = await db
        .from("tabular_jobs")
        .select("id, review_id")
        .eq("id", jobId)
        .single();
    if (!job) return void res.status(404).json({ detail: "Job not found" });

    const { data: review } = await db
        .from("tabular_reviews")
        .select("id, user_id, shared_with, project_id")
        .eq("id", job.review_id)
        .single();
    if (!review) return void res.status(404).json({ detail: "Job not found" });
    const access = await ensureReviewAccess(review, userId, userEmail, db);
    if (!access.ok)
        return void res.status(404).json({ detail: "Job not found" });

    const { data: itemsCompletedSince } = await db
        .from("tabular_job_items")
        .select("document_id, completed_at, status")
        .eq("job_id", jobId)
        .not("completed_at", "is", null)
        .gt("completed_at", since)
        .order("completed_at", { ascending: true });

    const docIds = [
        ...new Set(
            (itemsCompletedSince ?? []).map(
                (it) => it.document_id as string,
            ),
        ),
    ];
    if (docIds.length === 0) {
        return void res.json({ cells: [], lastCompletedAt: since });
    }

    const { data: cells } = await db
        .from("tabular_cells")
        .select("document_id, column_index, content, status")
        .eq("review_id", job.review_id)
        .in("document_id", docIds);

    const lastCompletedAt = (
        itemsCompletedSince as { completed_at: string }[] | null
    )?.at(-1)?.completed_at ?? since;

    res.json({
        cells: cells ?? [],
        lastCompletedAt,
    });
});

// POST /tabular-review/jobs/:jobId/cancel
//
// Soft cancel — sets cancel_requested_at; workers check between items
// and skip the rest. In-flight items finish their LLM call naturally
// (no abort signals threaded through). Returns the new job snapshot
// so the frontend can stop polling once status flips.
tabularRouter.post("/jobs/:jobId/cancel", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { jobId } = req.params;
    const db = createServerSupabase();

    const { data: job } = await db
        .from("tabular_jobs")
        .select("id, review_id, status")
        .eq("id", jobId)
        .single();
    if (!job) return void res.status(404).json({ detail: "Job not found" });

    const { data: review } = await db
        .from("tabular_reviews")
        .select("id, user_id, shared_with, project_id")
        .eq("id", job.review_id)
        .single();
    if (!review) return void res.status(404).json({ detail: "Job not found" });
    const access = await ensureReviewAccess(review, userId, userEmail, db);
    if (!access.ok)
        return void res.status(404).json({ detail: "Job not found" });

    if (job.status === "completed" || job.status === "cancelled") {
        return void res.json({ id: job.id, status: job.status });
    }

    await db
        .from("tabular_jobs")
        .update({
            cancel_requested_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
        })
        .eq("id", jobId);

    res.json({ id: jobId, status: job.status, cancel_requested: true });
});

// GET /tabular-review/:reviewId/chats — list chats (metadata only, no messages)
tabularRouter.get("/:reviewId/chats", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { reviewId } = req.params;
    const db = createServerSupabase();

    // Verify access (owner or shared-project member).
    const { data: review, error } = await db
        .from("tabular_reviews")
        .select("id, user_id, project_id")
        .eq("id", reviewId)
        .single();
    if (error || !review)
        return void res.status(404).json({ detail: "Review not found" });
    const access = await ensureReviewAccess(review, userId, userEmail, db);
    if (!access.ok)
        return void res.status(404).json({ detail: "Review not found" });

    // Show every member's chats for the review (collaborative), not just
    // the requester's. Per-chat access is gated above by review access.
    const { data: chats } = await db
        .from("tabular_review_chats")
        .select("id, title, created_at, updated_at, user_id")
        .eq("review_id", reviewId)
        .order("updated_at", { ascending: false });

    res.json(chats ?? []);
});

// DELETE /tabular-review/:reviewId/chats/:chatId — delete a single chat
tabularRouter.delete(
    "/:reviewId/chats/:chatId",
    requireAuth,
    async (req, res) => {
        const userId = res.locals.userId as string;
        const { chatId } = req.params;
        const db = createServerSupabase();
        // Owner-only delete — sibling collaborators shouldn't be able to wipe
        // each other's threads.
        const { error } = await db
            .from("tabular_review_chats")
            .delete()
            .eq("id", chatId)
            .eq("user_id", userId);
        if (error) return void res.status(500).json({ detail: error.message });
        res.status(204).send();
    },
);

// GET /tabular-review/:reviewId/chats/:chatId/messages — messages for a single chat
tabularRouter.get(
    "/:reviewId/chats/:chatId/messages",
    requireAuth,
    async (req, res) => {
        const userId = res.locals.userId as string;
        const userEmail = res.locals.userEmail as string | undefined;
        const { reviewId, chatId } = req.params;
        const db = createServerSupabase();

        const { data: review } = await db
            .from("tabular_reviews")
            .select("id, user_id, project_id")
            .eq("id", reviewId)
            .single();
        if (!review)
            return void res.status(404).json({ detail: "Review not found" });
        const access = await ensureReviewAccess(review, userId, userEmail, db);
        if (!access.ok)
            return void res.status(404).json({ detail: "Review not found" });

        const { data: chat, error: chatError } = await db
            .from("tabular_review_chats")
            .select("id, review_id")
            .eq("id", chatId)
            .single();
        if (chatError || !chat || chat.review_id !== reviewId)
            return void res.status(404).json({ detail: "Chat not found" });

        const { data: messages } = await db
            .from("tabular_review_chat_messages")
            .select("id, role, content, annotations, created_at")
            .eq("chat_id", chatId)
            .order("created_at", { ascending: true });

        res.json(messages ?? []);
    },
);

// ---------------------------------------------------------------------------
// Tabular citation parsing
// ---------------------------------------------------------------------------

type TabularParsedCitation = {
    ref: number;
    col_index: number;
    row_index: number;
    quote: string;
};

const TABULAR_CITATIONS_BLOCK_RE = /<CITATIONS>\s*([\s\S]*?)\s*<\/CITATIONS>/;

function parseTabularCitations(text: string): TabularParsedCitation[] {
    const match = text.match(TABULAR_CITATIONS_BLOCK_RE);
    if (!match) return [];
    try {
        return JSON.parse(match[1]) as TabularParsedCitation[];
    } catch {
        return [];
    }
}

function extractTabularAnnotations(
    fullText: string,
    tabularStore: TabularCellStore,
) {
    return parseTabularCitations(fullText).map((c) => ({
        type: "tabular_citation" as const,
        ref: c.ref,
        col_index: c.col_index,
        row_index: c.row_index,
        col_name:
            tabularStore.columns[c.col_index]?.name ?? `Col ${c.col_index}`,
        doc_name:
            tabularStore.documents[c.row_index]?.filename ??
            `Row ${c.row_index}`,
        quote: c.quote,
    }));
}

// ---------------------------------------------------------------------------
// Build messages for tabular chat
// ---------------------------------------------------------------------------

function buildTabularMessages(
    messages: ChatMessage[],
    tabularStore: TabularCellStore,
    reviewTitle: string,
): unknown[] {
    const docList = tabularStore.documents
        .map((d, i) => `- ROW:${i} "${d.filename}"`)
        .join("\n");
    const colList = tabularStore.columns
        .map((c, i) => `- COL:${i} "${c.name}"`)
        .join("\n");

    const systemContent = `You are Olava, an AI legal assistant. You are helping with the tabular review titled "${reviewTitle}".

The review extracts specific fields from multiple legal documents into a structured table.
You do NOT have the cell content yet — call read_table_cells to fetch the cells you need before answering.

DOCUMENTS (rows):
${docList || "- (none)"}

COLUMNS (fields):
${colList || "- (none)"}

TABULAR CITATION INSTRUCTIONS:
When you reference specific cell content, place a numbered marker [1], [2], etc. inline in your prose at the point of reference.

After your complete response, append a <CITATIONS> block containing a JSON array with one entry per marker:

<CITATIONS>
[
  {"ref": 1, "col_index": 0, "row_index": 2, "quote": "verbatim text from the cell"},
  {"ref": 2, "col_index": 1, "row_index": 0, "quote": "another excerpt"}
]
</CITATIONS>

Rules:
- col_index and row_index are 0-based (matching the COL/ROW numbers listed above)
- Only cite cells you have read via read_table_cells
- quote should be verbatim text from the cell's summary
- Omit <CITATIONS> if you make no citations
- Do not fabricate cell content
- Answer in clear, concise prose. You may use markdown formatting.`;

    const formatted: unknown[] = [{ role: "system", content: systemContent }];
    for (const msg of messages) {
        formatted.push({ role: msg.role, content: msg.content ?? "" });
    }
    return formatted;
}

// ---------------------------------------------------------------------------
// POST /tabular-review/:reviewId/chat — agentic streaming
// ---------------------------------------------------------------------------

// POST /tabular-review/:reviewId/chat
tabularRouter.post("/:reviewId/chat", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { reviewId } = req.params;
    const {
        messages,
        chat_id: existingChatId,
        review_title: clientReviewTitle,
        project_name: clientProjectName,
    } = req.body as {
        messages: ChatMessage[];
        chat_id?: string;
        review_title?: string;
        project_name?: string;
    };

    const lastUser = [...(messages ?? [])]
        .reverse()
        .find((m) => m.role === "user");
    if (!lastUser?.content?.trim()) {
        return void res
            .status(400)
            .json({ detail: "messages must include a user message" });
    }

    const db = createServerSupabase();
    const { data: review, error } = await db
        .from("tabular_reviews")
        .select("*")
        .eq("id", reviewId)
        .single();
    if (error || !review)
        return void res.status(404).json({ detail: "Review not found" });
    const reviewAccess = await ensureReviewAccess(
        review,
        userId,
        userEmail,
        db,
    );
    if (!reviewAccess.ok)
        return void res.status(404).json({ detail: "Review not found" });

    // Fetch all cells and documents for this review
    const { data: cells } = await db
        .from("tabular_cells")
        .select("*")
        .eq("review_id", reviewId);

    const docIds = [
        ...new Set((cells ?? []).map((c: any) => c.document_id as string)),
    ];
    let docs: { id: string; filename: string }[] = [];
    if (docIds.length > 0) {
        const { data } = await db
            .from("documents")
            .select("id, filename, user_id, project_id")
            .in("id", docIds)
            .order("created_at", { ascending: true });
        docs = await filterAccessibleDocuments(
            (data ?? []) as (AccessDocRow & { filename: string })[],
            userId,
            userEmail,
            db,
        );
    }
    const accessibleDocIds = new Set(docs.map((doc) => doc.id));

    const sortedColumns = (
        (review.columns_config ?? []) as { index: number; name: string }[]
    ).sort((a, b) => a.index - b.index);

    const tabularStore: TabularCellStore = {
        columns: sortedColumns,
        documents: docs,
        cells: new Map(
            (cells ?? [])
                .filter((c: any) => accessibleDocIds.has(c.document_id))
                .map((c: any) => [
                    `${c.column_index}:${c.document_id}`,
                    parseCellContent(c.content),
                ]),
        ),
    };

    // Create or verify chat record
    let chatId = existingChatId ?? null;
    let chatTitle: string | null = null;
    const isFirstExchange =
        messages.filter((m) => m.role === "user").length === 1;

    if (chatId) {
        // Either chat owner OR any project member of the parent review can
        // continue the chat. We've already verified review access above.
        const { data: existing } = await db
            .from("tabular_review_chats")
            .select("id, title, review_id, user_id")
            .eq("id", chatId)
            .single();
        const canUse =
            !!existing &&
            (existing.review_id === reviewId || existing.user_id === userId);
        if (!canUse || !existing) chatId = null;
        else chatTitle = existing.title;
    }

    if (!chatId) {
        const { data: newChat } = await db
            .from("tabular_review_chats")
            .insert({ review_id: reviewId, user_id: userId })
            .select("id, title")
            .single();
        chatId = newChat?.id ?? null;
        chatTitle = newChat?.title ?? null;
    }

    // Persist user message
    if (chatId) {
        await db.from("tabular_review_chat_messages").insert({
            chat_id: chatId,
            role: "user",
            content: lastUser.content,
        });
    }

    const apiMessages = buildTabularMessages(
        messages,
        tabularStore,
        review.title || "Untitled Review",
    );

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();
    const write = (line: string) => res.write(line);

    if (chatId) {
        write(`data: ${JSON.stringify({ type: "chat_id", chatId })}\n\n`);
    }

    const apiKeys = await getUserApiKeys(userId, db);

    try {
        const { fullText, events } = await runLLMStream({
            apiMessages,
            docStore: new Map(),
            docIndex: {},
            userId,
            db,
            write,
            extraTools: TABULAR_TOOLS,
            tabularStore,
            buildCitations: (text) =>
                extractTabularAnnotations(text, tabularStore),
            apiKeys,
        });

        const annotations = extractTabularAnnotations(fullText, tabularStore);

        if (chatId) {
            await db.from("tabular_review_chat_messages").insert({
                chat_id: chatId,
                role: "assistant",
                content: events.length ? events : null,
                annotations: annotations.length ? annotations : null,
            });
            await db
                .from("tabular_review_chats")
                .update({ updated_at: new Date().toISOString() })
                .eq("id", chatId);
        }

        // Generate title on first exchange
        if (chatId && isFirstExchange && !chatTitle && lastUser.content) {
            const { title_model } = await getUserModelSettings(userId, db);
            const title = await generateChatTitle(
                title_model,
                lastUser.content,
                {
                    reviewTitle: clientReviewTitle ?? review.title ?? null,
                    projectName: clientProjectName ?? null,
                },
                apiKeys,
            );
            if (title) {
                await db
                    .from("tabular_review_chats")
                    .update({ title })
                    .eq("id", chatId);
                write(
                    `data: ${JSON.stringify({ type: "chat_title", chatId, title })}\n\n`,
                );
            }
        }
    } catch (err) {
        console.error("[tabular/chat] error", err);
        try {
            write(
                `data: ${JSON.stringify({ type: "error", message: String(err) })}\n\n`,
            );
            write("data: [DONE]\n\n");
        } catch {
            /* ignore */
        }
    } finally {
        res.end();
    }
});

function parseCellContent(
    raw: unknown,
): { summary: string; flag?: string; reasoning?: string } | null {
    if (!raw) return null;
    if (typeof raw === "object" && raw !== null && "summary" in raw) {
        const c = raw as {
            summary?: unknown;
            flag?: unknown;
            reasoning?: unknown;
        };
        return {
            summary: String(c.summary ?? ""),
            flag: (["green", "grey", "yellow", "red"] as const).includes(
                c.flag as "green",
            )
                ? (c.flag as string)
                : undefined,
            reasoning: typeof c.reasoning === "string" ? c.reasoning : "",
        };
    }
    if (typeof raw === "string") {
        try {
            const p = JSON.parse(raw) as {
                summary?: unknown;
                value?: unknown;
                flag?: unknown;
                reasoning?: unknown;
            };
            return {
                summary: String(p.summary ?? p.value ?? "").trim(),
                flag: (["green", "grey", "yellow", "red"] as const).includes(
                    p.flag as "green",
                )
                    ? (p.flag as string)
                    : undefined,
                reasoning: typeof p.reasoning === "string" ? p.reasoning : "",
            };
        } catch {
            return { summary: raw, flag: "grey", reasoning: "" };
        }
    }
    return null;
}

// bug-007 — queryGemini, queryGeminiAllColumns, extractPdfMarkdown,
// extractDocxMarkdown, formatPromptSuffix, Column, CellResult moved to
// lib/tabularJobs.ts so the worker pool doesn't import this route file
// (avoids a circular import). queryGemini is still imported above for
// the per-cell regenerate route.

async function generateChatTitle(
    model: string,
    firstUserMessage: string,
    context?: { reviewTitle?: string | null; projectName?: string | null },
    apiKeys?: import("../lib/llm").UserApiKeys,
): Promise<string | null> {
    try {
        const contextLines: string[] = [];
        if (context?.projectName)
            contextLines.push(`Project: ${context.projectName}`);
        if (context?.reviewTitle)
            contextLines.push(`Tabular review: ${context.reviewTitle}`);
        const contextBlock = contextLines.length
            ? `This chat is in the context of a tabular review.\n${contextLines.join("\n")}\n\n`
            : "";

        const raw = await completeText({
            model,
            user: `${contextBlock}Generate a short title (4-6 words) for a chat that starts with the message below. The title should reflect the user's specific question, not the review or project name. Return only the title, no punctuation, no quotes:\n\n${firstUserMessage}`,
            maxTokens: 64,
            apiKeys,
        });
        return raw.trim().slice(0, 80) || null;
    } catch {
        return null;
    }
}

function buildTabularContext(
    columns: any[],
    docs: any[],
    cells: any[],
): string {
    const lines: string[] = [
        "# Tabular Review Context\n",
        "Columns (0-based index):",
    ];
    columns.forEach((col: any, i: number) =>
        lines.push(`- COL:${i} → "${col.name}"`),
    );
    lines.push("", "Documents (0-based row index):");
    docs.forEach((doc: any, i: number) =>
        lines.push(`- ROW:${i} → "${doc.filename}"`),
    );
    lines.push("", "## Table Data\n");
    lines.push(`| Document | ${columns.map((c: any) => c.name).join(" | ")} |`);
    lines.push(`|---|${columns.map(() => "---").join("|")}|`);
    docs.forEach((doc: any, rowIdx: number) => {
        const rowCells = columns.map((col: any, colPos: number) => {
            const cell = cells.find(
                (c: any) =>
                    c.document_id === doc.id && c.column_index === col.index,
            ) as any;
            if (
                !cell ||
                cell.status === "pending" ||
                cell.status === "generating"
            ) {
                return `(pending) [[COL:${colPos}||ROW:${rowIdx}]]`;
            }
            if (cell.status === "error") {
                return `(error) [[COL:${colPos}||ROW:${rowIdx}]]`;
            }
            const content = parseCellContent(cell.content);
            const summary = content?.summary?.trim() || "(not yet generated)";
            const truncated =
                summary.length > 400 ? summary.slice(0, 400) + "…" : summary;
            return `${truncated} [[COL:${colPos}||ROW:${rowIdx}]]`;
        });
        lines.push(
            `| ROW:${rowIdx} ${doc.filename} | ${rowCells.join(" | ")} |`,
        );
    });
    return lines.join("\n");
}

// bug-007 — extractPdfMarkdown / extractDocxMarkdown / queryGeminiAllColumns
// moved to lib/tabularJobs.ts.
