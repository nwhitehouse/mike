/**
 * feat-014 — Loop controller. Bounds the agent's tool-call loop in
 * runLLMStream so a misbehaving LLM (stuck in a retry, looping on a
 * failing tool, taking forever) can't burn unbounded compute.
 *
 * Three escalation triggers — first one wins:
 *   1. MAX_STEPS_EXCEEDED   — total tool dispatches in this turn >= maxSteps
 *   2. REPEATED_TOOL_CALL   — same tool + same args called maxRepeatedCalls
 *                             times in a row (proxy for "model retrying
 *                             because tool keeps failing or is being ignored")
 *   3. WALL_CLOCK_EXCEEDED  — wall-clock since constructor > wallClockMs
 *
 * Independent of the chat code so it's straightforward to unit-test.
 * Integration in chatTools.ts: after each runToolCalls dispatch, call
 * recordStep() per call and then shouldEscalate(). On escalation, the
 * caller emits a loop.escalated agent_events row (feat-015) and appends
 * a "stop calling tools and synthesise" note to the tool results so the
 * LLM produces a final answer on the next iteration instead of calling
 * more tools.
 *
 * Defaults are tuned for Finch's typical chat shape (1–3 tool calls per
 * turn). Override per env (OLAVA_MAX_STEPS, OLAVA_MAX_REPEATED_CALLS,
 * OLAVA_WALL_CLOCK_MS) when tuning a deployment without a code change.
 */

export type EscalationReason =
    | "MAX_STEPS_EXCEEDED"
    | "REPEATED_TOOL_CALL"
    | "WALL_CLOCK_EXCEEDED";

export type Escalation = {
    reason: EscalationReason;
    step: number;
    /** Tool name for REPEATED_TOOL_CALL; undefined otherwise. */
    detail?: string;
};

export type LoopControllerOptions = {
    maxSteps?: number;
    maxRepeatedCalls?: number;
    wallClockMs?: number;
    /** Injected for tests so we can advance time deterministically. */
    now?: () => number;
};

const DEFAULT_MAX_STEPS = 12;
const DEFAULT_MAX_REPEATED_CALLS = 3;
const DEFAULT_WALL_CLOCK_MS = 60_000;

function readEnvInt(name: string, fallback: number): number {
    const raw = process.env[name];
    if (!raw) return fallback;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

export class LoopController {
    private step = 0;
    private startedAt: number;
    private callCounts = new Map<string, number>();
    private maxSteps: number;
    private maxRepeatedCalls: number;
    private wallClockMs: number;
    private now: () => number;

    constructor(opts: LoopControllerOptions = {}) {
        this.maxSteps =
            opts.maxSteps ?? readEnvInt("OLAVA_MAX_STEPS", DEFAULT_MAX_STEPS);
        this.maxRepeatedCalls =
            opts.maxRepeatedCalls ??
            readEnvInt("OLAVA_MAX_REPEATED_CALLS", DEFAULT_MAX_REPEATED_CALLS);
        this.wallClockMs =
            opts.wallClockMs ??
            readEnvInt("OLAVA_WALL_CLOCK_MS", DEFAULT_WALL_CLOCK_MS);
        this.now = opts.now ?? Date.now;
        this.startedAt = this.now();
    }

    /**
     * Record one tool dispatch. argsJson should be the literal JSON args the
     * model produced — matched as a string so semantically-equivalent JSON
     * with different whitespace still trips the repeat detector for the
     * common LLM-emits-the-same-call case.
     */
    recordStep(toolName: string, argsJson: string): void {
        this.step += 1;
        const key = `${toolName}::${argsJson}`;
        this.callCounts.set(key, (this.callCounts.get(key) ?? 0) + 1);
    }

    /**
     * Returns the first escalation that's currently true, or null. Caller
     * should check after each recordStep batch and act on a non-null return
     * before letting the LLM iterate again.
     */
    shouldEscalate(): Escalation | null {
        if (this.now() - this.startedAt > this.wallClockMs) {
            return { reason: "WALL_CLOCK_EXCEEDED", step: this.step };
        }
        if (this.step >= this.maxSteps) {
            return { reason: "MAX_STEPS_EXCEEDED", step: this.step };
        }
        for (const [key, count] of this.callCounts) {
            if (count >= this.maxRepeatedCalls) {
                return {
                    reason: "REPEATED_TOOL_CALL",
                    step: this.step,
                    detail: key.split("::")[0],
                };
            }
        }
        return null;
    }

    get currentStep(): number {
        return this.step;
    }
}

/**
 * Human-readable note appended to every tool result in a batch when the
 * controller escalates. Tells the LLM to stop calling tools and produce a
 * final synthesis from what it has. Plain-text on purpose — Olava-001
 * follows direct instructions inside tool results well.
 */
export function escalationNote(esc: Escalation): string {
    const why =
        esc.reason === "MAX_STEPS_EXCEEDED"
            ? `You have used ${esc.step} tool calls this turn — the per-turn budget.`
            : esc.reason === "REPEATED_TOOL_CALL"
                ? `You have called \`${esc.detail ?? "the same tool"}\` with the same arguments multiple times.`
                : "This turn has run for too long.";
    return (
        `\n\n[Loop budget exceeded: ${why} ` +
        "Stop calling tools and synthesise the best answer you can from what you have already gathered. " +
        "If you cannot answer, say so plainly — do not retry.]"
    );
}
