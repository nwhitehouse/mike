// Legal database search across open US legal sources.
//
// Ported from work___'s `services/legal_search_service.py`. Each source has
// its own async fetcher; `legalSearch()` fans out across the requested set
// with Promise.allSettled so a single slow or failing source can't block or
// poison the others. Failed sources log a warning and contribute zero rows;
// the model still gets results from whichever sources succeeded.
//
// Two of the four sources need an API key:
//   COURTLISTENER_API_TOKEN — https://www.courtlistener.com/help/api/rest/
//   GOVINFO_API_KEY         — https://api.data.gov/signup/
// Federal Register and eCFR are open APIs, no auth.

const TIMEOUT_MS = 12_000;

export type LegalSourceKey =
    | "courtlistener"
    | "govinfo"
    | "federal_register"
    | "ecfr";

export type LegalSearchResult = {
    title: string;
    url: string;
    snippet: string;
    source: string; // human-readable, e.g. "CourtListener"
    date?: string;
    // Source-specific extras kept loose so callers / the model can ignore.
    extras?: Record<string, string>;
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

async function searchCourtListener(
    query: string,
    count: number,
): Promise<LegalSearchResult[]> {
    const token = process.env.COURTLISTENER_API_TOKEN ?? "";
    if (!token) {
        console.warn(
            "[legalSearch] COURTLISTENER_API_TOKEN not set — CourtListener search unavailable",
        );
        return [];
    }
    const params = new URLSearchParams({
        q: query,
        type: "o",
        page_size: String(count),
    });
    const resp = await fetchWithTimeout(
        `https://www.courtlistener.com/api/rest/v4/search/?${params}`,
        {
            headers: {
                Authorization: `Token ${token}`,
                Accept: "application/json",
            },
        },
    );
    if (!resp.ok) {
        throw new Error(`CourtListener HTTP ${resp.status}`);
    }
    const data = (await resp.json()) as {
        results?: Array<Record<string, unknown>>;
    };
    const rows = (data.results ?? []).slice(0, count);
    return rows.map((item) => {
        const absoluteUrl = (item.absolute_url as string) ?? "";
        return {
            title:
                (item.caseName as string) ?? (item.case_name as string) ?? "",
            url: absoluteUrl
                ? `https://www.courtlistener.com${absoluteUrl}`
                : "",
            snippet: ((item.snippet as string) ?? "").slice(0, 500),
            source: "CourtListener",
            date:
                (item.dateFiled as string) ??
                (item.date_filed as string) ??
                undefined,
            extras: { court: (item.court as string) ?? "" },
        };
    });
}

async function searchGovInfo(
    query: string,
    count: number,
): Promise<LegalSearchResult[]> {
    const apiKey = process.env.GOVINFO_API_KEY ?? "";
    if (!apiKey) {
        console.warn(
            "[legalSearch] GOVINFO_API_KEY not set — GovInfo search unavailable",
        );
        return [];
    }
    const params = new URLSearchParams({
        query,
        pageSize: String(count),
        offsetMark: "*",
        api_key: apiKey,
    });
    const resp = await fetchWithTimeout(
        `https://api.govinfo.gov/search?${params}`,
        { headers: { Accept: "application/json" } },
    );
    if (!resp.ok) {
        throw new Error(`GovInfo HTTP ${resp.status}`);
    }
    const data = (await resp.json()) as {
        results?: Array<Record<string, unknown>>;
    };
    const rows = (data.results ?? []).slice(0, count);
    return rows.map((item) => ({
        title: (item.title as string) ?? "",
        url: (item.packageLink as string) ?? "",
        snippet: ((item.description as string) ?? "").slice(0, 500),
        source: "GovInfo",
        date: (item.dateIssued as string) ?? undefined,
        extras: { collection: (item.collectionCode as string) ?? "" },
    }));
}

async function searchFederalRegister(
    query: string,
    count: number,
): Promise<LegalSearchResult[]> {
    const params = new URLSearchParams({
        "conditions[term]": query,
        per_page: String(count),
        order: "relevance",
    });
    const resp = await fetchWithTimeout(
        `https://www.federalregister.gov/api/v1/documents.json?${params}`,
    );
    if (!resp.ok) {
        throw new Error(`FederalRegister HTTP ${resp.status}`);
    }
    const data = (await resp.json()) as {
        results?: Array<Record<string, unknown>>;
    };
    const rows = (data.results ?? []).slice(0, count);
    return rows.map((item) => ({
        title: (item.title as string) ?? "",
        url: (item.html_url as string) ?? "",
        snippet: (
            (item.abstract as string) ??
            (item.excerpt as string) ??
            ""
        ).slice(0, 500),
        source: "Federal Register",
        date: (item.publication_date as string) ?? undefined,
        extras: { doc_type: (item.type as string) ?? "" },
    }));
}

async function searchECFR(
    query: string,
    count: number,
): Promise<LegalSearchResult[]> {
    const params = new URLSearchParams({
        query,
        per_page: String(count),
    });
    const resp = await fetchWithTimeout(
        `https://www.ecfr.gov/api/search/v1/results?${params}`,
    );
    if (!resp.ok) {
        throw new Error(`eCFR HTTP ${resp.status}`);
    }
    const data = (await resp.json()) as {
        results?: Array<Record<string, unknown>>;
    };
    const rows = (data.results ?? []).slice(0, count);
    return rows.map((item) => {
        const headings = (item.headings as Record<string, unknown>) ?? {};
        const hierarchy = (item.hierarchy as Record<string, unknown>) ?? {};
        const titleNum = (hierarchy.title as string) ?? "";
        const section = (hierarchy.section as string) ?? "";
        const heading =
            (headings.section as string) ??
            `Title ${titleNum}, Section ${section}`;
        const structureIndex = (item.structure_index as string) ?? "";
        return {
            title: heading,
            url: structureIndex
                ? `https://www.ecfr.gov/current/${structureIndex}`
                : "https://www.ecfr.gov/",
            snippet: (
                (item.full_text_excerpt as string) ??
                heading ??
                ""
            ).slice(0, 500),
            source: "eCFR",
            extras: { cfr_title: titleNum, section },
        };
    });
}

const SOURCE_FUNCTIONS: Record<
    LegalSourceKey,
    (query: string, count: number) => Promise<LegalSearchResult[]>
> = {
    courtlistener: searchCourtListener,
    govinfo: searchGovInfo,
    federal_register: searchFederalRegister,
    ecfr: searchECFR,
};

export const ALL_LEGAL_SOURCES: LegalSourceKey[] = [
    "courtlistener",
    "govinfo",
    "federal_register",
    "ecfr",
];

export async function legalSearch(
    query: string,
    sources?: LegalSourceKey[],
    countPerSource = 3,
): Promise<LegalSearchResult[]> {
    const requested =
        sources && sources.length > 0
            ? sources.filter((s): s is LegalSourceKey => s in SOURCE_FUNCTIONS)
            : ALL_LEGAL_SOURCES;
    const settled = await Promise.allSettled(
        requested.map((s) => SOURCE_FUNCTIONS[s](query, countPerSource)),
    );
    const out: LegalSearchResult[] = [];
    for (let i = 0; i < settled.length; i++) {
        const r = settled[i];
        if (r.status === "fulfilled") {
            out.push(...r.value);
        } else {
            console.warn(
                `[legalSearch] source ${requested[i]} failed:`,
                r.reason,
            );
        }
    }
    return out;
}

export function formatLegalResultsForModel(
    results: LegalSearchResult[],
): string {
    if (results.length === 0) {
        return "No results found across the requested legal databases.";
    }
    return results
        .map((r) => {
            const meta = [r.source, r.date].filter(Boolean).join(" · ");
            const linkLine = r.url
                ? `[${r.title}](${r.url}) (${meta})`
                : `${r.title} (${meta})`;
            return `${linkLine}\n${r.snippet}`;
        })
        .join("\n\n");
}
