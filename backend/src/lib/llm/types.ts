// Shared types for the LLM provider adapter.
// Callers always speak OpenAI-style tools + { role, content } messages; each
// provider translates internally.

export type Provider = "claude" | "gemini" | "olava";

export type OpenAIToolSchema = {
    type: "function";
    function: {
        name: string;
        description: string;
        parameters: Record<string, unknown>;
    };
};

export type LlmTextBlock = { type: "text"; text: string };
export type LlmImageBlock = {
    type: "image_url";
    image_url: { url: string; detail?: "low" | "high" | "auto" };
};
export type LlmContentBlock = LlmTextBlock | LlmImageBlock;

export type LlmMessage = {
    role: "user" | "assistant" | "tool";
    /**
     * Plain string for text-only turns (the common case). Array of content
     * blocks for vision turns where the user message includes images
     * (OpenAI Chat Completions multimodal format). Provider adapters pass
     * the array through to the wire — vLLM serves Qwen3-VL natively.
     *
     * For role="tool" rows: the stringified tool result returned to the model.
     * For role="assistant" rows that called tools: the prose text the model
     * produced (including any `<tool_call>` markup) — `tool_calls` carries the
     * structured calls separately for the OpenAI-canonical format.
     */
    content: string | LlmContentBlock[] | null;
    /**
     * For role="tool" rows replayed from chat history: matches the `id` of
     * the corresponding tool call in a prior assistant message's `tool_calls`.
     * Pairs results with calls per OpenAI Chat Completions semantics. Required
     * when role="tool"; ignored otherwise.
     */
    tool_call_id?: string;
    /**
     * For role="assistant" rows replayed from chat history: structured tool
     * calls the model issued during this turn. feat-017 persists these so
     * the next conversation turn sees the canonical
     * {assistant.tool_calls} → {tool.tool_call_id} alternation.
     */
    tool_calls?: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
    }>;
};

export type NormalizedToolCall = {
    id: string;
    name: string;
    input: Record<string, unknown>;
};

export type NormalizedToolResult = {
    tool_use_id: string;
    content: string;
};

export type StreamCallbacks = {
    onReasoningDelta?: (text: string) => void;
    onReasoningBlockEnd?: () => void;
    onContentDelta?: (text: string) => void;
    onToolCallStart?: (call: NormalizedToolCall) => void;
};

export type UserApiKeys = {
    claude?: string | null;
    gemini?: string | null;
    olava?: string | null;
};

export type StreamChatParams = {
    model: string;
    systemPrompt: string;
    messages: LlmMessage[];
    tools?: OpenAIToolSchema[];
    maxIterations?: number;
    callbacks?: StreamCallbacks;
    runTools?: (calls: NormalizedToolCall[]) => Promise<NormalizedToolResult[]>;
    apiKeys?: UserApiKeys;
    /**
     * Enable provider-side reasoning/thinking. Off by default — should only
     * be turned on for interactive chat surfaces where the user actually
     * benefits from seeing the thought stream. Bulk extraction jobs and
     * one-shot completions should leave this off to save tokens and latency.
     */
    enableThinking?: boolean;
};

export type StreamChatResult = {
    fullText: string;
};
