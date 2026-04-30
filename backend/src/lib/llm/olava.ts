import type {
    StreamChatParams,
    StreamChatResult,
    NormalizedToolCall,
} from "./types";

type OlavaMessage = {
    role: "system" | "user" | "assistant" | "tool";
    content: string | null;
    tool_calls?: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
    }>;
    tool_call_id?: string;
};

type StreamDelta = {
    content?: string;
    // Reasoning fields — different vLLM versions use different names. Some
    // builds (Qwen3) emit `reasoning_content`, others (DeepSeek-style) emit
    // `reasoning`. Both can be present on the same server depending on the
    // model. We accumulate either as discarded "thought" tokens.
    reasoning?: string;
    reasoning_content?: string;
    tool_calls?: Array<{
        index: number;
        id?: string;
        function?: { name?: string; arguments?: string };
    }>;
};

// Default token budget. Reasoning models burn tokens thinking before they
// produce the answer, so we need a generous cap. Override via OLAVA_MAX_TOKENS
// for tuning per deployment without a code change.
const DEFAULT_MAX_TOKENS = 16384;

function maxTokens(): number {
    const raw = process.env.OLAVA_MAX_TOKENS?.trim();
    if (!raw) return DEFAULT_MAX_TOKENS;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_TOKENS;
}

// Some vLLM builds embed thinking inline as <think>...</think> in `content`
// instead of (or in addition to) the separate `reasoning` field. Strip those
// blocks before downstream parsers see the text — they would choke on the
// non-JSON wrapper.
function stripThinkBlocks(s: string): string {
    return s.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

function endpoint(): string {
    const base = (process.env.OLAVA_BASE_URL ?? "").replace(/\/+$/, "");
    if (!base) throw new Error("OLAVA_BASE_URL is not set");
    return `${base}/chat/completions`;
}

function authHeaders(): Record<string, string> {
    const token = process.env.OLAVA_AUTH_TOKEN ?? "";
    return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function streamOlava(
    params: StreamChatParams,
): Promise<StreamChatResult> {
    const { model, systemPrompt, tools = [], callbacks = {}, runTools } = params;
    const maxIter = params.maxIterations ?? 10;

    const messages: OlavaMessage[] = [];
    if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
    for (const m of params.messages) messages.push({ role: m.role, content: m.content });

    let fullText = "";

    for (let iter = 0; iter < maxIter; iter++) {
        const body: Record<string, unknown> = {
            model,
            messages,
            stream: true,
            max_tokens: maxTokens(),
        };
        if (tools.length) body.tools = tools;

        const resp = await fetch(endpoint(), {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "User-Agent": "Mozilla/5.0",
                ...authHeaders(),
            },
            body: JSON.stringify(body),
        });
        if (!resp.ok || !resp.body) {
            const text = await resp.text().catch(() => "");
            throw new Error(`Olava HTTP ${resp.status}: ${text}`);
        }

        const iterTextChunks: string[] = [];
        const accCalls = new Map<number, { id: string; name: string; argText: string }>();
        let reasoningChars = 0;
        let finishReason: string | null = null;

        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";

        outer: while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            const lines = buf.split("\n");
            buf = lines.pop() ?? "";
            for (const raw of lines) {
                const line = raw.trim();
                if (!line.startsWith("data:")) continue;
                const data = line.slice(5).trim();
                if (data === "[DONE]") break outer;
                let evt: {
                    choices?: Array<{
                        delta?: StreamDelta;
                        finish_reason?: string | null;
                    }>;
                };
                try {
                    evt = JSON.parse(data);
                } catch {
                    continue;
                }
                const choice = evt.choices?.[0];
                if (choice?.finish_reason) finishReason = choice.finish_reason;
                const delta = choice?.delta;
                if (!delta) continue;
                if (typeof delta.content === "string" && delta.content) {
                    iterTextChunks.push(delta.content);
                }
                // Reasoning is dropped from output but counted for diagnostics.
                if (typeof delta.reasoning === "string" && delta.reasoning) {
                    reasoningChars += delta.reasoning.length;
                }
                if (
                    typeof delta.reasoning_content === "string" &&
                    delta.reasoning_content
                ) {
                    reasoningChars += delta.reasoning_content.length;
                }
                if (Array.isArray(delta.tool_calls)) {
                    for (const tc of delta.tool_calls) {
                        const slot = accCalls.get(tc.index) ?? {
                            id: "",
                            name: "",
                            argText: "",
                        };
                        if (tc.id) slot.id = tc.id;
                        if (tc.function?.name) slot.name = tc.function.name;
                        if (tc.function?.arguments)
                            slot.argText += tc.function.arguments;
                        accCalls.set(tc.index, slot);
                    }
                }
            }
        }

        // Strip any inline <think>...</think> blocks before exposing the text
        // downstream — defensive against vLLM builds that embed reasoning in
        // content (in addition to or instead of the separate field).
        const rawText = iterTextChunks.join("");
        const text = stripThinkBlocks(rawText);
        if (text) callbacks.onContentDelta?.(text);
        fullText += text;

        console.log(
            `[olava] iter=${iter} model=${model} content_chars=${text.length} ` +
                `reasoning_chars=${reasoningChars} tool_calls=${accCalls.size} ` +
                `finish_reason=${finishReason ?? "?"}`,
        );
        if (finishReason === "length") {
            console.warn(
                `[olava] WARNING: stopped due to max_tokens=${maxTokens()}. ` +
                    `Reasoning consumed ${reasoningChars} chars before answer. ` +
                    `Bump OLAVA_MAX_TOKENS in backend/.env to give the model more headroom.`,
            );
        }

        const toolCalls: NormalizedToolCall[] = [];
        for (const slot of accCalls.values()) {
            let input: Record<string, unknown> = {};
            try {
                input = slot.argText ? JSON.parse(slot.argText) : {};
            } catch {
                input = {};
            }
            const call: NormalizedToolCall = {
                id: slot.id || `${slot.name || "tool"}-${toolCalls.length}`,
                name: slot.name,
                input,
            };
            callbacks.onToolCallStart?.(call);
            toolCalls.push(call);
        }

        if (!toolCalls.length || !runTools) break;

        const results = await runTools(toolCalls);

        messages.push({
            role: "assistant",
            content: text || null,
            tool_calls: toolCalls.map((c) => ({
                id: c.id,
                type: "function",
                function: { name: c.name, arguments: JSON.stringify(c.input) },
            })),
        });
        for (const r of results) {
            messages.push({
                role: "tool",
                tool_call_id: r.tool_use_id,
                content: r.content,
            });
        }
    }

    return { fullText };
}

export async function completeOlavaText(params: {
    model: string;
    systemPrompt?: string;
    user: string;
    maxTokens?: number;
}): Promise<string> {
    const messages: OlavaMessage[] = [];
    if (params.systemPrompt)
        messages.push({ role: "system", content: params.systemPrompt });
    messages.push({ role: "user", content: params.user });

    const resp = await fetch(endpoint(), {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "User-Agent": "Mozilla/5.0",
            ...authHeaders(),
        },
        body: JSON.stringify({
            model: params.model,
            messages,
            max_tokens: params.maxTokens ?? maxTokens(),
        }),
    });
    if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        throw new Error(`Olava HTTP ${resp.status}: ${text}`);
    }
    const json = (await resp.json()) as {
        choices?: Array<{
            message?: { content?: string | null };
            finish_reason?: string;
        }>;
    };
    const choice = json.choices?.[0];
    if (choice?.finish_reason === "length") {
        console.warn(
            `[olava] non-streaming completion hit max_tokens — answer may be truncated. ` +
                `Bump OLAVA_MAX_TOKENS to allow more tokens.`,
        );
    }
    const content = choice?.message?.content ?? "";
    return stripThinkBlocks(content);
}
