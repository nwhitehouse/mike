const URL_ATTRS = new Set(["href", "src", "xlink:href"]);

export function sanitizeRenderedHtml(root: HTMLElement): void {
    const nodes = root.querySelectorAll<HTMLElement>("*");
    nodes.forEach((node) => {
        for (const attr of Array.from(node.attributes)) {
            const name = attr.name.toLowerCase();
            const value = attr.value.trim().toLowerCase();
            if (name.startsWith("on")) {
                node.removeAttribute(attr.name);
                continue;
            }
            if (URL_ATTRS.has(name) && value.startsWith("javascript:")) {
                node.removeAttribute(attr.name);
            }
        }

        if (node.tagName.toLowerCase() === "a") {
            node.setAttribute("rel", "noopener noreferrer");
            node.setAttribute("target", "_blank");
        }
    });

    root.querySelectorAll("script, iframe, object, embed").forEach((node) => {
        node.remove();
    });
}
