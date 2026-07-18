import { MANIFEST, type ReplayManifest } from "@/lib/agent/manifest";
import type { ReplaySlice } from "@/lib/agent/replay";

import { fixtureMeta } from "./fixtures";
import { type LineSelector, lineSeries } from "./odds";
import {
  CAPTURE_BOOKMAKER_ID,
  type Dataset,
  FULL_MATCH,
  marketPeriodOf,
  type Reading,
} from "./types";

/**
 * Compose the `/agent` replay slice: the REAL captured odds, read from MongoDB at request
 * time, joined to the REAL detector's output.
 *
 * The split matters, and the UI's honesty depends on it:
 *
 * * The **odds** — every `ts` and every `pct` — are read here, live, out of `odds_updates`.
 *   They used to be a checked-in JSON export, which worked on the capture machine and was
 *   invisible to a deploy. This is what makes the deployed page show real data.
 * * The **detector output** — the threshold, the readings observed, and which moves crossed —
 *   comes from {@link MANIFEST}, a ~1KB artifact written by the real Python `SharpDetector`
 *   over the whole capture. It is not recomputed here. Re-implementing the detector in
 *   TypeScript and calling the result "the real detector" would be a lie, and scanning all
 *   16,781 of the fixture's readings per request to redo it would be the wrong shape anyway.
 *
 * The two stay consistent because the series fetched is exactly the line the detector fired
 * on — same fixture, same market, same outcome — and {@link verifyMove} re-checks that the
 * flagged move's price is actually present in the readings that came back from Mongo.
 *
 * It is a RECORDED REPLAY either way. Serving it from a database does not make it live, and
 * nothing here may ever label it so.
 */

/** The composed slice could not be built from real data. The UI must then show nothing. */
export class ReplayUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplayUnavailableError";
  }
}

/**
 * How many consecutive readings to chart, and how many of them sit AFTER the move — mirrors
 * `DEFAULT_WINDOW` / `READINGS_AFTER_MOVE` in `backend/gorilla/web_export.py`.
 */
const WINDOW = 40;
const READINGS_AFTER_MOVE = 6;

/**
 * The contiguous window to chart, anchored on the MOVE rather than on stored indices.
 *
 * The manifest's `windowStart`/`windowEnd` were computed against the export's own copy of the
 * series and are meaningless against Mongo's, because the two need not agree on how many
 * readings the line holds — a reload can lengthen or shorten it. (They happen to agree at 178
 * after the corrected reload; an earlier load returned 335 for the same line, and trusting the
 * stored indices then charted 40 real readings that ENDED BEFORE the flagged move, so the
 * chart silently never highlighted the move it described in the caption beside it.)
 *
 * Choosing which 40 readings to show is presentation, not detection: the move itself still
 * comes from the real Python detector. So the window is re-derived here by the same rule the
 * exporter uses — end shortly after the move, take the preceding readings — which keeps the
 * chart and the signal describing the same moment however the capture is reloaded.
 */
function windowFor(series: Reading[], moveTs: number | null): { start: number; end: number } {
  const at = moveTs === null ? -1 : series.findIndex((r) => r.ts === moveTs);
  const anchor = at >= 0 ? at : series.length - 1;
  const end = Math.min(series.length, anchor + 1 + READINGS_AFTER_MOVE);
  return { start: Math.max(0, end - WINDOW), end };
}

/**
 * Does the move the Python detector flagged actually appear in the Mongo series?
 *
 * A silent disagreement between the artifact and the database — a re-load that shifted the
 * capture, a market renamed — would render a chart whose highlighted bar is not the move
 * described beside it. Cheap to check, so it is checked.
 */
function focusMove(manifest: ReplayManifest) {
  return (
    manifest.moves.find(
      (m) => m.market === manifest.line.market && m.outcome === manifest.line.outcome,
    ) ?? null
  );
}

function verifyMove(series: Reading[], manifest: ReplayManifest): boolean {
  const move = focusMove(manifest);
  if (!move) return true; // nothing claimed about this line, nothing to contradict
  return series.some((r) => r.ts === move.ts && Math.abs(r.pct - move.new_pct) < 0.01);
}

/**
 * The two reads this composition needs, as an injectable seam.
 *
 * Production passes the MongoDB implementations; tests pass light fakes, so every honesty
 * invariant below — recorded labelling, window bounds, series/move agreement — is falsifiable
 * offline with no database. Same code path either way; only the reads differ.
 */
export interface ReplayReaders {
  readFixture: typeof fixtureMeta;
  readLine: typeof lineSeries;
}

const MONGO_READERS: ReplayReaders = { readFixture: fixtureMeta, readLine: lineSeries };

export interface ReplayQuery {
  /**
   * REQUIRED — no default. 106 fixture ids exist in both captures, so a dataset-less compose
   * would read one capture's fixture metadata against the other's odds without complaining.
   */
  dataset: Dataset;
  manifest?: ReplayManifest;
  readers?: ReplayReaders;
}

export async function buildReplaySlice(query: ReplayQuery): Promise<ReplaySlice> {
  const manifest = query.manifest ?? MANIFEST;
  const { dataset } = query;
  const { readFixture, readLine } = query.readers ?? MONGO_READERS;
  const { fixtureId } = manifest;

  /**
   * The FULL-MATCH line, stated explicitly.
   *
   * TxLINE interleaves the full-match and first-half lines of a market family, and the
   * detector fired on the full-match one. Without the period predicate the read would return
   * both, blended into a single sawtooth series that no book ever showed — and it would read
   * as more data, not as a bug. Asserted against the market key so the two cannot drift.
   */
  const selector: LineSelector = {
    fixtureId,
    market: manifest.line.market,
    dataset,
    period: FULL_MATCH,
    bookmakerId: CAPTURE_BOOKMAKER_ID,
  };
  if (marketPeriodOf(selector.market) !== FULL_MATCH) {
    throw new ReplayUnavailableError(
      `The detector's artifact names "${selector.market}", which is not a full-match line. ` +
        "The chart claims to draw the full-match line, so nothing is shown.",
    );
  }

  const [fixture, series] = await Promise.all([
    readFixture(fixtureId, dataset),
    readLine(selector, manifest.line.outcome),
  ]);

  if (!fixture) {
    throw new ReplayUnavailableError(
      `The capture in MongoDB holds no fixture ${fixtureId} in dataset "${dataset}".`,
    );
  }
  if (series.length === 0) {
    throw new ReplayUnavailableError(
      `The capture in MongoDB holds no full-match readings of ${manifest.line.market} · ` +
        `${manifest.line.outcome} for fixture ${fixtureId} in dataset "${dataset}".`,
    );
  }
  if (!verifyMove(series, manifest)) {
    throw new ReplayUnavailableError(
      "The detected move is not present in the readings MongoDB returned — the artifact and " +
        "the database disagree, so nothing is shown rather than a chart that misstates itself.",
    );
  }

  const move = focusMove(manifest);
  const { start, end } = windowFor(series, move?.ts ?? null);

  return {
    provenance: {
      kind: "recorded-replay",
      source: "TxODDS TxLINE",
      note:
        "Real captured wire records, read from MongoDB and replayed through the real " +
        "detector's output. Recorded, not live.",
      // The capture's real bounds, as the database reports them for this fixture.
      captureFromMs: fixture.oddsFirstTs,
      captureToMs: fixture.oddsLastTs,
      generatedAt: new Date().toISOString(),
      store: "mongodb",
      dataset,
    },
    fixture: {
      id: fixture.fixtureId,
      participant1: fixture.participant1,
      participant2: fixture.participant2,
      competition: fixture.competition,
      competitionId: fixture.competitionId,
      kickoffMs: fixture.kickoffMs,
    },
    detector: {
      thresholdPct: manifest.detector.thresholdPct,
      readingsObserved: manifest.detector.readingsObserved,
      movesFlagged: manifest.detector.movesFlagged,
    },
    line: {
      bookmaker: manifest.line.bookmaker,
      market: manifest.line.market,
      period: selector.period,
      outcome: manifest.line.outcome,
      readingsOnLine: series.length,
      windowStart: start,
      windowEnd: end,
    },
    series: series.slice(start, end),
    moves: manifest.moves,
  };
}
