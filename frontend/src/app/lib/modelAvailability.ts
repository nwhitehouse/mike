import { MODELS, type ModelOption } from "../components/assistant/ModelToggle";

export type ModelProvider = "claude" | "gemini" | "olava";

export type ServerKeyFlags = {
    claude?: boolean;
    gemini?: boolean;
    olava?: boolean;
};

export type ApiKeyState = {
    claudeApiKey?: string | null;
    geminiApiKey?: string | null;
    serverKeys?: ServerKeyFlags | null;
};

export function getModelProvider(modelId: string): ModelProvider | null {
    const model = MODELS.find((m) => m.id === modelId);
    if (!model) return null;
    return modelGroupToProvider(model.group);
}

export function isModelAvailable(modelId: string, apiKeys: ApiKeyState): boolean {
    const provider = getModelProvider(modelId);
    if (!provider) return false;
    return isProviderAvailable(provider, apiKeys);
}

export function isProviderAvailable(
    provider: ModelProvider,
    apiKeys: ApiKeyState,
): boolean {
    const server = apiKeys.serverKeys;
    if (provider === "claude")
        return !!apiKeys.claudeApiKey?.trim() || !!server?.claude;
    if (provider === "gemini")
        return !!apiKeys.geminiApiKey?.trim() || !!server?.gemini;
    // OLAVA is server-configured only — no per-user key.
    return !!server?.olava;
}

export function providerLabel(provider: ModelProvider): string {
    if (provider === "claude") return "Anthropic (Claude)";
    if (provider === "gemini") return "Google (Gemini)";
    return "Olava";
}

export function modelGroupToProvider(
    group: ModelOption["group"],
): ModelProvider {
    if (group === "Anthropic") return "claude";
    if (group === "Google") return "gemini";
    return "olava";
}
