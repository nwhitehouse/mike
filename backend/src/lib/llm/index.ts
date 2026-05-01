import { streamClaude, completeClaudeText } from "./claude";
import { streamGemini, completeGeminiText } from "./gemini";
import { streamOlava, completeOlavaText } from "./olava";
import { providerForModel, DEFAULT_MAIN_MODEL } from "./models";
import type { StreamChatParams, StreamChatResult, UserApiKeys } from "./types";

export * from "./types";
export * from "./models";

// Coerce any non-Olava model ID to the default. Defends against stale
// localStorage values or DB rows referencing the old Anthropic/Gemini IDs.
function coerceToOlava<T extends { model: string }>(params: T): T {
    try {
        if (providerForModel(params.model) === "olava") return params;
    } catch {
        // Unknown model ID — fall through to default.
    }
    return { ...params, model: DEFAULT_MAIN_MODEL };
}

export async function streamChatWithTools(
    params: StreamChatParams,
): Promise<StreamChatResult> {
    const p = coerceToOlava(params);
    const provider = providerForModel(p.model);
    if (provider === "claude") return streamClaude(p);
    if (provider === "olava") return streamOlava(p);
    return streamGemini(p);
}

export async function completeText(params: {
    model: string;
    systemPrompt?: string;
    user: string;
    maxTokens?: number;
    apiKeys?: UserApiKeys;
}): Promise<string> {
    const p = coerceToOlava(params);
    const provider = providerForModel(p.model);
    if (provider === "claude") return completeClaudeText(p);
    if (provider === "olava") return completeOlavaText(p);
    return completeGeminiText(p);
}
