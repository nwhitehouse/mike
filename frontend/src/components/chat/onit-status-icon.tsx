"use client";

import Image from "next/image";

// Per-cell delay table for the "drift" variant — hand-tuned non-sequential
// pattern so the animation feels organic rather than mechanical. Ported
// from work___ UI System UPGRADE/components/loaders.jsx.
const DRIFT_DELAYS_MS: number[][] = [
    [0, 900, 1500],
    [1100, 300, 600],
    [700, 1700, 200],
];

const DRIFT_DURATION_MS = 2600;

// Matches the brand mark fill (Onit dark navy, near-black).
const GRID_COLOR = "#00112c";

const FADE_MS = 320;

function DriftGrid({ size }: { size: number }) {
    const gap = 2;
    const cell = Math.floor((size - 4) / 3);
    const cellRadius = Math.max(1, Math.round(cell * 0.25));
    return (
        <span
            aria-hidden
            style={{
                display: "inline-grid",
                gridTemplateColumns: `repeat(3, ${cell}px)`,
                gridTemplateRows: `repeat(3, ${cell}px)`,
                gap: `${gap}px`,
                width: size,
                height: size,
            }}
        >
            {Array.from({ length: 9 }).map((_, i) => {
                const col = i % 3;
                const row = Math.floor(i / 3);
                const delay = DRIFT_DELAYS_MS[row][col];
                return (
                    <span
                        key={i}
                        style={{
                            background: GRID_COLOR,
                            borderRadius: cellRadius,
                            animation: `gridPulse ${DRIFT_DURATION_MS}ms ease-in-out infinite`,
                            animationDelay: `${delay}ms`,
                            opacity: 0.22,
                            display: "block",
                        }}
                    />
                );
            })}
        </span>
    );
}

export function OnitStatusIcon({
    spin = false,
    size = 22,
}: {
    spin?: boolean;
    size?: number;
}) {
    // Cross-fade: render both, toggle opacities. Feels like the logo
    // "thinks" in grid mode and settles back to static when done.
    return (
        <span
            aria-label={spin ? "Working" : "Olava"}
            style={{
                position: "relative",
                display: "inline-block",
                width: size,
                height: size,
                lineHeight: 0,
            }}
        >
            <span
                style={{
                    position: "absolute",
                    inset: 0,
                    opacity: spin ? 1 : 0,
                    transition: `opacity ${FADE_MS}ms ease`,
                    pointerEvents: "none",
                }}
            >
                <DriftGrid size={size} />
            </span>
            <span
                style={{
                    position: "absolute",
                    inset: 0,
                    opacity: spin ? 0 : 1,
                    transition: `opacity ${FADE_MS}ms ease`,
                    pointerEvents: "none",
                }}
            >
                <Image
                    src="/onit-mark-dark.svg"
                    alt=""
                    width={size}
                    height={size}
                    priority
                />
            </span>
        </span>
    );
}
