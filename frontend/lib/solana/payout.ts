import type { MarketAccount, PositionAccount } from "./forge-client";

/**
 * Payout + P&L math over decoded on-chain accounts — pure functions, no RPC.
 *
 * `claimPayoutLamports` mirrors the program's `claim_handler` EXACTLY
 * (program/programs/forge-markets/src/instructions/claim.rs):
 *
 *   payout = pot * position.amount / stake(winning_side)   — u128, floor division
 *
 * so what the UI shows BEFORE claiming is the same number the program will pay.
 * Everything here returns `null` rather than a guess whenever the outcome is not
 * yet an on-chain fact (open market, unreadable market) — the honest-numbers rule.
 */

/** How a position stands against its market's on-chain state. */
export type PositionOutcome = "won" | "lost" | "open";

/** A P&L row's outcome — `unknown` when the position's market could not be read. */
export type PnlOutcome = PositionOutcome | "unknown";

/** Total staked on the winning side — the claim denominator. */
export function winnerSideTotal(market: MarketAccount): bigint {
  return market.winner === "Yes" ? market.stakeYes : market.stakeNo;
}

export function positionOutcome(
  market: MarketAccount,
  position: PositionAccount,
): PositionOutcome {
  if (market.state !== "Settled") return "open";
  return position.side === market.winner ? "won" : "lost";
}

/**
 * The exact lamports `claim` will transfer for this position, or `null` when there
 * is nothing claimable to compute (market open, position lost, or a zero winning
 * side — the program refuses that last case with `NoWinningStake`).
 *
 * Note the honest edge: when the LOSING side staked zero, pot == winner_total and
 * the payout is exactly the stake back — profit 0. Callers must present that as a
 * refund, never as a win amount.
 */
export function claimPayoutLamports(
  market: MarketAccount,
  position: PositionAccount,
): bigint | null {
  if (positionOutcome(market, position) !== "won") return null;
  const winnerTotal = winnerSideTotal(market);
  if (winnerTotal === 0n) return null;
  // BigInt division floors, matching the program's u128 integer math.
  return (market.potLamports * position.amount) / winnerTotal;
}

// ── wallet P&L aggregation (the /track-record table) ───────────────────────────
export interface PnlRow {
  position: PositionAccount;
  /** The joined market, or `null` when no fetched market matches the position. */
  market: MarketAccount | null;
  outcome: PnlOutcome;
  /** won → the exact pro-rata payout (claimed or claimable) · lost → 0n ·
   * open/unknown → `null` (no number exists yet). */
  payoutLamports: bigint | null;
  /** payout − stake, only when the outcome is a settled fact; otherwise `null`. */
  netLamports: bigint | null;
}

export interface PnlTotals {
  /** Every lamport this wallet has staked, across all outcomes. */
  stakedLamports: bigint;
  /** The part of `stakedLamports` still riding on open markets. */
  openStakedLamports: bigint;
  /** The part of `stakedLamports` whose markets have settled. */
  settledStakedLamports: bigint;
  /** Payouts from won positions — claimed or claimable, same on-chain number. */
  returnedLamports: bigint;
  /** returned − settled stake. Settled facts only: open bets are neither won nor
   * lost yet, so they never move this number. */
  netLamports: bigint;
}

const OUTCOME_ORDER: Record<PnlOutcome, number> = {
  won: 0,
  lost: 1,
  open: 2,
  unknown: 3,
};

/**
 * Join a wallet's positions with the fetched markets into P&L rows + totals.
 * Rows are ordered settled-facts-first (won, lost, open, unknown) so the numbers
 * that ARE final lead the table. Nothing is estimated: a position whose market
 * we could not read stays `unknown` and only counts toward the staked total.
 */
export function buildPnl(
  positions: PositionAccount[],
  markets: MarketAccount[],
): { rows: PnlRow[]; totals: PnlTotals } {
  const byAddress = new Map(markets.map((m) => [m.address, m]));

  const rows: PnlRow[] = positions.map((position) => {
    const market = byAddress.get(position.market) ?? null;
    if (!market) {
      return { position, market, outcome: "unknown", payoutLamports: null, netLamports: null };
    }
    const outcome = positionOutcome(market, position);
    const payoutLamports =
      outcome === "won" ? claimPayoutLamports(market, position) : outcome === "lost" ? 0n : null;
    const netLamports =
      payoutLamports !== null ? payoutLamports - position.amount : null;
    return { position, market, outcome, payoutLamports, netLamports };
  });

  rows.sort((a, b) => OUTCOME_ORDER[a.outcome] - OUTCOME_ORDER[b.outcome]);

  const totals: PnlTotals = {
    stakedLamports: 0n,
    openStakedLamports: 0n,
    settledStakedLamports: 0n,
    returnedLamports: 0n,
    netLamports: 0n,
  };
  for (const row of rows) {
    totals.stakedLamports += row.position.amount;
    if (row.outcome === "open") totals.openStakedLamports += row.position.amount;
    if (row.outcome === "won" || row.outcome === "lost") {
      totals.settledStakedLamports += row.position.amount;
      totals.returnedLamports += row.payoutLamports ?? 0n;
    }
  }
  totals.netLamports = totals.returnedLamports - totals.settledStakedLamports;

  return { rows, totals };
}
