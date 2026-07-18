import { describe, expect, it } from "vitest";

import {
  decideOpen,
  kickoffLabel,
  OPEN_MARKET_PERIOD,
  OPEN_MARKET_PREDICATE,
  openableBets,
  sortByKickoff,
  type CoveredFixture,
} from "@/lib/solana/open-market";
import { Comparison, type MarketAccount } from "@/lib/solana/forge-client";
import { sideOutcome } from "@/lib/solana/predicate";

const fixture = (
  fixtureId: number,
  kickoffMs: number | null,
  participant1 = "France",
  participant2 = "England",
): CoveredFixture => ({ fixtureId, kickoffMs, participant1, participant2 });

describe("sortByKickoff — soonest first, unknown last, deterministic", () => {
  it("orders by kickoff ascending", () => {
    const sorted = sortByKickoff([fixture(3, 3000), fixture(1, 1000), fixture(2, 2000)]);
    expect(sorted.map((f) => f.fixtureId)).toEqual([1, 2, 3]);
  });

  it("puts unknown-kickoff fixtures last (still offered — capture presence is the coverage)", () => {
    const sorted = sortByKickoff([fixture(9, null), fixture(1, 1000), fixture(8, null)]);
    expect(sorted.map((f) => f.fixtureId)).toEqual([1, 8, 9]);
  });

  it("breaks kickoff ties by fixture id", () => {
    const sorted = sortByKickoff([fixture(5, 1000), fixture(4, 1000)]);
    expect(sorted.map((f) => f.fixtureId)).toEqual([4, 5]);
  });

  it("does not mutate its input", () => {
    const input = [fixture(2, 2000), fixture(1, 1000)];
    sortByKickoff(input);
    expect(input.map((f) => f.fixtureId)).toEqual([2, 1]);
  });
});

describe("kickoffLabel — plain language, honest when unknown", () => {
  it("formats a known kickoff in plain language", () => {
    // 2026-07-18T17:00:00Z pinned to UTC so the assertion is deterministic.
    expect(kickoffLabel(Date.UTC(2026, 6, 18, 17, 0), "UTC")).toBe(
      "Sat 18 Jul, 17:00",
    );
  });

  it("says so when the capture has no kickoff — never an invented time", () => {
    expect(kickoffLabel(null)).toBe("kickoff time unknown");
  });
});

describe("openableBets — only the two verified goal stats, ever", () => {
  it("offers exactly stat 1 and stat 2, labelled per the page's vocabulary", () => {
    const bets = openableBets({ participant1: "France", participant2: "England" });
    expect(bets).toEqual([
      { statKey: 1, label: "France scores" },
      { statKey: 2, label: "England scores" },
    ]);
  });

  it("matches sideOutcome's YES sentence for the market this flow creates", () => {
    // Label parity with the rest of the page: opening "France scores" must read
    // exactly like betting YES on the created market.
    const participants = { participant1: "France", participant2: "England" };
    for (const bet of openableBets(participants)) {
      const created = {
        fixtureId: 1n,
        statKey: bet.statKey,
        predicate: { ...OPEN_MARKET_PREDICATE },
        state: "Open",
      } as MarketAccount;
      expect(bet.label).toBe(sideOutcome(created, participants, "Yes"));
    }
  });

  it("drops a side whose name is missing, and offers nothing without participants", () => {
    expect(
      openableBets({ participant1: "France", participant2: "  " }),
    ).toEqual([{ statKey: 1, label: "France scores" }]);
    expect(openableBets(null)).toEqual([]);
  });
});

describe("the fixed predicate", () => {
  it("is threshold 0, GreaterThan, full match (period 0)", () => {
    expect(OPEN_MARKET_PREDICATE.threshold).toBe(0);
    expect(OPEN_MARKET_PREDICATE.comparison).toBe(Comparison.GreaterThan);
    expect(OPEN_MARKET_PERIOD).toBe(0);
  });
});

describe("decideOpen — create-or-join, never an error", () => {
  it("creates when no market exists at the PDA", () => {
    expect(decideOpen(null)).toEqual({ kind: "create" });
  });

  it("joins the existing market when the (fixture, stat) PDA is taken", () => {
    const existing = { address: "GUQY5VD6syE8TEeywPrUa91U2L1Tnp7y1qjoNzwd34kg" } as MarketAccount;
    const decision = decideOpen(existing);
    expect(decision.kind).toBe("join");
    if (decision.kind === "join") {
      expect(decision.market.address).toBe(existing.address);
    }
  });
});
