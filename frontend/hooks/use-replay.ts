"use client";

import { useEffect, useState } from "react";

import type { ReplaySlice } from "@/lib/agent/replay";

/**
 * The recorded replay slice, fetched from `/api/data/replay`.
 *
 * The odds are read out of MongoDB by that route, server-side — the browser never sees a
 * connection string, and the page no longer depends on a checked-in export that only existed
 * on the capture machine.
 *
 * There is deliberately NO fallback. If the read fails, `error` is set and the UI renders an
 * honest empty state; it never degrades into a stale or invented series, which on an odds
 * chart would be indistinguishable from real prices.
 */

export interface ReplayState {
  slice: ReplaySlice | null;
  loading: boolean;
  error: string | null;
}

export function useReplay(): ReplayState {
  const [state, setState] = useState<ReplayState>({
    slice: null,
    loading: true,
    error: null,
  });

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch("/api/data/replay");
        const body = await res.json();
        if (!alive) return;
        if (!res.ok) {
          setState({
            slice: null,
            loading: false,
            error: typeof body?.error === "string" ? body.error : "The capture could not be read.",
          });
          return;
        }
        setState({ slice: body as ReplaySlice, loading: false, error: null });
      } catch {
        if (!alive) return;
        setState({
          slice: null,
          loading: false,
          error: "The capture database could not be reached from this deployment.",
        });
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  return state;
}
