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

// The Olava LoRA emits tool calls in a custom token format that doesn't
// match any of vLLM's built-in --tool-call-parser options:
//
//   <tool_call> <function=NAME> <parameter=KEY1> VALUE1 <parameter=KEY2> VALUE2 ...
//   [optionally closed with </tool_call>]
//
// vLLM with --tool-call-parser hermes leaves these tokens in `content`
// and never populates `message.tool_calls`. We parse them ourselves and
// emit a NormalizedToolCall the existing tool-running loop can dispatch.
// Generic across every tool — works for generate_docx, read_document,
// edit_document, find_in_document, read_workflow, read_table_cells, etc.
// Each <parameter=...> value block is JSON-decoded when possible (so
// arrays / objects come through as real values), with scalar coercion
// for true / false / numeric, and string fallback otherwise.
function parseCustomToolCall(
    content: string,
): { name: string; input: Record<string, unknown> } | null {
    const head = content.match(/<tool_call>\s*<function=([^>]+)>/);
    if (!head) return null;
    const name = head[1].trim();
    const bodyStart = (head.index ?? 0) + head[0].length;
    let body = content.slice(bodyStart);
    body = body.replace(/<\/tool_call>\s*$/i, "").trim();

    const parts = body.split(/<parameter=([^>]+)>/);
    const input: Record<string, unknown> = {};
    for (let i = 1; i < parts.length; i += 2) {
        const key = parts[i].trim();
        let raw = (parts[i + 1] ?? "").trim();
        // The LoRA sometimes terminates a value with </parameter>, </function>,
        // and/or </tool_call>. Strip any combination of these from the tail
        // until none remain, so values aren't poisoned with stray markup.
        let prev: string;
        do {
            prev = raw;
            raw = raw
                .replace(/<\/parameter>\s*$/i, "")
                .replace(/<\/function>\s*$/i, "")
                .replace(/<\/tool_call>\s*$/i, "")
                .trim();
        } while (raw !== prev);
        try {
            input[key] = JSON.parse(raw);
            continue;
        } catch {
            // not JSON
        }
        if (raw === "true") input[key] = true;
        else if (raw === "false") input[key] = false;
        else if (raw !== "" && !Number.isNaN(Number(raw))) input[key] = Number(raw);
        else input[key] = raw;
    }
    return { name, input };
}

export async function streamOlava(
    params: StreamChatParams,
): Promise<StreamChatResult> {
    const { model, systemPrompt, tools = [], callbacks = {}, runTools } = params;
    const maxIter = params.maxIterations ?? 10;

    // vLLM's streaming + --enable-auto-tool-choice combination is fragile
    // with hermes / qwen tool parsers: it emits `delta.content` chunks
    // each carrying an empty `tool_calls: []`, then a final event with
    // `finish_reason: "tool_calls"` but never streams the real tool-call
    // payload. The non-streaming endpoint returns a complete
    // `message.tool_calls` array, so when tools are forwarded we drop
    // streaming and use a single request/response per iteration.
    const allowTools =
        process.env.OLAVA_ENABLE_TOOLS?.toLowerCase() === "true";
    if (tools.length > 0 && allowTools) {
        return nonStreamOlavaWithTools(params);
    }

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
        // vLLM only accepts tools if the server was started with
        // --enable-auto-tool-choice and --tool-call-parser. Most deployments
        // don't run with those flags, so by default we drop tools and let the
        // model reply with plain text. Set OLAVA_ENABLE_TOOLS=true to forward
        // them when your server supports it.
        const allowTools =
            process.env.OLAVA_ENABLE_TOOLS?.toLowerCase() === "true";
        if (tools.length && allowTools) {
            body.tools = tools;
        } else if (tools.length) {
            console.log(
                `[olava] dropping ${tools.length} tools — set OLAVA_ENABLE_TOOLS=true ` +
                    `if your vLLM server is running with --enable-auto-tool-choice.`,
            );
        }

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
        // Truncated dump of the actual response text — invaluable when the
        // model returns very short content (e.g. refusals, malformed tool
        // attempts, post-strip empties) and we need to see why.
        if (text.length < 500) {
            console.log(`[olava] text=${JSON.stringify(text)}`);
        } else {
            console.log(`[olava] text_head=${JSON.stringify(text.slice(0, 300))}`);
        }
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

async function nonStreamOlavaWithTools(
    params: StreamChatParams,
): Promise<StreamChatResult> {
    const { model, systemPrompt, tools = [], callbacks = {}, runTools } = params;
    const maxIter = params.maxIterations ?? 10;

    const messages: OlavaMessage[] = [];
    if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
    for (const m of params.messages)
        messages.push({ role: m.role, content: m.content });

    let fullText = "";

    for (let iter = 0; iter < maxIter; iter++) {
        const body: Record<string, unknown> = {
            model,
            messages,
            stream: false,
            max_tokens: maxTokens(),
            tools,
        };

        const resp = await fetch(endpoint(), {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "User-Agent": "Mozilla/5.0",
                ...authHeaders(),
            },
            body: JSON.stringify(body),
        });
        if (!resp.ok) {
            const text = await resp.text().catch(() => "");
            throw new Error(`Olava HTTP ${resp.status}: ${text}`);
        }

        const json = (await resp.json()) as {
            choices?: Array<{
                message?: {
                    content?: string | null;
                    reasoning?: string | null;
                    reasoning_content?: string | null;
                    tool_calls?: Array<{
                        id?: string;
                        type?: string;
                        function?: { name?: string; arguments?: string };
                    }>;
                };
                finish_reason?: string;
            }>;
        };
        const choice = json.choices?.[0];
        const message = choice?.message;
        const finishReason = choice?.finish_reason ?? "?";

        const reasoningChars =
            (message?.reasoning?.length ?? 0) +
            (message?.reasoning_content?.length ?? 0);

        const rawContent = message?.content ?? "";
        const stripped = stripThinkBlocks(rawContent);

        // Build the tool-call list. Prefer vLLM's parsed payload when the
        // server-side parser worked; otherwise scan the content for our
        // LoRA's custom <tool_call><function=...><parameter=...> markup.
        const toolCallsRaw = message?.tool_calls ?? [];
        let toolCalls: NormalizedToolCall[] = toolCallsRaw.map((tc, i) => {
            let input: Record<string, unknown> = {};
            try {
                input = tc.function?.arguments
                    ? JSON.parse(tc.function.arguments)
                    : {};
            } catch {
                input = {};
            }
            return {
                id: tc.id || `${tc.function?.name || "tool"}-${i}`,
                name: tc.function?.name ?? "",
                input,
            };
        });

        let textForUser = stripped;
        let parsedFromContent = false;
        if (toolCalls.length === 0) {
            const parsed = parseCustomToolCall(rawContent);
            if (parsed && parsed.name) {
                toolCalls = [
                    {
                        id: `${parsed.name}-${iter}-${Date.now()}`,
                        name: parsed.name,
                        input: parsed.input,
                    },
                ];
                parsedFromContent = true;
                // Log the parsed input keys + sizes so we can see whether
                // the model actually emitted the params we expect (e.g.
                // generate_docx with sections) vs. only a subset.
                const keySummary = Object.entries(parsed.input)
                    .map(([k, v]) => {
                        if (Array.isArray(v))
                            return `${k}=array[${v.length}]`;
                        if (typeof v === "string")
                            return `${k}=str[${v.length}]`;
                        return `${k}=${typeof v}`;
                    })
                    .join(" ");
                console.log(
                    `[olava] parsed tool_call name=${parsed.name} ${keySummary}`,
                );
                // Show the user only the prose preamble that came BEFORE
                // the <tool_call> tokens — the markup itself shouldn't
                // appear in the chat transcript.
                const preambleEnd = rawContent.indexOf("<tool_call>");
                textForUser = stripThinkBlocks(
                    preambleEnd >= 0 ? rawContent.slice(0, preambleEnd) : "",
                );
            }
        }

        if (textForUser) {
            fullText += textForUser;
            callbacks.onContentDelta?.(textForUser);
        }
        toolCalls.forEach((c) => callbacks.onToolCallStart?.(c));

        console.log(
            `[olava] non-stream iter=${iter} model=${model} ` +
                `content_chars=${textForUser.length} reasoning_chars=${reasoningChars} ` +
                `tool_calls=${toolCalls.length}${parsedFromContent ? " (parsed-from-content)" : ""} ` +
                `finish_reason=${finishReason}`,
        );
        const text = textForUser;

        if (toolCalls.length === 0 || !runTools) break;

        const results = await runTools(toolCalls);

        messages.push({
            role: "assistant",
            content: text || null,
            tool_calls: toolCalls.map((c) => ({
                id: c.id,
                type: "function",
                function: {
                    name: c.name,
                    arguments: JSON.stringify(c.input),
                },
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

    // Reasoning models need a lot of headroom: the chain-of-thought eats
    // tokens before the answer is produced, and callers tuned for
    // non-reasoning models tend to pass small caps (e.g. 2048) that aren't
    // enough. Take the larger of the caller's request and the env default
    // so we never undershoot the budget the model actually needs.
    const requestedMax = params.maxTokens ?? 0;
    const envMax = maxTokens();
    const effectiveMax = Math.max(requestedMax, envMax);

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
            max_tokens: effectiveMax,
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
