import { describe, expect, it } from "vitest";

import type { MarketAccount, PositionAccount, Side } from "@/lib/solana/forge-client";
import { Comparison } from "@/lib/solana/forge-client";
import {
  buildPnl,
  claimPayoutLamports,
  positionOutcome,
  winnerSideTotal,
} from "@/lib/solana/payout";

// Light literal builders — only the fields the payout math reads are meaningful.
function market(over: Partial<MarketAccount> & { address: string }): MarketAccount {
  const stakeYes = over.stakeYes ?? 0n;
  const stakeNo = over.stakeNo ?? 0n;
  return {
    fixtureId: 1n,
    statKey: 1,
    predicate: { threshold: 0, comparison: Comparison.GreaterThan },
    vault: "vault",
    state: "Settled",
    winner: "Yes",
    authority: "auth",
    ...over,
    stakeYes,
    stakeNo,
    potLamports: stakeYes + stakeNo,
  };
}

function position(
  marketAddress: string,
  side: Side,
  amount: bigint,
  claimed = false,
  address = `pos-${marketAddress}-${side}`,
): PositionAccount {
  return { address, market: marketAddress, owner: "owner", side, amount, claimed };
}

describe("claimPayoutLamports — mirrors the on-chain u128 math", () => {
  it("pays the standard pro-rata share of the whole pot", () => {
    // 10M YES / 5M NO, winner YES; a 5M YES position takes 5/10 of the 15M pot.
    const m = market({ address: "m", stakeYes: 10_000_000n, stakeNo: 5_000_000n });
    const p = position("m", "Yes", 5_000_000n);
    expect(claimPayoutLamports(m, p)).toBe(7_500_000n);
  });

  it("returns exactly the stake back when the losing side staked ZERO (the founder's case)", () => {
    // 0.015 SOL pot, ALL of it on YES; a 0.005 stake gets 0.005 back — profit 0.
    const m = market({ address: "m", stakeYes: 15_000_000n, stakeNo: 0n });
    const p = position("m", "Yes", 5_000_000n);
    const payout = claimPayoutLamports(m, p);
    expect(payout).toBe(5_000_000n);
    expect(payout! - p.amount).toBe(0n); // never dress this as a win amount
  });

  it("floors like the program's integer division", () => {
    // pot 10, winner total 3, stake 1 → 10*1/3 = 3 (floor), not 3.33.
    const m = market({ address: "m", stakeYes: 3n, stakeNo: 7n });
    const p = position("m", "Yes", 1n);
    expect(claimPayoutLamports(m, p)).toBe(3n);
  });

  it("is null for a lost position — nothing to claim", () => {
    const m = market({ address: "m", stakeYes: 10n, stakeNo: 5n, winner: "Yes" });
    expect(claimPayoutLamports(m, position("m", "No", 5n))).toBeNull();
  });

  it("is null while the market is still open — never an estimate", () => {
    const m = market({ address: "m", stakeYes: 10n, stakeNo: 5n, state: "Open" });
    expect(claimPayoutLamports(m, position("m", "Yes", 10n))).toBeNull();
  });

  it("winnerSideTotal follows the winning side", () => {
    expect(
      winnerSideTotal(market({ address: "m", stakeYes: 7n, stakeNo: 3n, winner: "Yes" })),
    ).toBe(7n);
    expect(
      winnerSideTotal(market({ address: "m", stakeYes: 7n, stakeNo: 3n, winner: "No" })),
    ).toBe(3n);
  });
});

describe("positionOutcome", () => {
  const settled = market({ address: "m", stakeYes: 1n, stakeNo: 1n, winner: "No" });
  it("won / lost / open map from on-chain state only", () => {
    expect(positionOutcome(settled, position("m", "No", 1n))).toBe("won");
    expect(positionOutcome(settled, position("m", "Yes", 1n))).toBe("lost");
    expect(
      positionOutcome(market({ address: "m", state: "Open" }), position("m", "Yes", 1n)),
    ).toBe("open");
  });
});

describe("buildPnl — aggregation over a wallet's positions", () => {
  const markets = [
    // Settled, winner YES: 10M YES vs 5M NO.
    market({ address: "won-mkt", stakeYes: 10_000_000n, stakeNo: 5_000_000n }),
    // Settled, winner YES — this wallet backed NO.
    market({ address: "lost-mkt", stakeYes: 8_000_000n, stakeNo: 2_000_000n }),
    // Still open.
    market({ address: "open-mkt", state: "Open", stakeYes: 1_000_000n }),
  ];
  const positions = [
    position("open-mkt", "Yes", 1_000_000n),
    position("lost-mkt", "No", 2_000_000n),
    position("won-mkt", "Yes", 5_000_000n, true),
    position("ghost-mkt", "Yes", 3_000_000n), // its market could not be read
  ];

  const { rows, totals } = buildPnl(positions, markets);

  it("joins each position with its market and orders settled facts first", () => {
    expect(rows.map((r) => r.outcome)).toEqual(["won", "lost", "open", "unknown"]);
    expect(rows[0].market?.address).toBe("won-mkt");
    expect(rows[3].market).toBeNull();
  });

  it("computes payout and net per row from on-chain facts only", () => {
    const [won, lost, open, unknown] = rows;
    expect(won.payoutLamports).toBe(7_500_000n); // 15M * 5M / 10M
    expect(won.netLamports).toBe(2_500_000n);
    expect(lost.payoutLamports).toBe(0n);
    expect(lost.netLamports).toBe(-2_000_000n);
    expect(open.payoutLamports).toBeNull(); // open → no number, ever
    expect(open.netLamports).toBeNull();
    expect(unknown.payoutLamports).toBeNull();
    expect(unknown.netLamports).toBeNull();
  });

  it("totals: staked over everything, net over SETTLED facts only", () => {
    expect(totals.stakedLamports).toBe(11_000_000n); // all four stakes
    expect(totals.openStakedLamports).toBe(1_000_000n);
    expect(totals.settledStakedLamports).toBe(7_000_000n); // won 5M + lost 2M
    expect(totals.returnedLamports).toBe(7_500_000n);
    expect(totals.netLamports).toBe(500_000n); // 7.5M back − 7M settled stake
  });

  it("a losing-only wallet nets a clearly negative number", () => {
    const { totals: t } = buildPnl(
      [position("lost-mkt", "No", 2_000_000n)],
      markets,
    );
    expect(t.netLamports).toBe(-2_000_000n);
  });

  it("is empty-safe", () => {
    const { rows: r, totals: t } = buildPnl([], markets);
    expect(r).toEqual([]);
    expect(t.stakedLamports).toBe(0n);
    expect(t.netLamports).toBe(0n);
  });
});
