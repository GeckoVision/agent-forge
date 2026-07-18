import type { Document, Filter } from "mongodb";

import { getDb } from "./client";
import type { Dataset, FixtureMeta } from "./types";

/**
 * Reads over the `fixtures` collection.
 *
 * Fixtures are keyed by the COMPOUND `(dataset, fixtureId)` — `_id` is the string
 * `"<dataset>:<fixtureId>"` (e.g. `"worldcup_prematch:18257865"`), and
 * `dataset_fixtureId_unique` enforces it. Two consequences, both load-bearing:
 *
 * * A lookup by the bare integer `_id` finds NOTHING. Every read here queries
 *   `{dataset, fixtureId}` against that unique compound index instead — never `_id`.
 * * A fixture id alone is not a key: 106 ids appear in BOTH captures with different metadata,
 *   so a dataset-less query returns the same match twice with conflicting counts. `dataset` is
 *   therefore a REQUIRED argument on every function below, with no default — the compiler
 *   refuses the ambiguous read rather than quietly picking a capture.
 */

const COLLECTION = "fixtures";

/**
 * SETTLED = `labeled: true`.
 *
 * NOT `result.available`. In `worldcup_prematch` 102 of 106 fixtures set
 * `result.available = true` — it only records that a score document came back — but just 56
 * carry a real scored outcome. The rest hold partial scores (`participant1Goals: 1,
 * participant2Goals: null, outcome: null`) for matches that had not finished. `labeled` is the
 * loader's assertion that the result is complete, and it agrees exactly with `result.outcome`
 * being present (56 = 56), so both are required below: either one alone would be a single point
 * of failure for a silent 46-fixture over-count.
 */
const SETTLED: Filter<Document> = {
  labeled: true,
  "result.outcome": { $nin: [null, ""] },
};

/** Only the fields the UI renders — `marketTypes` (dozens of strings) and `result.finalScore`
 * (a deep per-period tree) are never projected; together they dwarf the rest of the document. */
const PROJECTION: Document = {
  _id: 0,
  fixtureId: 1,
  dataset: 1,
  participant1: 1,
  participant2: 1,
  competition: 1,
  competitionId: 1,
  kickoffTs: 1,
  bookmakers: 1,
  oddsUpdateCount: 1,
  oddsFirstTs: 1,
  oddsLastTs: 1,
  labeled: 1,
  "result.outcome": 1,
  "result.participant1Goals": 1,
  "result.participant2Goals": 1,
};

interface FixtureDoc {
  fixtureId: number;
  dataset: Dataset;
  participant1?: string;
  participant2?: string;
  competition?: string;
  competitionId?: number;
  kickoffTs?: number;
  bookmakers?: string[];
  oddsUpdateCount?: number;
  oddsFirstTs?: number;
  oddsLastTs?: number;
  labeled?: boolean;
  result?: {
    outcome?: string | null;
    participant1Goals?: number | null;
    participant2Goals?: number | null;
  };
}

function toMeta(doc: FixtureDoc): FixtureMeta {
  return {
    fixtureId: doc.fixtureId,
    dataset: doc.dataset,
    participant1: doc.participant1 ?? "",
    participant2: doc.participant2 ?? "",
    competition: doc.competition ?? "",
    competitionId: doc.competitionId ?? 0,
    kickoffMs: doc.kickoffTs ?? 0,
    bookmakers: doc.bookmakers ?? [],
    oddsUpdateCount: doc.oddsUpdateCount ?? 0,
    oddsFirstTs: doc.oddsFirstTs ?? 0,
    oddsLastTs: doc.oddsLastTs ?? 0,
    settled: doc.labeled === true && !!doc.result?.outcome,
    outcome: doc.result?.outcome ?? null,
    participant1Goals: doc.result?.participant1Goals ?? null,
    participant2Goals: doc.result?.participant2Goals ?? null,
  };
}

/** One fixture, or `null` when the capture holds no such fixture in that dataset. */
export async function fixtureMeta(
  fixtureId: number,
  dataset: Dataset,
): Promise<FixtureMeta | null> {
  const db = await getDb();
  const doc = await db
    .collection<Document>(COLLECTION)
    .findOne({ fixtureId, dataset }, { projection: PROJECTION });
  return doc ? toMeta(doc as unknown as FixtureDoc) : null;
}

export interface FixtureListQuery {
  dataset: Dataset;
  /** `true` → only settled fixtures (see {@link SETTLED}); `false` → only unsettled. */
  settled?: boolean;
  competitionId?: number;
  limit?: number;
}

/** Fixtures in a dataset, newest kickoff first. */
export async function listFixtures(query: FixtureListQuery): Promise<FixtureMeta[]> {
  const { dataset } = query;
  const limit = Math.min(Math.max(Math.trunc(query.limit ?? 120), 1), 500);
  const db = await getDb();

  const filter: Filter<Document> = { dataset };
  if (query.settled === true) Object.assign(filter, SETTLED);
  if (query.settled === false) Object.assign(filter, { $nor: [SETTLED] });
  if (query.competitionId != null) filter.competitionId = query.competitionId;

  const docs = await db
    .collection<Document>(COLLECTION)
    .find(filter, { projection: PROJECTION })
    .sort({ kickoffTs: -1 })
    .limit(limit)
    .toArray();
  return docs.map((doc) => toMeta(doc as unknown as FixtureDoc));
}

/** How many fixtures are settled vs merely present — the honest denominator for any rate. */
export async function fixtureCounts(
  dataset: Dataset,
): Promise<{ total: number; settled: number }> {
  const db = await getDb();
  const collection = db.collection<Document>(COLLECTION);
  const [total, settled] = await Promise.all([
    collection.countDocuments({ dataset }),
    collection.countDocuments({ dataset, ...SETTLED }),
  ]);
  return { total, settled };
}
