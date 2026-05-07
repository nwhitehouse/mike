import Anthropic from "@anthropic-ai/sdk";
import type { Tool } from "@anthropic-ai/sdk/resources/messages/messages";
import type {
    StreamChatParams,
    StreamChatResult,
    NormalizedToolCall,
    NormalizedToolResult,
} from "./types";
import { toClaudeTools } from "./tools";

type ContentBlock =
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string; name: string; input: unknown }
    | { type: string; [key: string]: unknown };

type NativeMessage = {
    role: "user" | "assistant";
    content: string | ContentBlock[];
};

const MAX_TOKENS = 16384;

function client(override?: string | null): Anthropic {
    const apiKey = override?.trim() || process.env.ANTHROPIC_API_KEY || "";
    return new Anthropic({ apiKey });
}

function toNativeMessages(
    messages: StreamChatParams["messages"],
): NativeMessage[] {
    // feat-017: drop tool-role rows from claude path (this provider is
    // currently dead code per coerceToOlava in llm/index.ts; if revived,
    // map tool rows to Anthropic's `tool_result` content blocks here).
    return messages
        .filter((m): m is typeof m & { role: "user" | "assistant" } =>
            m.role === "user" || m.role === "assistant",
        )
        .map((m) => {
            // Multimodal content (vision) is currently Olava-only — caller
            // shouldn't be routing vision turns to Claude. If it does, flatten
            // text blocks and drop images so the request still goes through.
            if (typeof m.content === "string") {
                return { role: m.role, content: m.content };
            }
            if (m.content === null) {
                return { role: m.role, content: "" };
            }
            const text = m.content
                .filter((b) => b.type === "text")
                .map((b) => (b as { text: string }).text)
                .join("\n");
            return { role: m.role, content: text };
        });
}

export async function streamClaude(
    params: StreamChatParams,
): Promise<StreamChatResult> {
    const {
        model,
        systemPrompt,
        tools = [],
        callbacks = {},
        runTools,
        apiKeys,
        enableThinking,
    } = params;
    const maxIter = params.maxIterations ?? 10;
    const anthropic = client(apiKeys?.claude);
    const claudeTools = toClaudeTools(tools);

    const messages: NativeMessage[] = toNativeMessages(params.messages);
    let fullText = "";

    for (let iter = 0; iter < maxIter; iter++) {
        const stream = anthropic.messages.stream({
            model,
            system: systemPrompt,
            messages: messages as Anthropic.MessageParam[],
            tools: claudeTools.length
                ? (claudeTools as unknown as Tool[])
                : undefined,
            max_tokens: MAX_TOKENS,
            // Claude 4.x models require `thinking.type: "adaptive"` and
            // drive effort via `output_config.effort` rather than a fixed
            // token budget. We only opt in when the caller requested it.
            ...(enableThinking
                ? ({
                      thinking: { type: "adaptive" },
                      output_config: { effort: "high" },
                  } as unknown as Record<string, unknown>)
                : {}),
            // Extended thinking requires temperature to be default (omitted).
        });

        let sawThinking = false;

        stream.on("text", (delta) => {
            callbacks.onContentDelta?.(delta);
        });
        if (enableThinking) {
            stream.on("thinking", (delta) => {
                sawThinking = true;
                callbacks.onReasoningDelta?.(delta);
            });
        }

        const final = await stream.finalMessage();
        if (sawThinking) callbacks.onReasoningBlockEnd?.();
        const stopReason = final.stop_reason;
        const assistantBlocks = final.content as ContentBlock[];

        // Extract text content and tool_use calls from the final assistant
        // message so we can accumulate text and drive the tool-call loop.
        const toolCalls: NormalizedToolCall[] = [];
        for (const block of assistantBlocks) {
            if (block.type === "text") {
                const txt = (block as { text: string }).text;
                if (typeof txt === "string") fullText += txt;
            } else if (block.type === "tool_use") {
                const tu = block as {
                    id: string;
                    name: string;
                    input: unknown;
                };
                const call: NormalizedToolCall = {
                    id: tu.id,
                    name: tu.name,
                    input: (tu.input as Record<string, unknown>) ?? {},
                };
                callbacks.onToolCallStart?.(call);
                toolCalls.push(call);
            }
        }

        if (stopReason !== "tool_use" || !toolCalls.length || !runTools) {
            break;
        }

        const results = await runTools(toolCalls);

        // Record the assistant turn (preserving the original content blocks,
        // which Claude requires on the follow-up) and the user turn that
        // carries the tool_result blocks.
        messages.push({ role: "assistant", content: assistantBlocks });
        messages.push({
            role: "user",
            content: results.map((r) => ({
                type: "tool_result",
                tool_use_id: r.tool_use_id,
                content: r.content,
            })),
        });
    }

    return { fullText };
}

export async function completeClaudeText(params: {
    model: string;
    systemPrompt?: string;
    user: string;
    maxTokens?: number;
    apiKeys?: { claude?: string | null };
}): Promise<string> {
    const anthropic = client(params.apiKeys?.claude);
    const resp = await anthropic.messages.create({
        model: params.model,
        max_tokens: params.maxTokens ?? 512,
        system: params.systemPrompt,
        messages: [{ role: "user", content: params.user }],
    });
    const text = resp.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");
    return text;
}

// Helper re-export for callers wanting to hand normalized results back in.
export type { NormalizedToolResult };
