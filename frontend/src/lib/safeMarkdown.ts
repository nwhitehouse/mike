const ALLOWED_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:"]);

export function safeMarkdownUrl(value: string): string {
    const href = value.trim();
    if (!href) return "";
    if (href.startsWith("#") || href.startsWith("/") || href.startsWith("./")) {
        return href;
    }

    try {
        const url = new URL(href);
        return ALLOWED_PROTOCOLS.has(url.protocol) ? href : "";
    } catch {
        return "";
    }
}

export function safeExternalHref(value: string | undefined): string | null {
    if (!value) return null;
    const href = safeMarkdownUrl(value);
    return href || null;
}
