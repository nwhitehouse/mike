import { test } from "node:test";
import assert from "node:assert/strict";
import {
    cellMatches,
    computeVisibleDocIds,
    type TRFilter,
} from "../src/app/components/tabular/trFilterPredicate";
import type { TabularCell } from "../src/app/components/shared/types";

function makeCell(overrides: Partial<TabularCell> = {}): TabularCell {
    return {
        id: "c-1",
        review_id: "r-1",
        document_id: "doc-1",
        column_index: 0,
        content: { summary: "Yes — applies to subloan refinancings", flag: "green" },
        status: "done",
        created_at: "2026-05-07T00:00:00Z",
        verified: false,
        ...overrides,
    };
}

test("flag filter matches cells whose flag is in the selected set", () => {
    const cell = makeCell({ content: { summary: "x", flag: "red" } });
    const f: TRFilter = { kind: "flag", flags: ["red", "yellow"] };
    assert.equal(cellMatches(cell, f), true);
});

test("flag filter does not match cells outside the selected set", () => {
    const cell = makeCell({ content: { summary: "x", flag: "green" } });
    const f: TRFilter = { kind: "flag", flags: ["red"] };
    assert.equal(cellMatches(cell, f), false);
});

test("flag filter treats missing flag as 'grey'", () => {
    const cell = makeCell({ content: { summary: "x" } });
    const f: TRFilter = { kind: "flag", flags: ["grey"] };
    assert.equal(cellMatches(cell, f), true);
});

test("verified filter — verified state matches verified cells only", () => {
    const verifiedCell = makeCell({ verified: true });
    const unverifiedCell = makeCell({ verified: false });
    const f: TRFilter = { kind: "verified", state: "verified" };
    assert.equal(cellMatches(verifiedCell, f), true);
    assert.equal(cellMatches(unverifiedCell, f), false);
});

test("text 'contains' is case-insensitive and trim-tolerant", () => {
    const cell = makeCell({
        content: { summary: "  Indemnification clause excludes IP  " },
    });
    const f: TRFilter = {
        kind: "text",
        columnIndex: 0,
        operator: "contains",
        value: "INDEMNIFICATION",
    };
    assert.equal(cellMatches(cell, f), true);
});

test("text 'is_empty' fires for whitespace-only summaries", () => {
    const cell = makeCell({ content: { summary: "    " } });
    const f: TRFilter = {
        kind: "text",
        columnIndex: 0,
        operator: "is_empty",
        value: "",
    };
    assert.equal(cellMatches(cell, f), true);
});

test("text predicate scoped to its columnIndex — other columns silently ignored", () => {
    const cell = makeCell({
        column_index: 5,
        content: { summary: "match" },
    });
    const f: TRFilter = {
        kind: "text",
        columnIndex: 0,
        operator: "contains",
        value: "match",
    };
    assert.equal(cellMatches(cell, f), false);
});

test("computeVisibleDocIds — flag filter unions across a doc's cells", () => {
    const docs = ["doc-1", "doc-2"];
    const cells: TabularCell[] = [
        makeCell({ document_id: "doc-1", column_index: 0, content: { summary: "a", flag: "green" } }),
        makeCell({ document_id: "doc-1", column_index: 1, content: { summary: "b", flag: "red" } }),
        makeCell({ document_id: "doc-2", column_index: 0, content: { summary: "c", flag: "green" } }),
    ];
    const visible = computeVisibleDocIds(docs, cells, [
        { kind: "flag", flags: ["red"] },
    ]);
    // doc-1 has at least one red cell; doc-2 has none.
    assert.deepEqual([...visible], ["doc-1"]);
});

test("computeVisibleDocIds — text filter requires the *specific column's* cell to match", () => {
    const docs = ["doc-1", "doc-2"];
    const cells: TabularCell[] = [
        makeCell({ document_id: "doc-1", column_index: 0, content: { summary: "yes" } }),
        makeCell({ document_id: "doc-1", column_index: 1, content: { summary: "no" } }),
        makeCell({ document_id: "doc-2", column_index: 0, content: { summary: "no" } }),
        makeCell({ document_id: "doc-2", column_index: 1, content: { summary: "yes" } }),
    ];
    const visible = computeVisibleDocIds(docs, cells, [
        { kind: "text", columnIndex: 0, operator: "contains", value: "yes" },
    ]);
    assert.deepEqual([...visible], ["doc-1"]);
});

test("computeVisibleDocIds — empty filters returns every doc", () => {
    const docs = ["doc-1", "doc-2"];
    const visible = computeVisibleDocIds(docs, [], []);
    assert.deepEqual([...visible].sort(), docs);
});

test("computeVisibleDocIds — multiple filters AND together", () => {
    const docs = ["doc-1", "doc-2"];
    const cells: TabularCell[] = [
        makeCell({ document_id: "doc-1", column_index: 0, content: { summary: "yes", flag: "green" }, verified: true }),
        makeCell({ document_id: "doc-2", column_index: 0, content: { summary: "yes", flag: "green" }, verified: false }),
    ];
    const visible = computeVisibleDocIds(docs, cells, [
        { kind: "verified", state: "verified" },
        { kind: "text", columnIndex: 0, operator: "contains", value: "yes" },
    ]);
    assert.deepEqual([...visible], ["doc-1"]);
});
