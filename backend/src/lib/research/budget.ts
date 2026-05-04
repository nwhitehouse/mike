// Hard-cap enforcement for the multi-pass research orchestrator.
//
// Two limits, both per-turn:
//   - Olava call count   (default 25, env: RESEARCH_MAX_OLAVA_CALLS)
//   - Wall-clock seconds (default 45, env: RESEARCH_MAX_WALLCLOCK_S)
//
// Callers wrap each Olava request through `tryConsumeCall()` and check
// `wallClockExpired()` before starting any new pass. When either trips, the
// budget object exposes which cap and the orchestrator surfaces a
// `research.cap_hit` SSE event then degrades gracefully (returns whatever
// has been synthesised so far rather than aborting).

const DEFAULT_MAX_CALLS = 25;
const DEFAULT_MAX_WALLCLOCK_S = 45;

function readIntEnv(name: string, defaultValue: number): number {
    const raw = process.env[name]?.trim();
    if (!raw) return defaultValue;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : defaultValue;
}

export class ResearchBudget {
    private callsUsed = 0;
    private readonly startMs: number;
    private readonly maxCalls: number;
    private readonly maxWallMs: number;
    private capHit: "calls" | "wallclock" | null = null;

    constructor() {
        this.startMs = Date.now();
        this.maxCalls = readIntEnv("RESEARCH_MAX_OLAVA_CALLS", DEFAULT_MAX_CALLS);
        this.maxWallMs =
            readIntEnv("RESEARCH_MAX_WALLCLOCK_S", DEFAULT_MAX_WALLCLOCK_S) *
            1000;
    }

    /** Returns true if a new Olava call is allowed. Increments the counter on success. */
    tryConsumeCall(): boolean {
        if (this.capHit) return false;
        if (this.callsUsed >= this.maxCalls) {
            this.capHit = "calls";
            return false;
        }
        if (Date.now() - this.startMs >= this.maxWallMs) {
            this.capHit = "wallclock";
            return false;
        }
        this.callsUsed += 1;
        return true;
    }

    /** Cheap guard used between passes — checks wall-clock without consuming a call. */
    wallClockExpired(): boolean {
        if (this.capHit) return true;
        if (Date.now() - this.startMs >= this.maxWallMs) {
            this.capHit = "wallclock";
            return true;
        }
        return false;
    }

    /** Caller can clamp parallel batch size to remaining budget. */
    callsRemaining(): number {
        return Math.max(0, this.maxCalls - this.callsUsed);
    }

    /** null until a cap trips. */
    capHitReason(): "calls" | "wallclock" | null {
        return this.capHit;
    }

    callsUsedSoFar(): number {
        return this.callsUsed;
    }

    elapsedMs(): number {
        return Date.now() - this.startMs;
    }
}
