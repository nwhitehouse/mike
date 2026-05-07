import type {
    StreamChatParams,
    StreamChatResult,
    NormalizedToolCall,
    LlmContentBlock,
} from "./types";

type OlavaMessage = {
    role: "system" | "user" | "assistant" | "tool";
    /**
     * Plain string for text-only turns. Array of OpenAI-style content blocks
     * for multimodal turns (vision). vLLM's OpenAI-compat endpoint accepts
     * the array directly when serving a VL model — pass-through.
     */
    content: string | LlmContentBlock[] | null;
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

// Default token budget for interactive chat. Thinking stays enabled by
// default, but 8k keeps verbose reasoning from burning the previous 16k+
// output-token budget. Override via OLAVA_MAX_TOKENS.
const DEFAULT_MAX_TOKENS = 8192;
const DEFAULT_COMPLETION_MAX_TOKENS = 2048;
type OlavaThinkingMode = "off" | "low" | "standard";

function maxTokens(): number {
    const raw = process.env.OLAVA_MAX_TOKENS?.trim();
    if (!raw) return DEFAULT_MAX_TOKENS;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_TOKENS;
}

function completionDefaultMaxTokens(): number {
    const raw = process.env.OLAVA_COMPLETION_MAX_TOKENS?.trim();
    if (!raw) return DEFAULT_COMPLETION_MAX_TOKENS;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_COMPLETION_MAX_TOKENS;
}

function completionMaxTokens(requested?: number): number {
    if (typeof requested === "number" && Number.isFinite(requested) && requested > 0) {
        return Math.floor(requested);
    }
    return completionDefaultMaxTokens();
}

function olavaThinkingMode(enableThinking?: boolean): OlavaThinkingMode {
    if (!enableThinking) return "off";
    const raw = process.env.OLAVA_THINKING_MODE?.trim().toLowerCase();
    if (raw === "off" || raw === "low" || raw === "standard") return raw;
    return "standard";
}

function applyThinkingControls(
    body: Record<string, unknown>,
    mode: OlavaThinkingMode,
) {
    // Qwen3/vLLM exposes thinking control through request-level
    // chat_template_kwargs. This is not part of the OpenAI spec, but vLLM
    // accepts it and request-level values override server defaults. `low`
    // intentionally uses the hard non-thinking switch; Qwen does not expose
    // a stable per-request "think for N tokens" budget.
    body.chat_template_kwargs = {
        enable_thinking: mode === "standard",
    };
}

function appendNoThinkHint(
    messages: OlavaMessage[],
    mode: OlavaThinkingMode,
): OlavaMessage[] {
    if (mode === "standard") return messages;
    const hint =
        "/no_think\nKeep reasoning private and brief. Return the final answer directly.";
    if (messages[0]?.role === "system") {
        return [
            {
                ...messages[0],
                content:
                    typeof messages[0].content === "string"
                        ? `${messages[0].content}\n\n${hint}`
                        : hint,
            },
            ...messages.slice(1),
        ];
    }
    return [{ role: "system", content: hint }, ...messages];
}

// Some vLLM builds embed thinking inline as <think>...</think> in `content`
// instead of (or in addition to) the separate `reasoning` field. Strip those
// blocks before downstream parsers see the text — they would choke on the
// non-JSON wrapper.
function stripThinkBlocks(s: string): string {
    return s.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

// Streaming-safe filter that hides two kinds of model-side markup from the
// user-visible token stream while leaving the raw text intact for downstream
// parsing:
//
//   1. <think>...</think> blocks — defensive against vLLM builds that embed
//      reasoning in `delta.content` instead of `delta.reasoning_content`.
//   2. <tool_call>... markup — the Olava LoRA's custom tool-call format
//      (parsed post-stream by parseCustomToolCall). Once <tool_call> opens,
//      everything after it is suppressed from the user view; the raw buffer
//      still receives it for the parser.
//
// The filter holds back any trailing portion of a delta that could be the
// start of one of these tags (e.g. `<`, `<t`, `<tool_cal`) so a marker split
// across two streamed chunks isn't accidentally emitted.
class StreamingMarkupFilter {
    private inThink = false;
    private toolCallSeen = false;
    private tail = "";

    feed(delta: string): string {
        if (this.toolCallSeen || !delta) return "";

        let buf = this.tail + delta;
        this.tail = "";
        let visible = "";

        while (buf.length > 0) {
            if (this.inThink) {
                const closeIdx = buf.indexOf("</think>");
                if (closeIdx >= 0) {
                    buf = buf.slice(closeIdx + "</think>".length);
                    this.inThink = false;
                    continue;
                }
                this.tail = StreamingMarkupFilter.heldBackSuffix(buf, [
                    "</think>",
                ]);
                return visible;
            }

            const thinkIdx = buf.indexOf("<think>");
            const toolIdx = buf.indexOf("<tool_call>");

            let nextIdx = -1;
            let nextLen = 0;
            let nextType: "think" | "tool" | null = null;
            if (thinkIdx >= 0) {
                nextIdx = thinkIdx;
                nextLen = "<think>".length;
                nextType = "think";
            }
            if (toolIdx >= 0 && (nextIdx < 0 || toolIdx < nextIdx)) {
                nextIdx = toolIdx;
                nextLen = "<tool_call>".length;
                nextType = "tool";
            }

            if (nextIdx >= 0) {
                visible += buf.slice(0, nextIdx);
                buf = buf.slice(nextIdx + nextLen);
                if (nextType === "think") {
                    this.inThink = true;
                    continue;
                } else {
                    this.toolCallSeen = true;
                    return visible;
                }
            }

            const tailLen = StreamingMarkupFilter.heldBackSuffix(buf, [
                "<think>",
                "<tool_call>",
            ]).length;
            visible += buf.slice(0, buf.length - tailLen);
            this.tail = buf.slice(buf.length - tailLen);
            return visible;
        }

        return visible;
    }

    flush(): string {
        if (this.toolCallSeen || this.inThink) {
            this.tail = "";
            return "";
        }
        const visible = this.tail;
        this.tail = "";
        return visible;
    }

    // Returns the trailing slice of `buf` that is a non-empty proper prefix
    // of any target tag, or "" if no such prefix is at the end. Used to
    // decide how many trailing chars to hold back across stream chunks.
    private static heldBackSuffix(buf: string, targets: string[]): string {
        const lt = buf.lastIndexOf("<");
        if (lt < 0) return "";
        const tail = buf.slice(lt);
        for (const t of targets) {
            if (tail.length < t.length && t.startsWith(tail)) {
                return tail;
            }
        }
        return "";
    }
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

// Single non-streaming completion used as a fallback when streaming finished
// with finish_reason="tool_calls" but no tool-call info was recoverable from
// either the structured `delta.tool_calls` channel or the `delta.content`
// markup. Runs the same request as the streaming iter (same messages, same
// tools), but with `stream: false` so vLLM emits the markup into
// `message.content` where parseCustomToolCall can find it. Returns null if
// the fallback also fails to surface a tool call.
async function recoverToolCallNonStreaming(args: {
    model: string;
    messages: OlavaMessage[];
    tools: unknown[];
    iter: number;
    thinkingMode: OlavaThinkingMode;
}): Promise<NormalizedToolCall | null> {
    const { model, messages, tools, iter, thinkingMode } = args;
    try {
        const body: Record<string, unknown> = {
            model,
            messages: appendNoThinkHint(messages, thinkingMode),
            stream: false,
            max_tokens: maxTokens(),
            tools,
        };
        applyThinkingControls(body, thinkingMode);
        const resp = await fetch(endpoint(), {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "User-Agent": "Mozilla/5.0",
                ...authHeaders(),
            },
            body: JSON.stringify(body),
        });
        if (!resp.ok) return null;
        const json = (await resp.json()) as {
            choices?: Array<{
                message?: {
                    content?: string | null;
                    tool_calls?: Array<{
                        id?: string;
                        function?: { name?: string; arguments?: string };
                    }>;
                };
            }>;
        };
        const message = json.choices?.[0]?.message;

        // Prefer structured tool_calls if vLLM did parse this time.
        const structured = message?.tool_calls ?? [];
        if (structured.length > 0) {
            const tc = structured[0];
            let input: Record<string, unknown> = {};
            try {
                input = tc.function?.arguments
                    ? JSON.parse(tc.function.arguments)
                    : {};
            } catch {
                /* leave input empty */
            }
            return {
                id: tc.id || `${tc.function?.name || "tool"}-${iter}`,
                name: tc.function?.name ?? "",
                input,
            };
        }

        // Fall back to parsing the LoRA's custom markup from message.content.
        const parsed = parseCustomToolCall(message?.content ?? "");
        if (parsed && parsed.name) {
            return {
                id: `${parsed.name}-${iter}-${Date.now()}`,
                name: parsed.name,
                input: parsed.input,
            };
        }
        return null;
    } catch {
        return null;
    }
}

export async function streamOlava(
    params: StreamChatParams,
): Promise<StreamChatResult> {
    const { model, systemPrompt, tools = [], callbacks = {}, runTools } = params;
    const maxIter = params.maxIterations ?? 10;
    const thinkingMode = olavaThinkingMode(params.enableThinking);

    // vLLM's tool-call streaming is broken for the Olava LoRA: with
    // --tool-call-parser hermes (or any other built-in), the LoRA's custom
    // markup `<tool_call><function=NAME><parameter=KEY>VALUE</parameter>...`
    // never gets parsed, so `delta.tool_calls` arrives empty even though
    // `finish_reason` is "tool_calls". We work around this by accepting the
    // markup IN `delta.content`, hiding it from the user via a streaming
    // filter, and running the same `parseCustomToolCall()` we use on the
    // non-streaming path once the stream finishes.
    //
    // Emergency rollback: set OLAVA_FORCE_NONSTREAM_TOOLS=true to revert to
    // a single non-streaming request per iteration (the prior behaviour).
    const allowTools =
        process.env.OLAVA_ENABLE_TOOLS?.toLowerCase() === "true";
    if (
        tools.length > 0 &&
        allowTools &&
        process.env.OLAVA_FORCE_NONSTREAM_TOOLS?.toLowerCase() === "true"
    ) {
        return nonStreamOlavaWithTools(params);
    }

    const messages: OlavaMessage[] = [];
    if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
    for (const m of params.messages) {
        // Preserve role='tool' rows (with tool_call_id) and assistant rows
        // that carry structured tool_calls — feat-017 replays them from chat
        // history so the model sees its prior turn's tool round-trip.
        const out: OlavaMessage = { role: m.role, content: m.content };
        if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
        if (m.tool_calls?.length) out.tool_calls = m.tool_calls;
        messages.push(out);
    }

    let fullText = "";

    for (let iter = 0; iter < maxIter; iter++) {
        const body: Record<string, unknown> = {
            model,
            messages: appendNoThinkHint(messages, thinkingMode),
            stream: true,
            max_tokens: maxTokens(),
        };
        applyThinkingControls(body, thinkingMode);
        // vLLM only accepts tools if the server was started with
        // --enable-auto-tool-choice and --tool-call-parser. Most deployments
        // don't run with those flags, so by default we drop tools and let the
        // model reply with plain text. Set OLAVA_ENABLE_TOOLS=true to forward
        // them when your server supports it.
        const allowTools =
            process.env.OLAVA_ENABLE_TOOLS?.toLowerCase() === "true";
        if (tools.length && allowTools) {
            body.tools = tools;
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
        const filter = new StreamingMarkupFilter();

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
                    const visible = filter.feed(delta.content);
                    if (visible) {
                        fullText += visible;
                        callbacks.onContentDelta?.(visible);
                    }
                }
                // Forward reasoning to the UI so the user can expand the
                // Thought process disclosure to see Olava's chain-of-thought.
                // The security commit's PII concern was about backend logs;
                // the user's own UI is fine to surface. (Persisted as part
                // of chat_messages — visible to anyone the chat is shared
                // with, same scope as the response itself.)
                if (typeof delta.reasoning === "string" && delta.reasoning) {
                    reasoningChars += delta.reasoning.length;
                    callbacks.onReasoningDelta?.(delta.reasoning);
                }
                if (
                    typeof delta.reasoning_content === "string" &&
                    delta.reasoning_content
                ) {
                    reasoningChars += delta.reasoning_content.length;
                    callbacks.onReasoningDelta?.(delta.reasoning_content);
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

        // Stream is done — flush any held-back chars that turned out not to
        // be a partial tag prefix.
        const tail = filter.flush();
        if (tail) {
            fullText += tail;
            callbacks.onContentDelta?.(tail);
        }

        const rawText = iterTextChunks.join("");

        if (finishReason === "length") {
            console.warn(
                `[olava] WARNING: stopped due to max_tokens=${maxTokens()}. ` +
                    `Reasoning consumed ${reasoningChars} chars before answer. ` +
                    `Bump OLAVA_MAX_TOKENS in backend/.env to give the model more headroom.`,
            );
        }

        // Build the tool-call list. Prefer vLLM's structured `delta.tool_calls`
        // payload when present (will start working if a future vLLM build
        // recognises Olava's format). Otherwise fall back to parsing the
        // custom <tool_call><function=...><parameter=...> markup out of the
        // raw streamed content — same parser used by the non-streaming path.
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
            toolCalls.push(call);
        }

        if (toolCalls.length === 0) {
            const parsed = parseCustomToolCall(rawText);
            if (parsed && parsed.name) {
                toolCalls.push({
                    id: `${parsed.name}-${iter}-${Date.now()}`,
                    name: parsed.name,
                    input: parsed.input,
                });
            }
        }

        // vLLM streaming for the Olava LoRA loses tool-call payloads: it
        // sets finish_reason="tool_calls" but neither populates
        // delta.tool_calls (so accCalls stays empty) nor includes the
        // <tool_call> markup in delta.content (rawText comes through as
        // just whitespace). We can recover by re-issuing this iter as a
        // single non-streaming request — the markup lands in
        // message.content and parseCustomToolCall extracts it. One extra
        // request per tool-using iter, but only on this iter — the prose-
        // generating iters that come after will stream normally.
        if (toolCalls.length === 0 && finishReason === "tool_calls") {
            const recovered = await recoverToolCallNonStreaming({
                model,
                messages,
                tools,
                iter,
                thinkingMode,
            });
            if (recovered) {
                toolCalls.push(recovered);
            }
        }

        toolCalls.forEach((c) => callbacks.onToolCallStart?.(c));

        if (!toolCalls.length || !runTools) break;

        const results = await runTools(toolCalls);

        // The assistant turn message we send back to the model echoes the
        // raw text it produced (think blocks stripped) so the next iteration
        // sees a clean transcript. The user-visible filtered text is a
        // separate concern — what we showed the user is decoupled from what
        // the model sees on its next turn.
        const assistantContent = stripThinkBlocks(rawText);

        messages.push({
            role: "assistant",
            content: assistantContent || null,
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
    const thinkingMode = olavaThinkingMode(params.enableThinking);

    const messages: OlavaMessage[] = [];
    if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
    for (const m of params.messages) {
        const out: OlavaMessage = { role: m.role, content: m.content };
        if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
        if (m.tool_calls?.length) out.tool_calls = m.tool_calls;
        messages.push(out);
    }

    let fullText = "";

    for (let iter = 0; iter < maxIter; iter++) {
        const body: Record<string, unknown> = {
            model,
            messages: appendNoThinkHint(messages, thinkingMode),
            stream: false,
            max_tokens: maxTokens(),
            tools,
        };
        applyThinkingControls(body, thinkingMode);

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

    const thinkingMode = olavaThinkingMode(false);
    const effectiveMax = completionMaxTokens(params.maxTokens);
    const body: Record<string, unknown> = {
        model: params.model,
        messages: appendNoThinkHint(messages, thinkingMode),
        max_tokens: effectiveMax,
    };
    applyThinkingControls(body, thinkingMode);

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
            message?: { content?: string | null };
            finish_reason?: string;
        }>;
    };
    const choice = json.choices?.[0];
    if (choice?.finish_reason === "length") {
        console.warn(
            `[olava] non-streaming completion hit max_tokens — answer may be truncated. ` +
                `Raise the caller maxTokens or OLAVA_COMPLETION_MAX_TOKENS to allow more tokens.`,
        );
    }
    const content = choice?.message?.content ?? "";
    return stripThinkBlocks(content);
}
