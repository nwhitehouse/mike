"use client";

/**
 * feat-020 — Three-way segmented control for theme mode.
 * Lives in /account settings; reusable elsewhere if we ever want a
 * second placement.
 */

import { Monitor, Moon, Sun } from "lucide-react";
import { useTheme, type ThemeMode } from "@/app/contexts/ThemeContext";

const OPTIONS: { value: ThemeMode; label: string; icon: typeof Sun }[] = [
    { value: "system", label: "System", icon: Monitor },
    { value: "light", label: "Light", icon: Sun },
    { value: "dark", label: "Dark", icon: Moon },
];

export function ThemeToggle() {
    const { mode, setMode } = useTheme();
    return (
        <div
            role="radiogroup"
            aria-label="Theme"
            className="inline-flex rounded-md border border-border bg-muted p-0.5"
        >
            {OPTIONS.map(({ value, label, icon: Icon }) => {
                const active = mode === value;
                return (
                    <button
                        key={value}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        onClick={() => setMode(value)}
                        className={`flex items-center gap-1.5 rounded px-3 py-1.5 text-sm transition-colors ${
                            active
                                ? "bg-background text-foreground shadow-sm"
                                : "text-muted-foreground hover:text-foreground"
                        }`}
                    >
                        <Icon className="h-4 w-4" />
                        {label}
                    </button>
                );
            })}
        </div>
    );
}
