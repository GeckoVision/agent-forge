"use client";

import { useSyncExternalStore } from "react";

/** Subscribe the clock to the system time — one tick per second. */
function subscribe(onChange: () => void) {
  const id = setInterval(onChange, 1000);
  return () => clearInterval(id);
}

/** Client snapshot: the current wall-clock second (a fresh number each tick,
 * stable within the same second so React doesn't spin). */
function getSnapshot(): number | null {
  return Math.floor(Date.now() / 1000);
}

/** Server + first-client (hydration) snapshot: null → a static placeholder, so
 * the SSR markup and the first client render are identical. No hydration
 * mismatch; the real time swaps in only after hydration. */
function getServerSnapshot(): number | null {
  return null;
}

/**
 * The footer meta row's LEFT cell: a live local clock (HH:MM:SS, ticking every
 * second) + the date + the active network.
 *
 * Subscribes to the system clock via {@link useSyncExternalStore} — the
 * SSR-safe React primitive for external mutable sources. The tick is
 * information, not decoration, so it is intentionally exempt from reduced-motion
 * (nothing here animates via CSS).
 */
export function FooterClock() {
  const epochSeconds = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getServerSnapshot,
  );
  const now = epochSeconds === null ? null : new Date(epochSeconds * 1000);

  const time = now ? now.toLocaleTimeString([], { hour12: false }) : "--:--:--";
  const date = now
    ? now.toLocaleDateString([], {
        year: "numeric",
        month: "short",
        day: "2-digit",
      })
    : "————";

  return (
    <div className="flex flex-col gap-1.5">
      <span className="flex items-center gap-2">
        <span className="tabular text-sm font-medium tracking-wide text-foreground">
          {time}
        </span>
        <span aria-hidden className="size-1.5 rounded-full bg-primary" />
      </span>
      <span className="mono-s text-muted-foreground/70">
        {date} · Solana Devnet
      </span>
    </div>
  );
}
