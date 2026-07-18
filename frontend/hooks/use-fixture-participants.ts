"use client";

import { useCallback, useEffect, useState } from "react";

import { DEMO_DATASET } from "@/lib/mongo/types";
import type { FixtureParticipants } from "@/lib/solana/predicate";

/**
 * Resolve `fixtureId → (participant1, participant2, kickoff)` from the SAME capture the rest
 * of the page reads (`/api/data/fixtures`), so the settlement UI can say "France vs England"
 * instead of "match #18257865", and can rank matches by kickoff.
 *
 * A `Market` account on chain carries only its `fixtureId` — the names live in the fixtures
 * capture. This reads the whole (small: ~100 fixtures) list ONCE and hands back a lookup. When
 * a fixture is not in the capture, the lookup returns `null` and every caller falls back to an
 * honest "Demo market #id"; names are never invented.
 */

/** What the capture knows about a match — as much of it as the settlement surfaces need. */
export interface FixtureInfo extends FixtureParticipants {
  /** Kickoff in epoch ms, or `null` when the capture has no kickoff for the fixture. */
  kickoffMs: number | null;
}

export type ParticipantsLookup = (fixtureId: bigint | number) => FixtureInfo | null;

interface FixtureRow {
  fixtureId: number;
  participant1?: string;
  participant2?: string;
  kickoffMs?: number;
}

interface FixturesResponse {
  fixtures?: FixtureRow[];
}

export function useFixtureParticipants(): {
  lookup: ParticipantsLookup;
  loading: boolean;
} {
  const [byId, setById] = useState<Map<number, FixtureInfo> | null>(null);

  useEffect(() => {
    let alive = true;
    // `limit` covers the whole capture (~100 fixtures); `dataset` is the app pin.
    fetch(`/api/data/fixtures?dataset=${DEMO_DATASET}&limit=500`)
      .then((res) => (res.ok ? (res.json() as Promise<FixturesResponse>) : null))
      .then((data) => {
        if (!alive) return;
        const map = new Map<number, FixtureInfo>();
        for (const row of data?.fixtures ?? []) {
          const p1 = (row.participant1 ?? "").trim();
          const p2 = (row.participant2 ?? "").trim();
          // Only index a fixture we can actually name on BOTH sides — a half-known
          // fixture would render "France vs " which is worse than the id.
          if (p1 && p2) {
            map.set(row.fixtureId, {
              participant1: p1,
              participant2: p2,
              // The loader writes 0 when the capture has no kickoff — treat it as unknown.
              kickoffMs: row.kickoffMs ? row.kickoffMs : null,
            });
          }
        }
        setById(map);
      })
      .catch(() => alive && setById(new Map()));
    return () => {
      alive = false;
    };
  }, []);

  // Stable identity per fetch result, so memos keyed on the lookup don't re-run every render.
  const lookup: ParticipantsLookup = useCallback(
    (fixtureId) => byId?.get(Number(fixtureId)) ?? null,
    [byId],
  );

  return { lookup, loading: byId === null };
}
