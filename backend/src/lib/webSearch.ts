// Brave Search web search client.
//
// Single endpoint, single env var. Same result shape as legalSearch results
// so feat-004 (References inline) can render either with one card component.
//
// Free tier: 2K queries/month at https://api.search.brave.com/.

const TIMEOUT_MS = 12_000;

export type WebSearchResult = {
    title: string;
    url: string;
    snippet: string;
    source: "Web";
};

async function fetchWithTimeout(
    url: string,
    init: RequestInit & { timeoutMs?: number } = {},
): Promise<Response> {
    const { timeoutMs = TIMEOUT_MS, ...rest } = init;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...rest, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

export async function webSearch(
    query: string,
    count = 5,
): Promise<WebSearchResult[]> {
    const apiKey = process.env.BRAVE_SEARCH_API_KEY ?? "";
    if (!apiKey) {
        console.warn(
            "[webSearch] BRAVE_SEARCH_API_KEY not set — web search unavailable",
        );
        return [];
    }
    const params = new URLSearchParams({ q: query, count: String(count) });
    const resp = await fetchWithTimeout(
        `https://api.search.brave.com/res/v1/web/search?${params}`,
        {
            headers: {
                "X-Subscription-Token": apiKey,
                Accept: "application/json",
            },
        },
    );
    if (!resp.ok) {
        throw new Error(`Brave Search HTTP ${resp.status}`);
    }
    const data = (await resp.json()) as {
        web?: { results?: Array<Record<string, unknown>> };
    };
    const rows = (data.web?.results ?? []).slice(0, count);
    return rows.map((r) => ({
        title: (r.title as string) ?? "",
        url: (r.url as string) ?? "",
        snippet: ((r.description as string) ?? "").slice(0, 500),
        source: "Web" as const,
    }));
}

export function formatWebResultsForModel(results: WebSearchResult[]): string {
    if (results.length === 0) {
        return "No web results found.";
    }
    return results
        .map((r) => {
            const link = r.url ? `[${r.title}](${r.url})` : r.title;
            return `${link} (Web)\n${r.snippet}`;
        })
        .join("\n\n");
}
