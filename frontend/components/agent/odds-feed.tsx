"use client";

import { History, TrendingDown, TrendingUp } from "lucide-react";

import {
  type ReplaySlice,
  formatCaptureDate,
  formatCaptureTime,
  lineLabel,
  moveIndex,
} from "@/lib/agent/replay";
import { cn } from "@/lib/utils";

/** Chart bounds from the real series, padded — never a fixed scale that could flatter a move. */
function bounds(values: number[]): { min: number; max: number } {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const pad = Math.max((max - min) * 0.15, 0.5);
  return { min: min - pad, max: max + pad };
}

/**
 * The real captured odds series the agent read, revealed reading by reading.
 *
 * Every bar is one real reading from the TxLINE capture — real timestamp, real implied
 * probability — read from MongoDB by `/api/data/replay` and NOT downsampled, so the window
 * stays the contiguous run of readings the claim above describes. This is a RECORDED replay,
 * and the header says so.
 */
export function OddsFeed({ revealed, slice }: { revealed: number; slice: ReplaySlice }) {
  const { series, line, provenance, fixture, detector } = slice;
  const flaggedAt = moveIndex(slice);
  const shown = Math.min(revealed, series.length);
  const current = series[Math.max(shown - 1, 0)];
  const flagged = flaggedAt >= 0 && shown > flaggedAt;
  const move = slice.moves[0];
  const { min, max } = bounds(series.map((r) => r.pct));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <History className="size-4 text-accent" />
          Recorded replay · real {provenance.source} capture
        </span>
        <span className="tabular text-xs text-muted-foreground">
          reading {shown}/{series.length} of {line.readingsOnLine} on this line
        </span>
      </div>

      <p className="text-xs leading-relaxed text-muted-foreground">
        {fixture.competition} · {fixture.participant1} v {fixture.participant2} ·{" "}
        <span className="font-mono">{lineLabel(slice)}</span> · {line.outcome} ·{" "}
        {line.bookmaker}
        <br />
        Captured {formatCaptureDate(provenance.captureFromMs)}; readings{" "}
        {line.windowStart}–{line.windowEnd} of the real book, replayed in order.
      </p>

      <div className="flex items-end justify-between gap-1 h-32 rounded-lg bg-background/40 p-3">
        {series.map((reading, i) => {
          const visible = i < shown;
          const isMove = i === flaggedAt;
          const lit = isMove && flagged;
          const t = (reading.pct - min) / (max - min);
          return (
            <div
              key={reading.ts}
              className="flex flex-1 flex-col items-center justify-end h-full"
              title={`${formatCaptureTime(reading.ts)} · ${reading.pct.toFixed(3)}%`}
            >
              <div
                className={cn(
                  "w-full rounded-sm transition-all duration-300",
                  !visible && "opacity-0",
                  lit
                    ? "bg-primary"
                    : isMove
                      ? "bg-accent/70"
                      : "bg-muted-foreground/25",
                )}
                style={{ height: visible ? `${Math.round(6 + t * 94)}%` : "0%" }}
              />
            </div>
          );
        })}
      </div>

      <div className="flex items-baseline justify-between gap-3">
        <div className="flex flex-col">
          <span className="text-xs text-muted-foreground">
            Implied P({line.outcome}) · {lineLabel(slice)}
          </span>
          <span className="tabular text-3xl font-semibold tracking-tight">
            {current.pct.toFixed(2)}
            <span className="text-lg text-muted-foreground">%</span>
          </span>
          <span className="tabular text-[11px] text-muted-foreground/80">
            {formatCaptureTime(current.ts)}
          </span>
        </div>
        {flagged && move && (
          <span className="flex items-center gap-1.5 rounded-md bg-primary/10 px-2 py-1 text-xs font-medium text-primary">
            {move.direction === "up" ? (
              <TrendingUp className="size-3.5" />
            ) : (
              <TrendingDown className="size-3.5" />
            )}
            {move.delta_pct > 0 ? "+" : ""}
            {move.delta_pct.toFixed(3)} pp · over the{" "}
            {detector.thresholdPct.toFixed(1)} pp threshold
          </span>
        )}
      </div>
    </div>
  );
}
