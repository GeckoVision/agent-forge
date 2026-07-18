import { Comparison, COMPARISON_SYMBOL, type MarketAccount } from "./forge-client";

/**
 * Turning a market's on-chain predicate into a sentence a non-technical viewer can read.
 *
 * A `Market` stores its predicate as `(statKey, comparison, threshold)` — e.g.
 * `stat #1 > 0`. That is exactly what the program checks, and it is unreadable. This module
 * renders BOTH forms: the human sentence when (and only when) the stat key's meaning is
 * VERIFIED, and always the technical form as the fallback/subtitle.
 *
 * ## Why only two stat keys get a name
 *
 * The TxODDS feed carries 64 stat keys. Two are anchored by BOTH sources of truth we have:
 *
 *   - Vendor docs: `backend/gorilla/spec/txline_openapi.yaml` documents the stat key as
 *     "1 = Participant1_Score, 2 = Participant2_Score".
 *   - Our own longitudinal check against the live feed (fixture 18257865: `stat['2']` moved
 *     1 → 2 in lockstep with the score going 1 → 2) confirms that mapping empirically.
 *
 *   stat 1 = participant 1's goals · stat 2 = participant 2's goals
 *
 * The spec types every OTHER key as a bare `int32` with no name or units, so the remaining 62
 * are guesses. A confidently wrong label ("France to score") on a market that actually settles
 * on corner kicks is worse than an opaque one, so {@link humanPredicate} returns `null` for
 * every unverified key and the caller shows `stat #N > 0` instead.
 */

/** The stat keys whose meaning is verified against the live feed. Nothing else may be named. */
export const VERIFIED_GOAL_STAT_KEYS = {
  1: "participant1",
  2: "participant2",
} as const;

export type GoalStatKey = keyof typeof VERIFIED_GOAL_STAT_KEYS;

/** The two sides of a fixture, as the capture recorded them. */
export interface FixtureParticipants {
  participant1: string;
  participant2: string;
}

/** The literal on-chain predicate — always renderable, never wrong, never readable. */
export function technicalPredicate(market: MarketAccount): string {
  const symbol = COMPARISON_SYMBOL[market.predicate.comparison] ?? "?";
  return `stat #${market.statKey} ${symbol} ${market.predicate.threshold}`;
}

function isVerifiedGoalStat(statKey: number): statKey is GoalStatKey {
  return statKey === 1 || statKey === 2;
}

/** Which side a verified goals stat belongs to, or `null` when the key is not verified. */
export function teamForStatKey(
  statKey: number,
  participants: FixtureParticipants | null | undefined,
): string | null {
  if (!participants || !isVerifiedGoalStat(statKey)) return null;
  const name = participants[VERIFIED_GOAL_STAT_KEYS[statKey]];
  return name.trim() ? name.trim() : null;
}

function goals(n: number): string {
  return n === 1 ? "1 goal" : `${n} goals`;
}

/**
 * The human sentence, or `null` when we cannot say it truthfully.
 *
 * `null` — caller falls back to {@link technicalPredicate} — whenever the stat key is not
 * verified, the participant name is missing, the comparison is not one the program defines, or
 * the threshold is a value that cannot describe a goal count (goals are never negative, so a
 * negative threshold means this market is not the goals market we think it is).
 */
export function humanPredicate(
  market: MarketAccount,
  participants: FixtureParticipants | null | undefined,
): string | null {
  const team = teamForStatKey(market.statKey, participants);
  if (!team) return null;

  const { comparison, threshold } = market.predicate;
  if (!Number.isInteger(threshold) || threshold < 0) return null;

  switch (comparison) {
    case Comparison.GreaterThan:
      // `> 0` is the common case and reads best as the plain betting phrase.
      return threshold === 0
        ? `${team} to score`
        : `${team} to score more than ${goals(threshold)}`;
    case Comparison.LessThan:
      // `< 0` can never hold, so it is not a market anyone meant to create — stay technical.
      if (threshold === 0) return null;
      return threshold === 1
        ? `${team} not to score`
        : `${team} to score fewer than ${goals(threshold)}`;
    case Comparison.EqualTo:
      return threshold === 0
        ? `${team} not to score`
        : `${team} to score exactly ${goals(threshold)}`;
    default:
      return null;
  }
}

/**
 * What actually happens if a given side wins — present-tense, e.g. YES → "France scores",
 * NO → "France doesn't score".
 *
 * Same confidence rule as {@link humanPredicate}: only verified goal stats (keys 1/2) with a
 * known team name get a sentence; everything else returns `null` and the caller shows plain
 * YES/NO. The NO side is the logical negation of the predicate — never a guess:
 *
 *   > n  ↔  n or fewer  ·  < n  ↔  n or more  ·  = n  ↔  anything but n
 */
export function sideOutcome(
  market: MarketAccount,
  participants: FixtureParticipants | null | undefined,
  side: "Yes" | "No",
): string | null {
  const team = teamForStatKey(market.statKey, participants);
  if (!team) return null;

  const { comparison, threshold } = market.predicate;
  if (!Number.isInteger(threshold) || threshold < 0) return null;

  const yes = side === "Yes";
  switch (comparison) {
    case Comparison.GreaterThan:
      if (threshold === 0) {
        return yes ? `${team} scores` : `${team} doesn't score`;
      }
      return yes
        ? `${team} scores more than ${goals(threshold)}`
        : `${team} scores ${goals(threshold)} or fewer`;
    case Comparison.LessThan:
      if (threshold === 0) return null; // `< 0` can never hold — not a real goals market.
      if (threshold === 1) {
        return yes ? `${team} doesn't score` : `${team} scores`;
      }
      return yes
        ? `${team} scores fewer than ${goals(threshold)}`
        : `${team} scores ${goals(threshold)} or more`;
    case Comparison.EqualTo:
      if (threshold === 0) {
        return yes ? `${team} doesn't score` : `${team} scores`;
      }
      return yes
        ? `${team} scores exactly ${goals(threshold)}`
        : `${team} doesn't score exactly ${goals(threshold)}`;
    default:
      return null;
  }
}

export interface PredicateDescription {
  /** The readable sentence, or `null` when no verified reading exists. */
  human: string | null;
  /** The literal predicate — always present. */
  technical: string;
}

/** Both renderings at once: what the UI shows as label + subtitle. */
export function describePredicate(
  market: MarketAccount,
  participants: FixtureParticipants | null | undefined,
): PredicateDescription {
  return {
    human: humanPredicate(market, participants),
    technical: technicalPredicate(market),
  };
}

/** The single line to show when there is only room for one — human if we have it. */
export function predicateHeadline(
  market: MarketAccount,
  participants: FixtureParticipants | null | undefined,
): string {
  return humanPredicate(market, participants) ?? technicalPredicate(market);
}
