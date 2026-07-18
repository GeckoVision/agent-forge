/**
 * Shared shapes for the Mongo read path — the single source of truth for the dataset
 * key and the query/response contracts. Every consumer (lib, routes, hooks) imports
 * from here; nothing redeclares them.
 */

/**
 * A capture dataset. The loader keys BOTH `fixtures` (compound `_id` = `dataset:fixtureId`,
 * unique index `dataset_fixtureId_unique`) and `odds_updates` (`meta.dataset`) by this, so a
 * fixture id alone is NOT unique — every query must carry a dataset.
 *
 * 106 fixture ids exist in BOTH captures with DIFFERENT metadata — fixture 17926593 is 102,796
 * updates over 57 markets under `all_competitions` but 59,797 over 42 under `worldcup_prematch`.
 * A read without a dataset predicate therefore returns that fixture twice, with conflicting
 * counts, and silently charts the two captures interleaved. That is a wrong answer, not an
 * error, so nothing below supplies a default: every query type in this layer makes `dataset`
 * REQUIRED and the compiler refuses a dataset-less read.
 */
export type Dataset = "worldcup_prematch" | "all_competitions";

/**
 * The capture this app is built on — the `/agent` replay, the settlement demo, the charts.
 *
 * This is an APPLICATION pin, not a query-layer default. It lives here so there is one place
 * to change it, and it is passed EXPLICITLY at the HTTP edge (see the `app/api/data/*` route
 * handlers). No function in `lib/mongo/` reads it; a silent default in the shared query layer
 * is exactly how the wrong dataset ends up in a demo.
 */
export const DEMO_DATASET: Dataset = "worldcup_prematch";

const DATASETS: readonly string[] = ["worldcup_prematch", "all_competitions"];

/**
 * Narrow untrusted query-string input to a known dataset.
 *
 * `fallback` is a REQUIRED argument: the caller must name the dataset it means when the request
 * does not, so the choice is visible at the call site instead of hidden in this module.
 */
export function parseDataset(raw: string | null | undefined, fallback: Dataset): Dataset {
  return raw && DATASETS.includes(raw) ? (raw as Dataset) : fallback;
}

/**
 * Which period of the match a price line covers — the `meta.marketPeriod` field.
 *
 * TxLINE publishes the full-match and first-half lines for a fixture INTERLEAVED on the same
 * market family, and the reload made that split first-class. `1X2_PARTICIPANT_RESULT` and
 * `1X2_PARTICIPANT_RESULT|half=1` are two different lines that move independently; charting
 * them merged produces a sawtooth that is not a price any book ever showed, and inflates the
 * reading count (2,829 merged vs 1,740 full-match for fixture 18257865).
 *
 * The retired spelling wrote the literal word None into a key's period slot. It is gone
 * corpus-wide — zero market keys contain it — so any surviving hardcoded key in that form
 * matches nothing at all, and charts an empty series rather than erroring.
 */
export type MarketPeriod = "" | "half=1";

/** The whole match. What every chart in this app draws. */
export const FULL_MATCH: MarketPeriod = "";

/** First half only — a separate line, never to be merged into the full-match series. */
export const FIRST_HALF: MarketPeriod = "half=1";

const PERIODS: readonly string[] = ["", "half=1"];

/** Narrow untrusted query-string input to a known period. `fallback` is required, as above. */
export function parseMarketPeriod(
  raw: string | null | undefined,
  fallback: MarketPeriod,
): MarketPeriod {
  return raw !== null && raw !== undefined && PERIODS.includes(raw)
    ? (raw as MarketPeriod)
    : fallback;
}

/**
 * The period a market KEY encodes, e.g. `1X2_PARTICIPANT_RESULT|half=1` → `"half=1"`.
 *
 * Used only to cross-check a caller's stated period against the key it asked for, so a
 * contradiction fails loudly instead of returning an empty chart that looks like "no data".
 */
export function marketPeriodOf(market: string): MarketPeriod {
  return market.split("|").includes(FIRST_HALF) ? FIRST_HALF : FULL_MATCH;
}

/**
 * The one bookmaker in this capture (TXLineStablePriceDemargined).
 *
 * Filtering on it changes NO result today — every reading carries it. The predicate is here so
 * that a second book added to a later capture cannot silently merge two books' prices into one
 * series; `fixture_book_market_ts` indexes it, so the filter is free.
 */
export const CAPTURE_BOOKMAKER_ID = 10021;

/** One real reading of one price line: capture timestamp (epoch ms) + implied prob (pp). */
export interface Reading {
  ts: number;
  pct: number;
}

/** A fixture's identity and result, as the capture recorded it. */
export interface FixtureMeta {
  fixtureId: number;
  dataset: Dataset;
  participant1: string;
  participant2: string;
  competition: string;
  competitionId: number;
  kickoffMs: number;
  bookmakers: string[];
  oddsUpdateCount: number;
  oddsFirstTs: number;
  oddsLastTs: number;
  /**
   * SETTLED means `labeled` — the capture carries a real, scored outcome.
   *
   * NOT `result.available`: in `worldcup_prematch` 102 of 106 fixtures have
   * `result.available = true` but only 56 are actually settled, because `available` merely says
   * a score document existed — it can hold a half-time or partial score with `outcome: null`.
   * Filtering on `available` would silently mix 46 unfinished matches into any "settled" set.
   */
  settled: boolean;
  outcome: string | null;
  participant1Goals: number | null;
  participant2Goals: number | null;
}

/** The downsampled, projected series the charts render. */
export interface SeriesResponse {
  kind: "downsampled";
  fixtureId: number;
  dataset: Dataset;
  market: string;
  /** Which period was charted. Echoed so a response can never be read as the other line. */
  period: MarketPeriod;
  outcome: string;
  /** Readings that matched BEFORE downsampling — so the UI can state what it is showing. */
  readingsMatched: number;
  points: Reading[];
}

/** One page of the raw, un-downsampled series, for callers that need every tick. */
export interface SeriesPageResponse {
  kind: "page";
  fixtureId: number;
  dataset: Dataset;
  market: string;
  /** Which period was paged. Echoed so a response can never be read as the other line. */
  period: MarketPeriod;
  outcome: string;
  limit: number;
  points: Reading[];
  /**
   * Pass back as `cursor` to get the next page: a `ts` value, NOT an offset.
   * `null` once the series is exhausted.
   */
  nextCursor: number | null;
}
