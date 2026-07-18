import type { Document } from "mongodb";

import { getDb } from "./client";
import {
  type Dataset,
  type MarketPeriod,
  marketPeriodOf,
  type Reading,
  type SeriesPageResponse,
  type SeriesResponse,
} from "./types";

/**
 * Reads over `odds_updates` — a 12.3M-document time-series collection spanning two captures
 * (`worldcup_prematch`, 3.66M updates; `all_competitions`, 8.63M).
 *
 * The load-bearing rule here is REDUCE IN THE DATABASE, NOT AFTER SHIPPING. A whole fixture's
 * series is 16,781 documents (~4.6s); shipping that to a browser to draw a 100-bar chart is
 * the wrong shape at every layer. So every read below:
 *
 *   1. filters to ONE line — see {@link LineSelector}, which is one market of one bookmaker,
 *      in one dataset, over one period (an index-supported predicate, not a post-filter),
 *   2. projects away everything the chart does not draw — `prices[]`, `inRunning`, `meta`,
 *      the other outcomes' percentages — leaving `{ts, pct}` and nothing else,
 *   3. downsamples with `$bucketAuto` so the response is ~100 points regardless of how many
 *      readings the market actually holds.
 *
 * `odds_updates` is queried directly rather than the `odds_updates_flat` view because a view
 * is a prepended pipeline stage: predicates against it are matched AFTER the view's `$set`
 * stages, which can cost the index. Querying `meta.*` keeps the
 * `(meta.fixtureId, meta.bookmakerId, meta.market, ts)` index in play. `tsMs` (the epoch-millis
 * form the rest of the codebase uses) is derived in the final `$project` instead — the same
 * value, computed for ~100 documents rather than 16,781.
 */

const COLLECTION = "odds_updates";

/** Default chart resolution. ~100 points is more than a few hundred CSS pixels can resolve. */
export const DEFAULT_POINTS = 100;
const MAX_POINTS = 500;

/** Page size for the raw-tick path. Capped so one request can never pull a whole fixture. */
export const DEFAULT_PAGE_LIMIT = 500;
const MAX_PAGE_LIMIT = 2000;

/**
 * Everything it takes to name ONE price line unambiguously.
 *
 * Every field is REQUIRED, and that is the point. Each one, left off, silently merges two
 * different things into a single series rather than failing:
 *
 * * `dataset` — 106 fixture ids live in both captures; omitting it returns each reading twice.
 * * `period` — the full-match and first-half lines share a market family and move
 *   independently; omitting it blends them (1,740 readings become 2,829 for the 1X2 line).
 * * `bookmakerId` — a no-op on this single-book capture, but it stops a second book in a
 *   later capture from merging into one series.
 *
 * There are no defaults here. The compiler refuses an under-specified line.
 */
export interface LineSelector {
  fixtureId: number;
  market: string;
  dataset: Dataset;
  period: MarketPeriod;
  bookmakerId: number;
}

export interface SeriesQuery extends LineSelector {
  /** Key within the `pct` sub-document: `over`/`under`, or `part1`/`draw`/`part2`. */
  outcome: string;
  points?: number;
}

export interface SeriesPageQuery extends Omit<SeriesQuery, "points"> {
  /** Range cursor: return readings with `ts` strictly greater than this. */
  cursor?: number | null;
  limit?: number;
}

/** A caller asked for a market key whose own period contradicts the period it passed. */
export class MarketPeriodMismatchError extends Error {
  constructor(market: string, period: MarketPeriod) {
    super(
      `Market "${market}" is the ${marketPeriodOf(market) === "" ? "full-match" : "first-half"} ` +
        `line, but period "${period}" was requested. That combination matches no readings; ` +
        `refusing rather than returning an empty series that reads as "no data".`,
    );
    this.name = "MarketPeriodMismatchError";
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(Math.trunc(value), min), max);
}

/**
 * The `$match` every read starts from.
 *
 * Field order mirrors `fixture_book_market_ts` — `(meta.fixtureId, meta.bookmakerId,
 * meta.market, ts)` — so the compound index bounds the scan; `meta.marketPeriod` and
 * `meta.dataset` then narrow within it.
 *
 * The market key and the period predicate are cross-checked first: `..._RESULT|half=1` with
 * `period: ""` would quietly return nothing, and "no readings" is indistinguishable in the UI
 * from "the capture holds no such line".
 */
function matchLine(selector: LineSelector): Document {
  const { fixtureId, market, dataset, period, bookmakerId } = selector;
  if (marketPeriodOf(market) !== period) throw new MarketPeriodMismatchError(market, period);
  return {
    "meta.fixtureId": fixtureId,
    "meta.bookmakerId": bookmakerId,
    "meta.market": market,
    "meta.marketPeriod": period,
    "meta.dataset": dataset,
  };
}

/**
 * Drop to `{ts, pct}` as early as possible.
 *
 * `$pct.<outcome>` is looked up with `$getField` rather than string concatenation into a
 * dotted path: outcome names arrive from the query string, and `$getField` treats the name as
 * a literal key, so a crafted value cannot walk into another part of the document.
 */
function projectOutcome(outcome: string): Document[] {
  return [
    {
      $project: {
        _id: 0,
        ts: 1,
        pct: { $getField: { field: { $literal: outcome }, input: "$pct" } },
      },
    },
    // A market carries only its own outcomes; asking for one it does not have yields null.
    { $match: { pct: { $type: "number" } } },
  ];
}

/**
 * A downsampled, projected series for ONE market line — the default read for any chart.
 *
 * `$bucketAuto` splits the matched readings into ~`points` equal-population time buckets and
 * emits the LAST reading in each (`$top` sorted by descending `ts`), which is the correct
 * summary for a price line: the price that stood at the end of the interval. It is a real
 * captured reading, never an average of several, so no point on the chart is a number the
 * book never showed.
 */
export async function downsampledSeries(query: SeriesQuery): Promise<SeriesResponse> {
  const { fixtureId, market, outcome, dataset, period } = query;
  const points = clamp(query.points ?? DEFAULT_POINTS, 2, MAX_POINTS);
  // Validate the line BEFORE opening a connection, so a contradictory query fails offline.
  const match = matchLine(query);
  const db = await getDb();

  const pipeline: Document[] = [
    { $match: match },
    ...projectOutcome(outcome),
    {
      $bucketAuto: {
        groupBy: "$ts",
        buckets: points,
        output: {
          n: { $sum: 1 },
          ts: { $max: "$ts" },
          pct: { $top: { sortBy: { ts: -1 }, output: "$pct" } },
        },
      },
    },
    { $sort: { "_id.min": 1 } },
    // tsMs — epoch millis, the form the rest of the codebase uses — computed on ~100 docs.
    { $project: { _id: 0, ts: { $toLong: "$ts" }, pct: 1, n: 1 } },
  ];

  const buckets = await db
    .collection(COLLECTION)
    .aggregate<{ ts: number; pct: number; n: number }>(pipeline)
    .toArray();

  return {
    kind: "downsampled",
    fixtureId,
    dataset,
    market,
    period,
    outcome,
    readingsMatched: buckets.reduce((sum, b) => sum + b.n, 0),
    points: buckets.map(({ ts, pct }) => ({ ts: Number(ts), pct })),
  };
}

/**
 * One page of raw readings, for callers that genuinely need every tick.
 *
 * Paginated by RANGE on `ts` (`ts > cursor`, ascending), never `skip`/`limit`. `skip` walks
 * and discards every preceding document, so page latency grows linearly with depth — on a
 * 3.66M-document collection a deep page becomes unusable. A `ts` range predicate rides the
 * `(meta.fixtureId, ts)` index and stays flat at any depth: page 1 and page 30 cost the same.
 *
 * `nextCursor` is the last `ts` returned. Two readings can share a millisecond, so a page
 * boundary that lands between them would drop the second — the boundary is therefore pushed
 * past the whole millisecond and any readings equal to `nextCursor` are re-emitted at the head
 * of the next page rather than lost.
 */
export async function seriesPage(query: SeriesPageQuery): Promise<SeriesPageResponse> {
  const { fixtureId, market, outcome, dataset, period } = query;
  const limit = clamp(query.limit ?? DEFAULT_PAGE_LIMIT, 1, MAX_PAGE_LIMIT);
  // Validate the line BEFORE opening a connection, so a contradictory query fails offline.
  const match = matchLine(query);
  const db = await getDb();

  if (query.cursor != null && Number.isFinite(query.cursor)) {
    match.ts = { $gt: new Date(query.cursor) };
  }

  const rows = await db
    .collection(COLLECTION)
    .aggregate<{ ts: number; pct: number }>([
      { $match: match },
      { $sort: { ts: 1 } },
      ...projectOutcome(outcome),
      // +1 probe: tells us whether another page exists without a second round trip.
      { $limit: limit + 1 },
      { $project: { _id: 0, ts: { $toLong: "$ts" }, pct: 1 } },
    ])
    .toArray();

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit).map(({ ts, pct }) => ({ ts: Number(ts), pct }));

  return {
    kind: "page",
    fixtureId,
    dataset,
    market,
    period,
    outcome,
    limit,
    points: page,
    nextCursor: hasMore && page.length > 0 ? page[page.length - 1].ts : null,
  };
}

/**
 * Every reading of one market line, in capture order — projected to `{ts, pct}`.
 *
 * Bounded by construction: this is used for the `/agent` replay window, where the line holds
 * a few hundred readings, and the caller slices a contiguous window out of it. The window
 * must be contiguous REAL readings (the chart claims every bar is one reading off the wire),
 * so this one path deliberately does not downsample.
 */
export async function lineSeries(selector: LineSelector, outcome: string): Promise<Reading[]> {
  // Validate the line BEFORE opening a connection, so a contradictory query fails offline.
  const match = matchLine(selector);
  const db = await getDb();
  const rows = await db
    .collection(COLLECTION)
    .aggregate<{ ts: number; pct: number }>([
      { $match: match },
      { $sort: { ts: 1 } },
      ...projectOutcome(outcome),
      { $project: { _id: 0, ts: { $toLong: "$ts" }, pct: 1 } },
    ])
    .toArray();
  return rows.map(({ ts, pct }) => ({ ts: Number(ts), pct: Math.round(pct * 1000) / 1000 }));
}
