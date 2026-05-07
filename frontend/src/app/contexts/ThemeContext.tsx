"use client";

/**
 * feat-020 — Theme provider for light/dark/system mode.
 *
 * Wired in app/layout.tsx so the whole app is wrapped. The actual `class="dark"`
 * application also happens in a pre-hydration <script> in layout.tsx — that
 * runs before React mounts, so first paint is on the correct theme. This
 * provider takes over once React hydrates and keeps the class in sync with
 * `mode` + system preference changes.
 *
 * Persistence is localStorage only (per-device). DB-synced cross-device theme
 * is a follow-up if it becomes worth it.
 */

import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useState,
} from "react";

export type ThemeMode = "system" | "light" | "dark";

const STORAGE_KEY = "olava.theme";

type ThemeContextValue = {
    mode: ThemeMode;
    /** Resolved colour scheme being shown right now ('system' resolved against OS). */
    resolved: "light" | "dark";
    setMode: (mode: ThemeMode) => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

function readStoredMode(): ThemeMode {
    if (typeof window === "undefined") return "system";
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === "light" || raw === "dark" || raw === "system") return raw;
    return "system";
}

function systemPrefersDark(): boolean {
    if (typeof window === "undefined") return false;
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function applyClass(resolved: "light" | "dark") {
    if (typeof document === "undefined") return;
    const root = document.documentElement;
    if (resolved === "dark") root.classList.add("dark");
    else root.classList.remove("dark");
    // Lets browser paint native form controls etc. with the right scheme.
    root.style.colorScheme = resolved;
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
    // Initial state read once on mount. The pre-hydration script in
    // layout.tsx already set the correct class — this just gives React a
    // matching value so nothing flips on first render.
    const [mode, setModeState] = useState<ThemeMode>(() => readStoredMode());
    const [resolved, setResolved] = useState<"light" | "dark">(() => {
        const m = readStoredMode();
        if (m === "system") return systemPrefersDark() ? "dark" : "light";
        return m;
    });

    const recompute = useCallback((nextMode: ThemeMode) => {
        const next: "light" | "dark" =
            nextMode === "system"
                ? systemPrefersDark()
                    ? "dark"
                    : "light"
                : nextMode;
        applyClass(next);
        setResolved(next);
    }, []);

    const setMode = useCallback(
        (next: ThemeMode) => {
            try {
                window.localStorage.setItem(STORAGE_KEY, next);
            } catch {
                /* private browsing etc. — fall through, theme still applied */
            }
            setModeState(next);
            recompute(next);
        },
        [recompute],
    );

    // Keep the class in sync if the OS preference flips while the user is
    // on 'system' mode. No-op when mode is explicit.
    useEffect(() => {
        if (mode !== "system") return;
        const mq = window.matchMedia("(prefers-color-scheme: dark)");
        const handler = () => recompute("system");
        mq.addEventListener("change", handler);
        return () => mq.removeEventListener("change", handler);
    }, [mode, recompute]);

    // First mount: make sure resolved + class match what the pre-hydration
    // script set. Cheap belt-and-braces against any mismatch.
    useEffect(() => {
        recompute(mode);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    return (
        <ThemeContext.Provider value={{ mode, resolved, setMode }}>
            {children}
        </ThemeContext.Provider>
    );
}

export function useTheme(): ThemeContextValue {
    const ctx = useContext(ThemeContext);
    if (!ctx) {
        throw new Error("useTheme must be used within a ThemeProvider");
    }
    return ctx;
}
