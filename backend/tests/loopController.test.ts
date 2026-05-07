import { test } from "node:test";
import assert from "node:assert/strict";
import { LoopController, escalationNote } from "../src/lib/loopController";

test("MAX_STEPS_EXCEEDED fires at the threshold", () => {
    const c = new LoopController({ maxSteps: 3, maxRepeatedCalls: 99, wallClockMs: 60_000 });
    c.recordStep("read_document", '{"doc_id":"doc-1"}');
    c.recordStep("read_document", '{"doc_id":"doc-2"}');
    assert.equal(c.shouldEscalate(), null);
    c.recordStep("read_document", '{"doc_id":"doc-3"}');
    const esc = c.shouldEscalate();
    assert.equal(esc?.reason, "MAX_STEPS_EXCEEDED");
    assert.equal(esc?.step, 3);
});

test("REPEATED_TOOL_CALL fires when same call repeats N times", () => {
    const c = new LoopController({ maxSteps: 99, maxRepeatedCalls: 3, wallClockMs: 60_000 });
    const args = '{"doc_id":"doc-1"}';
    c.recordStep("read_document", args);
    c.recordStep("read_document", args);
    assert.equal(c.shouldEscalate(), null);
    c.recordStep("read_document", args);
    const esc = c.shouldEscalate();
    assert.equal(esc?.reason, "REPEATED_TOOL_CALL");
    assert.equal(esc?.detail, "read_document");
});

test("REPEATED_TOOL_CALL does NOT fire when args differ", () => {
    const c = new LoopController({ maxSteps: 99, maxRepeatedCalls: 3, wallClockMs: 60_000 });
    c.recordStep("read_document", '{"doc_id":"doc-1"}');
    c.recordStep("read_document", '{"doc_id":"doc-2"}');
    c.recordStep("read_document", '{"doc_id":"doc-3"}');
    assert.equal(c.shouldEscalate(), null);
});

test("WALL_CLOCK_EXCEEDED fires when budget elapses", () => {
    let t = 1_000;
    const c = new LoopController({
        maxSteps: 99,
        maxRepeatedCalls: 99,
        wallClockMs: 500,
        now: () => t,
    });
    c.recordStep("read_document", "{}");
    assert.equal(c.shouldEscalate(), null);
    t = 1_600; // 600ms later — past the 500ms budget
    const esc = c.shouldEscalate();
    assert.equal(esc?.reason, "WALL_CLOCK_EXCEEDED");
});

test("currentStep reflects total dispatches", () => {
    const c = new LoopController({ maxSteps: 99, maxRepeatedCalls: 99 });
    assert.equal(c.currentStep, 0);
    c.recordStep("a", "{}");
    c.recordStep("b", "{}");
    assert.equal(c.currentStep, 2);
});

test("escalationNote contains the reason", () => {
    const note = escalationNote({ reason: "MAX_STEPS_EXCEEDED", step: 12 });
    assert.match(note, /budget exceeded/i);
    assert.match(note, /12 tool calls/);
});

test("escalationNote names the tool for REPEATED_TOOL_CALL", () => {
    const note = escalationNote({
        reason: "REPEATED_TOOL_CALL",
        step: 3,
        detail: "read_document",
    });
    assert.match(note, /read_document/);
});
