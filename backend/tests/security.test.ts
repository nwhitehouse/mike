import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
    buildDownloadUrl,
    isDownloadSigningConfigured,
    signDownload,
    verifyDownload,
} from "../src/lib/downloadTokens";
import { ensureProjectIdIsAccessibleForCreate } from "../src/lib/access";
import { isOriginAllowed, parseAllowedOrigins } from "../src/lib/httpSecurity";
import { uploadConcurrencyLimit } from "../src/lib/upload";
import { requireAccessibleDocumentIds } from "../src/routes/tabular";
import { safeMarkdownUrl } from "../../frontend/src/lib/safeMarkdown";

const originalEnv = { ...process.env };

test.afterEach(() => {
    process.env = { ...originalEnv };
});

function fakeProjectDb(projects: Record<string, unknown>) {
    return {
        from(table: string) {
            assert.equal(table, "projects");
            let id = "";
            return {
                select() {
                    return this;
                },
                eq(column: string, value: string) {
                    assert.equal(column, "id");
                    id = value;
                    return this;
                },
                async single() {
                    return { data: projects[id] ?? null };
                },
            };
        },
    } as never;
}

function fakeDocumentAccessDb(
    documents: Record<string, unknown>,
    projects: Record<string, unknown>,
) {
    return {
        from(table: string) {
            if (table === "documents") {
                let ids: string[] = [];
                return {
                    select() {
                        return this;
                    },
                    in(column: string, value: string[]) {
                        assert.equal(column, "id");
                        ids = value;
                        return this;
                    },
                    then(resolve: (value: unknown) => void) {
                        resolve({
                            data: ids
                                .map((id) => documents[id])
                                .filter(Boolean),
                            error: null,
                        });
                    },
                };
            }

            assert.equal(table, "projects");
            let id = "";
            return {
                select() {
                    return this;
                },
                eq(column: string, value: string) {
                    assert.equal(column, "id");
                    id = value;
                    return this;
                },
                async single() {
                    return { data: projects[id] ?? null };
                },
            };
        },
    } as never;
}

test("download tokens require an explicit strong signing secret", () => {
    delete process.env.DOWNLOAD_SIGNING_SECRET;
    delete process.env.SUPABASE_SECRET_KEY;

    assert.equal(isDownloadSigningConfigured(), false);
    assert.throws(
        () => signDownload("documents/user/doc/file.docx", "file.docx"),
        /DOWNLOAD_SIGNING_SECRET/,
    );
    assert.equal(verifyDownload("forged.token"), null);
});

test("download tokens reject forged payloads", () => {
    process.env.DOWNLOAD_SIGNING_SECRET = "x".repeat(32);
    const token = signDownload("documents/user/doc/file.docx", "file.docx");
    const [payload] = token.split(".");
    const forgedPayload = Buffer.from(
        JSON.stringify({ p: "documents/other/doc/file.docx", f: "file.docx" }),
    )
        .toString("base64url");

    assert.deepEqual(verifyDownload(token), {
        path: "documents/user/doc/file.docx",
        filename: "file.docx",
    });
    assert.equal(verifyDownload(`${forgedPayload}.${token.split(".")[1]}`), null);
    assert.match(buildDownloadUrl("a", "b"), /^\/download\/.+\..+$/);
    assert.notEqual(payload, forgedPayload);
});

test("chat creation rejects inaccessible project ids", async () => {
    const db = fakeProjectDb({
        own: { id: "own", user_id: "user-1", shared_with: [] },
        shared: {
            id: "shared",
            user_id: "user-2",
            shared_with: ["user@example.com"],
        },
        foreign: { id: "foreign", user_id: "user-2", shared_with: [] },
    });

    assert.deepEqual(
        await ensureProjectIdIsAccessibleForCreate(
            null,
            "user-1",
            "user@example.com",
            db,
        ),
        { ok: true, projectId: null },
    );
    assert.deepEqual(
        await ensureProjectIdIsAccessibleForCreate(
            "own",
            "user-1",
            "user@example.com",
            db,
        ),
        { ok: true, projectId: "own" },
    );
    assert.deepEqual(
        await ensureProjectIdIsAccessibleForCreate(
            "shared",
            "user-1",
            "user@example.com",
            db,
        ),
        { ok: true, projectId: "shared" },
    );
    assert.deepEqual(
        await ensureProjectIdIsAccessibleForCreate(
            "foreign",
            "user-1",
            "user@example.com",
            db,
        ),
        { ok: false },
    );
});

test("tabular reviews reject inaccessible document ids", async () => {
    const db = fakeDocumentAccessDb(
        {
            ownDoc: {
                id: "ownDoc",
                user_id: "user-1",
                project_id: null,
            },
            sharedDoc: {
                id: "sharedDoc",
                user_id: "user-2",
                project_id: "sharedProject",
            },
            foreignDoc: {
                id: "foreignDoc",
                user_id: "user-2",
                project_id: null,
            },
        },
        {
            sharedProject: {
                id: "sharedProject",
                user_id: "user-2",
                shared_with: ["user@example.com"],
            },
        },
    );

    assert.deepEqual(
        await requireAccessibleDocumentIds(
            ["ownDoc", "sharedDoc"],
            "user-1",
            "user@example.com",
            db,
        ),
        { ok: true, ids: ["ownDoc", "sharedDoc"] },
    );
    assert.deepEqual(
        await requireAccessibleDocumentIds(
            ["ownDoc", "foreignDoc"],
            "user-1",
            "user@example.com",
            db,
        ),
        { ok: false },
    );
});

test("CORS is explicit in production and local in development", () => {
    const prodOrigins = parseAllowedOrigins({
        NODE_ENV: "production",
        FRONTEND_URL: "https://app.example.com",
        ADDITIONAL_CORS_ORIGINS: "https://preview.example.com",
    } as NodeJS.ProcessEnv);

    assert.equal(isOriginAllowed(undefined, prodOrigins), true);
    assert.equal(isOriginAllowed("https://app.example.com", prodOrigins), true);
    assert.equal(isOriginAllowed("https://random.vercel.app", prodOrigins), false);

    const devOrigins = parseAllowedOrigins({
        NODE_ENV: "development",
    } as NodeJS.ProcessEnv);
    assert.equal(isOriginAllowed("http://localhost:9000", devOrigins), true);
});

test("upload concurrency limiter returns 429 after the configured limit", () => {
    process.env.MAX_CONCURRENT_UPLOADS = "1";
    const firstRes = new EventEmitter() as EventEmitter & {
        status: (code: number) => unknown;
        json: (body: unknown) => unknown;
    };
    firstRes.status = () => firstRes;
    firstRes.json = () => firstRes;

    let firstNext = false;
    uploadConcurrencyLimit({} as never, firstRes as never, () => {
        firstNext = true;
    });
    assert.equal(firstNext, true);

    let statusCode = 0;
    const secondRes = new EventEmitter() as EventEmitter & {
        status: (code: number) => unknown;
        json: (body: unknown) => unknown;
    };
    secondRes.status = (code: number) => {
        statusCode = code;
        return secondRes;
    };
    secondRes.json = () => secondRes;
    uploadConcurrencyLimit({} as never, secondRes as never, () => {
        throw new Error("second request should be rate limited");
    });
    assert.equal(statusCode, 429);

    firstRes.emit("finish");
});

test("markdown URL sanitizer blocks scriptable URLs", () => {
    assert.equal(safeMarkdownUrl("javascript:alert(1)"), "");
    assert.equal(safeMarkdownUrl("JaVaScRiPt:alert(1)"), "");
    assert.equal(safeMarkdownUrl("data:text/html,<script>x</script>"), "");
    assert.equal(safeMarkdownUrl("https://example.com/path"), "https://example.com/path");
    assert.equal(safeMarkdownUrl("/internal/path"), "/internal/path");
});

test("Claude adapter does not persist raw stream logs", () => {
    const source = fs.readFileSync(
        path.resolve(process.cwd(), "src/lib/llm/claude.ts"),
        "utf8",
    );
    assert.doesNotMatch(source, /appendFile|createWriteStream|claude-raw-stream/);
    assert.equal(
        fs.existsSync(path.resolve(process.cwd(), "claude-raw-stream.log")),
        false,
    );
});

test("RLS migration covers tenant-sensitive tables", () => {
    const migration = fs.readFileSync(
        path.resolve(
            process.cwd(),
            "migrations/002_enable_rls_tenant_tables.sql",
        ),
        "utf8",
    );
    for (const table of [
        "projects",
        "documents",
        "document_versions",
        "document_edits",
        "chats",
        "chat_messages",
        "tabular_reviews",
        "tabular_cells",
        "workflows",
        "workflow_shares",
    ]) {
        assert.match(
            migration,
            new RegExp(`alter table public\\.${table} enable row level security`),
        );
    }
});
