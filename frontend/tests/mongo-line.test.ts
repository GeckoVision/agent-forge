import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { lineLabel, periodLabel, type ReplaySlice } from "@/lib/agent/replay";
import {
  downsampledSeries,
  type LineSelector,
  MarketPeriodMismatchError,
  seriesPage,
} from "@/lib/mongo/odds";
import { buildReplaySlice, type ReplayReaders } from "@/lib/mongo/replay";
import {
  CAPTURE_BOOKMAKER_ID,
  type Dataset,
  DEMO_DATASET,
  FIRST_HALF,
  FULL_MATCH,
  type FixtureMeta,
  marketPeriodOf,
  parseDataset,
  parseMarketPeriod,
} from "@/lib/mongo/types";

/**
 * The reload of the `gorilla` database introduced three changes that fail as WRONG ANSWERS
 * rather than errors, which is the dangerous kind. These tests pin each one, and they pin it
 * offline: no database is required, so the contract stays falsifiable without the capture.
 *
 *   1. `dataset` is mandatory — 106 fixture ids exist in both captures.
 *   2. market keys carry a period — `|None` is gone; full match and `half=1` are separate lines.
 *   3. `fixtures._id` is the composite `"<dataset>:<fixtureId>"`, so lookups go by
 *      `{dataset, fixtureId}` (covered by the read path in `lib/mongo/fixtures.ts`).
 */

const FIXTURE: FixtureMeta = {
  fixtureId: 18257865,
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

describe("dataset is a required predicate, never a silent default", () => {
  it("narrows an untrusted value but makes the caller name its own fallback", () => {
    expect(parseDataset("all_competitions", DEMO_DATASET)).toBe("all_competitions");
    expect(parseDataset("worldcup_prematch", DEMO_DATASET)).toBe("worldcup_prematch");
    // Anything unrecognised resolves to the fallback the CALL SITE chose, not a module default.
    expect(parseDataset("../etc/passwd", DEMO_DATASET)).toBe(DEMO_DATASET);
    expect(parseDataset(null, "all_competitions")).toBe("all_competitions");
  });

  it("pins the app to the World Cup pre-match capture", () => {
    expect(DEMO_DATASET).toBe("worldcup_prematch");
  });

  /**
   * The compiler is the real guard — `LineSelector`, `FixtureListQuery` and `ReplayQuery` all
   * make `dataset` required, so a dataset-less read does not typecheck. This asserts the
   * runtime half: whatever dataset the caller names is what actually reaches the query.
   */
  it("passes the caller's dataset through to the read, unchanged", async () => {
    for (const dataset of ["worldcup_prematch", "all_competitions"] as Dataset[]) {
      const seen = await captureSelector({ dataset });
      expect(seen.dataset).toBe(dataset);
    }
  });
});

describe("the charted line is the full-match line, explicitly", () => {
  it("selects meta.marketPeriod = '' and the capture's one bookmaker", async () => {
    const seen = await captureSelector({ dataset: "worldcup_prematch" });
    expect(seen.period).toBe(FULL_MATCH);
    expect(seen.period).toBe("");
    expect(seen.bookmakerId).toBe(CAPTURE_BOOKMAKER_ID);
  });

  it("reads a market key's own period, so a key and a predicate cannot disagree", () => {
    expect(marketPeriodOf("1X2_PARTICIPANT_RESULT")).toBe(FULL_MATCH);
    expect(marketPeriodOf("1X2_PARTICIPANT_RESULT|half=1")).toBe(FIRST_HALF);
    expect(marketPeriodOf("OVERUNDER_PARTICIPANT_GOALS|line=2")).toBe(FULL_MATCH);
    expect(marketPeriodOf("OVERUNDER_PARTICIPANT_GOALS|line=2|half=1")).toBe(FIRST_HALF);
  });

  it("parses an untrusted period, fallback named by the caller", () => {
    expect(parseMarketPeriod("half=1", FULL_MATCH)).toBe(FIRST_HALF);
    expect(parseMarketPeriod("", FULL_MATCH)).toBe(FULL_MATCH);
    expect(parseMarketPeriod("half=2", FULL_MATCH)).toBe(FULL_MATCH);
    expect(parseMarketPeriod(null, FIRST_HALF)).toBe(FIRST_HALF);
  });

  /**
   * A first-half key asked for as full match matches ZERO documents. Returning that empty
   * series would render identically to "the capture holds no such line" — so it throws, and it
   * throws BEFORE opening a connection, which is what makes this assertable with no database.
   */
  it("refuses a market key whose period contradicts the requested period", async () => {
    const contradiction = {
      fixtureId: 18257865,
      market: "1X2_PARTICIPANT_RESULT|half=1",
      dataset: DEMO_DATASET,
      period: FULL_MATCH,
      bookmakerId: CAPTURE_BOOKMAKER_ID,
      outcome: "part1",
    };
    await expect(downsampledSeries(contradiction)).rejects.toBeInstanceOf(
      MarketPeriodMismatchError,
    );
    await expect(seriesPage(contradiction)).rejects.toBeInstanceOf(MarketPeriodMismatchError);
  });

  it("says which period it charted, so the label describes one line and not two", async () => {
    const slice = await buildReplaySlice({ dataset: DEMO_DATASET, readers: fakeReaders() });
    expect(slice.line.period).toBe(FULL_MATCH);
    expect(lineLabel(slice)).toContain("full match");
    expect(periodLabel(FULL_MATCH)).toBe("full match");
    expect(periodLabel(FIRST_HALF)).toBe("1st half");
  });
});

/**
 * The retired spelling put the literal word None in a market key's period slot. It is gone from
 * the corpus — zero keys contain it — so a surviving hardcoded one matches nothing and charts
 * an empty series forever, silently. Cheap to scan for, so it is scanned for.
 *
 * The pattern is deliberately narrow: a MARKET-KEY-shaped token, so prose describing the
 * retired spelling (including the comment you are reading) is not a false positive.
 */
describe("no market key uses the retired None period spelling", () => {
  it("finds none anywhere in the app source", () => {
    const retired = /[A-Z][A-Z0-9_]+\|None/;
    const roots = ["app", "components", "hooks", "lib", "data"];
    const offenders: string[] = [];
    for (const root of roots) {
      for (const file of walk(join(process.cwd(), root))) {
        if (!/\.(ts|tsx|json)$/.test(file)) continue;
        if (retired.test(readFileSync(file, "utf8"))) {
          offenders.push(file.replace(process.cwd(), ""));
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else yield full;
  }
}

/** A line's worth of readings carrying the manifest's flagged move, so composition succeeds. */
function fakeReaders(over: Partial<ReplayReaders> = {}): ReplayReaders {
  return {
    readFixture: async () => FIXTURE,
    readLine: async () => [
      { ts: 1784152014575 - 1000, pct: 75.7 },
      { ts: 1784152014575, pct: 79.618 },
      { ts: 1784152014575 + 1000, pct: 79.5 },
    ],
    ...over,
  };
}

/** Run the composition and report the selector `lineSeries` was actually asked for. */
async function captureSelector(opts: { dataset: Dataset }): Promise<LineSelector> {
  let seen: LineSelector | null = null;
  await buildReplaySlice({
    dataset: opts.dataset,
    readers: fakeReaders({
      readLine: async (selector) => {
        seen = selector;
        return [
          { ts: 1784152014575 - 1000, pct: 75.7 },
          { ts: 1784152014575, pct: 79.618 },
        ];
      },
    }),
  });
  if (seen === null) throw new Error("the composition never read a line");
  return seen;
}

/** Keeps the slice type referenced so a shape change here is a compile error, not a surprise. */
export type _Slice = ReplaySlice;
