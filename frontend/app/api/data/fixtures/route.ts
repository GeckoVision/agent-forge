import { NextRequest, NextResponse } from "next/server";

import { fixtureCounts, listFixtures } from "@/lib/mongo/fixtures";
import { errorResponse, intParam } from "@/lib/mongo/respond";
import { DEMO_DATASET, parseDataset } from "@/lib/mongo/types";

/**
 * Captured fixtures, read from MongoDB server-side.
 *
 * `GET /api/data/fixtures?dataset=worldcup_prematch&settled=true&limit=120`
 *
 * `settled=true` means a real, scored result — `labeled` plus a non-empty `result.outcome`,
 * NOT `result.available`. See `lib/mongo/fixtures.ts`: in `worldcup_prematch` `available` is
 * true for 102 of 106 fixtures but only 56 are actually settled, so the naive filter would
 * silently fold 46 unfinished matches into any settled set (and into any win rate from it).
 *
 * `dataset` is REQUIRED downstream and defaulted only here — the two captures hold 106 and 258
 * fixtures respectively and share 106 ids, so "which capture" is never safe to infer.
 *
 * `counts` ships alongside so a caller always has the honest denominator.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  // Pinned explicitly at the edge: `lib/mongo/fixtures.ts` requires a dataset and has no
  // default, so an absent `?dataset=` must be resolved here or not at all.
  const dataset = parseDataset(params.get("dataset"), DEMO_DATASET);

  const settledRaw = params.get("settled");
  const settled = settledRaw === null ? undefined : settledRaw === "true";

  try {
    const [fixtures, counts] = await Promise.all([
      listFixtures({
        dataset,
        settled,
        competitionId: intParam(params.get("competition")) ?? undefined,
        limit: intParam(params.get("limit")) ?? undefined,
      }),
      fixtureCounts(dataset),
    ]);
    return NextResponse.json({ dataset, counts, fixtures });
  } catch (err) {
    return errorResponse(err);
  }
}
