import type { ErrorRequestHandler, RequestHandler } from "express";
import helmet from "helmet";

const LOCAL_DEV_ORIGINS = ["http://localhost:9000", "http://localhost:3000"];

export function parseAllowedOrigins(
    env: NodeJS.ProcessEnv = process.env,
): Set<string> {
    const origins = new Set<string>();
    const add = (value?: string) => {
        const trimmed = value?.trim();
        if (trimmed) origins.add(trimmed);
    };

    add(env.FRONTEND_URL);
    for (const raw of (env.ADDITIONAL_CORS_ORIGINS ?? "").split(",")) {
        add(raw);
    }

    if (env.NODE_ENV !== "production") {
        for (const origin of LOCAL_DEV_ORIGINS) origins.add(origin);
    }

    return origins;
}

export function isOriginAllowed(
    origin: string | undefined,
    allowedOrigins = parseAllowedOrigins(),
): boolean {
    if (!origin) return true;
    return allowedOrigins.has(origin);
}

export function securityHeaders(): RequestHandler {
    return helmet({
        crossOriginEmbedderPolicy: false,
        contentSecurityPolicy: false,
    });
}

export function requestErrorHandler(): ErrorRequestHandler {
    return (err, _req, res, next) => {
        if (!err) return next();
        if (err.type === "entity.too.large") {
            return void res
                .status(413)
                .json({ detail: "Request body too large" });
        }
        if (err.message?.startsWith("CORS:")) {
            return void res.status(403).json({ detail: "Origin not allowed" });
        }
        next(err);
    };
}
