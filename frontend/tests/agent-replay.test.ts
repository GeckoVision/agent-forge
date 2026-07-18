import { describe, expect, it } from "vitest";

import { MANIFEST } from "@/lib/agent/manifest";
import { POLICY } from "@/lib/agent/policy";
import {
  fixtureLabel,
  lineLabel,
  moveIndex,
  movesOnThisLine,
  provenanceLabel,
  type ReplaySlice,
} from "@/lib/agent/replay";
import { buildReplaySlice, ReplayUnavailableError, type ReplayReaders } from "@/lib/mongo/replay";
import type { Dataset, FixtureMeta, Reading } from "@/lib/mongo/types";

const DATASET: Dataset = "worldcup_prematch";

/**
 * The /agent page's odds now come from MongoDB, so these tests exercise the COMPOSITION —
 * manifest + database reads → slice — through light fakes standing in for the two reads.
 * No database is required, so the honesty contract is falsifiable offline.
 *
 * They assert the two ways this page could regress into fiction: data that isn't real, and
 * data that is real but dishonestly labelled.
 */

const FIXTURE: FixtureMeta = {
  fixtureId: MANIFEST.fixtureId,
  dataset: "worldcup_prematch",
  participant1: "France",
  participant2: "England",
  competition: "World Cup",
  competitionId: 72,
  kickoffMs: 1784408400000,
  bookmakers: ["TXLineStablePriceDemargined"],
  oddsUpdateCount: 16781,
  oddsFirstTs: 1784150176886,
  oddsLastTs: 1784343786980,
  settled: false,
  outcome: null,
  participant1Goals: null,
  participant2Goals: null,
};

const MOVE = MANIFEST.moves.find(
  (m) => m.market === MANIFEST.line.market && m.outcome === MANIFEST.line.outcome,
)!;

/**
 * A line's worth of readings with the real flagged move planted at `moveAt`.
 *
 * `moveAt` is a parameter because the position of the move within the line is exactly what
 * differs between the export's copy of the series and the database's — the discrepancy that
 * produced the "chart never highlights the move" bug.
 */
function fakeSeries(length = 335, moveAt = 200): Reading[] {
  const step = 1000;
  const base = MOVE.ts - moveAt * step;
  const out: Reading[] = [];
  for (let i = 0; i < length; i++) {
    out.push({ ts: base + i * step, pct: 70 + (i % 7) * 0.5 });
  }
  out[moveAt] = { ts: MOVE.ts, pct: MOVE.new_pct };
  return out;
}

function readers(over: Partial<ReplayReaders> = {}): ReplayReaders {
  return {
    readFixture: async () => FIXTURE,
    readLine: async () => fakeSeries(),
    ...over,
  };
}

const slice = (): Promise<ReplaySlice> =>
  buildReplaySlice({ dataset: DATASET, readers: readers() });

describe("recorded replay composed from the capture database", () => {
  it("is labelled recorded, never live — even though it is served from a database", async () => {
    const s = await slice();
    expect(s.provenance.kind).toBe("recorded-replay");
    expect(s.provenance.store).toBe("mongodb");
    expect(provenanceLabel(s).toLowerCase()).toContain("recorded replay");
    expect(provenanceLabel(s).toLowerCase()).not.toContain("live");
    expect(s.provenance.note.toLowerCase()).toContain("recorded, not live");
  });

  it("carries the real fixture identity so the data is auditable", async () => {
    const s = await slice();
    expect(s.fixture.id).toBeGreaterThan(0);
    expect(s.fixture.competition).toBe("World Cup");
    expect(fixtureLabel(s)).toMatch(/ v /);
    expect(s.fixture.kickoffMs).toBeGreaterThan(0);
  });

  it("reports the capture window the database actually holds", async () => {
    const s = await slice();
    expect(s.provenance.captureFromMs).toBe(FIXTURE.oddsFirstTs);
    expect(s.provenance.captureToMs).toBe(FIXTURE.oddsLastTs);
    expect(s.provenance.dataset).toBe("worldcup_prematch");
  });

  it("ships an ordered, non-empty series of real timestamps", async () => {
    const s = await slice();
    expect(s.series.length).toBeGreaterThan(1);
    const timestamps = s.series.map((r) => r.ts);
    expect([...timestamps].sort((a, b) => a - b)).toEqual(timestamps);
    for (const reading of s.series) {
      expect(reading.ts).toBeGreaterThan(1_700_000_000_000);
      expect(reading.pct).toBeGreaterThan(0);
      expect(reading.pct).toBeLessThan(100);
    }
  });

  it("states the window it is a window OF, so nothing is implied about the rest", async () => {
    const s = await slice();
    expect(s.line.readingsOnLine).toBeGreaterThanOrEqual(s.series.length);
    expect(s.line.windowEnd - s.line.windowStart).toBe(s.series.length);
    expect(s.detector.readingsObserved).toBeGreaterThan(s.series.length);
  });

  it("shows a move the real detector flagged, on the line being charted", async () => {
    const s = await slice();
    const [move] = movesOnThisLine(s);
    expect(move).toBeDefined();
    expect(Math.abs(move.delta_pct)).toBeGreaterThanOrEqual(s.detector.thresholdPct);
    expect(move.new_pct - move.old_pct).toBeCloseTo(move.delta_pct, 2);
    expect(moveIndex(s)).toBeGreaterThanOrEqual(0);
    expect(s.series[moveIndex(s)].pct).toBeCloseTo(move.new_pct, 3);
  });

  it("renders the raw line id into a label without losing the parameters", async () => {
    const s = await slice();
    expect(lineLabel(s)).toContain(s.line.market.split("|")[1].replace("line=", ""));
  });

  /**
   * REGRESSION: the window used to be fixed offsets carried in the export artifact. Those
   * offsets index the export's OWN copy of the line, and the database's copy need not agree
   * with it — an earlier load returned 335 readings where the export had 178, so the window
   * landed well before the move and the chart rendered 40 real readings without ever
   * highlighting the move its caption described. The window must be derived from the move, so
   * that wherever the move sits in the line — and however the capture is reloaded — it is
   * charted. Parameterised over the move's position for exactly that reason.
   */
  it.each([12, 60, 200, 334])(
    "charts the flagged move wherever it sits in the line (index %i)",
    async (moveAt) => {
      const s = await buildReplaySlice({
        dataset: DATASET,
        readers: readers({ readLine: async () => fakeSeries(335, moveAt) }),
      });
      const at = moveIndex(s);
      expect(at).toBeGreaterThanOrEqual(0);
      expect(s.series[at].ts).toBe(MOVE.ts);
      expect(s.series[at].pct).toBeCloseTo(MOVE.new_pct, 3);
      // and the window is still a contiguous run of the line, ending just after the move
      expect(s.series.length).toBeLessThanOrEqual(40);
      expect(s.line.windowEnd - s.line.windowStart).toBe(s.series.length);
    },
  );
});

describe("recorded replay fails honestly", () => {
  it("refuses to render when the database holds no readings for the line", async () => {
    await expect(
      buildReplaySlice({ dataset: DATASET, readers: readers({ readLine: async () => [] }) }),
    ).rejects.toBeInstanceOf(ReplayUnavailableError);
  });

  it("refuses to render when the database holds no such fixture", async () => {
    await expect(
      buildReplaySlice({ dataset: DATASET, readers: readers({ readFixture: async () => null }) }),
    ).rejects.toBeInstanceOf(ReplayUnavailableError);
  });

  it("refuses to render when the database disagrees with the detector's move", async () => {
    // Real-shaped readings, but the flagged move is nowhere in them — the chart would
    // highlight a bar that is not the move described beside it.
    const shifted = fakeSeries().map((r) => ({ ts: r.ts + 7, pct: r.pct }));
    await expect(
      buildReplaySlice({ dataset: DATASET, readers: readers({ readLine: async () => shifted }) }),
    ).rejects.toBeInstanceOf(ReplayUnavailableError);
  });
});

describe("detector manifest", () => {
  it("is the real detector's verdict over the whole capture, not the charted window", () => {
    expect(MANIFEST.fixtureId).toBeGreaterThan(0);
    expect(MANIFEST.detector.thresholdPct).toBeGreaterThan(0);
    expect(MANIFEST.detector.readingsObserved).toBeGreaterThan(MANIFEST.detector.movesFlagged);
    expect(MANIFEST.moves.length).toBeGreaterThan(0);
    expect(MANIFEST.line.market).toBeTruthy();
    expect(MANIFEST.line.outcome).toBeTruthy();
  });

  it("does not expose the export's stale window offsets", () => {
    // They index a shorter, private copy of the series; applying them to the database's copy
    // silently mis-frames the chart. The type must keep them out of reach.
    expect("windowStart" in MANIFEST.line).toBe(false);
    expect("windowEnd" in MANIFEST.line).toBe(false);
  });
});

describe("agent policy artifact", () => {
  it("comes from the backend ChainPolicy, not the UI", () => {
    expect(POLICY.source).toContain("chain_policy");
    expect(POLICY.maxSpendSol).toBeGreaterThan(0);
    expect(POLICY.stakePerBetSol).toBeLessThanOrEqual(POLICY.maxPerFixtureSol);
    expect(POLICY.maxPerFixtureSol).toBeLessThanOrEqual(POLICY.maxSpendSol);
  });

  it("binds every allowed purpose to a real program + instruction", () => {
    expect(POLICY.allow.length).toBeGreaterThan(0);
    for (const binding of POLICY.allow) {
      expect(binding.programId).toHaveLength(44);
      expect(binding.instruction).toMatch(/^[a-z_]+$/);
    }
  });
});
