import type { createServerSupabase } from "./supabase";

/**
 * Structured agent audit events (feat-015). Replaces ad-hoc console.log
 * scattered across chatTools.ts + llm/olava.ts as the only trail for what
 * an agent did during a chat turn.
 *
 * Taxonomy:
 *   - turn.started          — chat turn begins
 *   - model.first_token     — model emitted its first content token
 *                             (payload: { latency_ms })
 *   - tool.call_started     — runToolCalls dispatched a tool
 *                             (payload: { name, args_keys })
 *   - tool.call_succeeded   — tool returned a result
 *                             (payload: { name, latency_ms, result_length })
 *   - tool.call_failed      — tool returned an error envelope (feat-016)
 *                             or threw (payload: { name, error_code, latency_ms })
 *   - loop.escalated        — feat-014 controller stopped the loop
 *                             (payload: { reason, step })
 *   - turn.completed        — turn finished
 *                             (payload: { total_steps, total_latency_ms })
 *
 * Hard rule: payload carries metadata only. NEVER user prompts, doc text,
 * tool result bodies, or any other content. chat_messages already holds
 * that — duplication here would bloat the audit log and risk PII leakage.
 */
export type AgentEventType =
    | "turn.started"
    | "model.first_token"
    | "tool.call_started"
    | "tool.call_succeeded"
    | "tool.call_failed"
    | "loop.escalated"
    | "turn.completed";

export type RecordEventArgs = {
    db: ReturnType<typeof createServerSupabase>;
    chatId: string | null | undefined;
    type: AgentEventType;
    payload?: Record<string, unknown>;
};

/**
 * Fire-and-forget insert. Returns immediately; the caller does NOT await.
 * Failures are logged and swallowed — an audit hiccup must never break a
 * chat stream. Skips silently when chatId is missing (e.g. tabular review
 * chats that don't have a chats row).
 */
export function recordEvent({ db, chatId, type, payload }: RecordEventArgs): void {
    if (!chatId) return;
    db.from("agent_events")
        .insert({
            chat_id: chatId,
            type,
            payload: payload ?? {},
        })
        .then(({ error }) => {
            if (error) {
                console.error("[feat-015] agent_events insert failed", {
                    type,
                    error: error.message,
                });
            }
        });
}
