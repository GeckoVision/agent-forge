import { NextRequest, NextResponse } from "next/server";

import {
  DEFAULT_PAGE_LIMIT,
  DEFAULT_POINTS,
  downsampledSeries,
  MarketPeriodMismatchError,
  seriesPage,
} from "@/lib/mongo/odds";
import { errorResponse, intParam } from "@/lib/mongo/respond";
import {
  CAPTURE_BOOKMAKER_ID,
  DEMO_DATASET,
  FULL_MATCH,
  parseDataset,
  parseMarketPeriod,
} from "@/lib/mongo/types";

/**
 * One market line's captured odds, read from MongoDB server-side.
 *
 * `GET /api/data/odds?fixture=18257865&market=...&outcome=over`
 *   → ~100 downsampled points. The DEFAULT, and what every chart should use.
 *
 * `GET /api/data/odds?...&paginate=1&cursor=<ts>&limit=500`
 *   → raw ticks, range-paginated on `ts`. Opt-in, for callers that need every reading.
 *
 * `dataset` and `period` are resolved HERE, explicitly. `lib/mongo/odds.ts` requires both and
 * defaults neither, because each one omitted merges two different series into one without
 * erroring: `dataset` because 106 fixture ids exist in both captures, `period` because the
 * full-match and first-half lines of a market family are interleaved. `?period=` accepts `""`
 * (full match, the default for charting) or `half=1`.
 *
 * The reduction happens inside the database (see `lib/mongo/odds.ts`), not after shipping:
 * a whole fixture is 16,781 documents, the largest single full-match line is 1,740, and what
 * leaves here is a few KB of `{ts, pct}`. This handler stays thin — parse, delegate, serialize.
 *
 * `MONGODB_URI` is read only on the server; nothing in the response echoes it.
 */

export const runtime = "nodejs";
// The capture is historical and immutable, but it is re-loadable — so no static caching.
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const fixtureId = intParam(params.get("fixture"));
  const market = params.get("market");
  const outcome = params.get("outcome");

  if (!fixtureId || !market || !outcome) {
    return NextResponse.json(
      { error: "fixture (positive integer), market and outcome are required." },
      { status: 400 },
    );
  }

  const dataset = parseDataset(params.get("dataset"), DEMO_DATASET);
  // Full match unless asked otherwise — the charted line, stated rather than assumed.
  const period = parseMarketPeriod(params.get("period"), FULL_MATCH);
  const line = { fixtureId, market, dataset, period, bookmakerId: CAPTURE_BOOKMAKER_ID };

  try {
    if (params.get("paginate") === "1") {
      const cursorRaw = params.get("cursor");
      const cursor = cursorRaw !== null && cursorRaw !== "" ? Number(cursorRaw) : null;
      if (cursor !== null && !Number.isFinite(cursor)) {
        return NextResponse.json(
          { error: "cursor must be a timestamp in epoch milliseconds." },
          { status: 400 },
        );
      }
      const page = await seriesPage({
        ...line,
        outcome,
        cursor,
        limit: intParam(params.get("limit")) ?? DEFAULT_PAGE_LIMIT,
      });
      return NextResponse.json(page);
    }

    const series = await downsampledSeries({
      ...line,
      outcome,
      points: intParam(params.get("points")) ?? DEFAULT_POINTS,
    });
    return NextResponse.json(series);
  } catch (err) {
    // A market key whose own period contradicts `?period=` is a bad request, not an outage —
    // and saying so beats returning the empty series that combination really matches.
    if (err instanceof MarketPeriodMismatchError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    return errorResponse(err);
  }
}
