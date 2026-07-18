import { Comparison, type MarketAccount } from "./forge-client";
import { teamForStatKey, type FixtureParticipants } from "./predicate";

/**
 * The open-a-market flow, kept pure so every decision is unit-testable: which
 * matches may be offered, which bets may be offered, and whether a pick means
 * CREATE a new market or JOIN one that already exists.
 *
 * ## Coverage rule (mirrors the agent's gate)
 *
 * Never offer a match the oracle can't settle. Presence in the fixtures capture
 * IS the coverage evidence — the same capture the settlement page already reads —
 * so the pickable list is exactly the covered fixtures, never an invented match.
 *
 * ## Why only two bets
 *
 * The predicate vocabulary (`lib/solana/predicate.ts`) verifies exactly two stat
 * keys against the live feed: 1 = participant 1's goals, 2 = participant 2's
 * goals. Every other key is unnamed in the vendor spec, and a confidently wrong
 * label is worse than a missing option — so the UI offers ONLY the mapped
 * "«team» scores" bets and nothing else.
 */

/** A match the oracle can settle: present in the capture with both names known. */
export interface CoveredFixture extends FixtureParticipants {
  fixtureId: number;
  /** Kickoff in epoch ms, or `null` when the capture has no kickoff. */
  kickoffMs: number | null;
}

/**
 * The order matches are offered in: soonest kickoff first, matches with no known
 * kickoff last (still offered — coverage is capture presence, not kickoff).
 * Ties break by fixture id so the list is deterministic.
 */
export function sortByKickoff(fixtures: CoveredFixture[]): CoveredFixture[] {
  return [...fixtures].sort((a, b) => {
    if (a.kickoffMs === null && b.kickoffMs === null)
      return a.fixtureId - b.fixtureId;
    if (a.kickoffMs === null) return 1;
    if (b.kickoffMs === null) return -1;
    return a.kickoffMs - b.kickoffMs || a.fixtureId - b.fixtureId;
  });
}

/** Kickoff in plain language ("Sat 18 Jul, 17:00"), or an honest "unknown". */
export function kickoffLabel(
  kickoffMs: number | null,
  timeZone?: string,
): string {
  if (kickoffMs === null) return "kickoff time unknown";
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone,
  }).format(new Date(kickoffMs));
}

/**
 * Every market this flow can open carries the same predicate: `stat > 0` over the
 * full match (period 0) — i.e. "«team» scores". The stat key picks the team.
 */
export const OPEN_MARKET_PREDICATE = {
  threshold: 0,
  comparison: Comparison.GreaterThan,
} as const;
export const OPEN_MARKET_PERIOD = 0;

/** One offerable bet: a VERIFIED stat key and the label the rest of the page uses. */
export interface OpenBetOption {
  statKey: 1 | 2;
  /** e.g. "France scores" — same vocabulary as `sideOutcome(..., "Yes")`. */
  label: string;
}

/**
 * The bets that may be offered for a fixture — ONLY the two verified goal stats,
 * and only when the team name resolves. An unmapped stat key never appears here.
 */
export function openableBets(
  participants: FixtureParticipants | null | undefined,
): OpenBetOption[] {
  const out: OpenBetOption[] = [];
  for (const statKey of [1, 2] as const) {
    const team = teamForStatKey(statKey, participants);
    if (team) out.push({ statKey, label: `${team} scores` });
  }
  return out;
}

/**
 * Create-or-join. The market PDA is unique per (fixture, stat), so if the account
 * already exists the bet is already open — that is a feature (someone beat you to
 * it; join them), never an error.
 */
export type OpenDecision =
  | { kind: "create" }
  | { kind: "join"; market: MarketAccount };

export function decideOpen(existing: MarketAccount | null): OpenDecision {
  return existing ? { kind: "join", market: existing } : { kind: "create" };
}
