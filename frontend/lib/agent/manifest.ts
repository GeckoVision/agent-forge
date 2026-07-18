import manifestJson from "@/data/agent-replay.json";

import type { DetectedMove } from "./replay";

/**
 * What the REAL Python `SharpDetector` concluded about the capture — the only part of the
 * agent's odds story that is still a checked-in artifact, and the only part that has to be.
 *
 * `backend/gorilla/web_export.py` replays the whole captured book for a fixture through the
 * real detector and writes `data/agent-replay.json`. The detector is stateful across all
 * 16,781 of that fixture's readings across every market; it cannot run in the browser, and
 * re-deriving it per request would mean scanning the whole fixture. So its VERDICT ships as
 * data — which fixture, which price line, which moves crossed the threshold — and the prices
 * themselves are read from MongoDB (see `lib/mongo/replay.ts`).
 *
 * Two keys of that file are deliberately NOT surfaced here, so nothing can quietly fall back
 * to them:
 *
 * * `series` — superseded by the Mongo read.
 * * `line.windowStart` / `line.windowEnd` — offsets into the export's OWN copy of the series,
 *   which is shorter than the database's (178 readings vs 335 for the same line). Applying
 *   them to the Mongo series charted a window that ended before the flagged move, so the
 *   chart never highlighted the move its own caption described. The window is re-derived from
 *   the move instead — see `windowFor` in `lib/mongo/replay.ts`.
 */

export interface ReplayManifest {
  fixtureId: number;
  detector: {
    thresholdPct: number;
    readingsObserved: number;
    movesFlagged: number;
  };
  line: {
    bookmaker: string;
    market: string;
    outcome: string;
  };
  moves: DetectedMove[];
}

export const MANIFEST: ReplayManifest = {
  fixtureId: manifestJson.fixture.id,
  detector: manifestJson.detector,
  line: {
    bookmaker: manifestJson.line.bookmaker,
    market: manifestJson.line.market,
    outcome: manifestJson.line.outcome,
  },
  moves: manifestJson.moves as DetectedMove[],
};
