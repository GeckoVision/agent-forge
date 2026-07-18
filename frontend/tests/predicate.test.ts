import { describe, expect, it } from "vitest";

import { Comparison, type MarketAccount } from "@/lib/solana/forge-client";
import {
  describePredicate,
  humanPredicate,
  predicateHeadline,
  sideOutcome,
  teamForStatKey,
  technicalPredicate,
} from "@/lib/solana/predicate";

const FRANCE_ENGLAND = { participant1: "France", participant2: "England" };

function market(
  statKey: number,
  comparison: Comparison,
  threshold: number,
): MarketAccount {
  return {
    address: "Addr",
    fixtureId: 18257865n,
    statKey,
    predicate: { threshold, comparison },
    vault: "Vault",
    stakeYes: 0n,
    stakeNo: 0n,
    state: "Open",
    winner: "Yes",
    authority: "Auth",
    potLamports: 0n,
  };
}

describe("technicalPredicate — always renderable, never wrong", () => {
  it("renders the exact on-chain form for any stat key", () => {
    expect(technicalPredicate(market(1, Comparison.GreaterThan, 0))).toBe(
      "stat #1 > 0",
    );
    expect(technicalPredicate(market(37, Comparison.LessThan, 2))).toBe(
      "stat #37 < 2",
    );
    expect(technicalPredicate(market(2, Comparison.EqualTo, 1))).toBe(
      "stat #2 = 1",
    );
  });
});

describe("humanPredicate — only the two verified goal stats get a name", () => {
  it("names participant 1 for stat key 1", () => {
    expect(humanPredicate(market(1, Comparison.GreaterThan, 0), FRANCE_ENGLAND)).toBe(
      "France to score",
    );
  });

  it("names participant 2 for stat key 2", () => {
    expect(humanPredicate(market(2, Comparison.GreaterThan, 0), FRANCE_ENGLAND)).toBe(
      "England to score",
    );
  });

  it("refuses to guess for any other stat key", () => {
    for (const key of [0, 3, 5, 37, 63]) {
      expect(
        humanPredicate(market(key, Comparison.GreaterThan, 0), FRANCE_ENGLAND),
      ).toBeNull();
    }
  });

  it("falls back to null when participant names are missing", () => {
    expect(humanPredicate(market(1, Comparison.GreaterThan, 0), null)).toBeNull();
    expect(
      humanPredicate(market(1, Comparison.GreaterThan, 0), {
        participant1: "",
        participant2: "England",
      }),
    ).toBeNull();
  });
});

describe("humanPredicate — comparison + threshold handled generally", () => {
  it("phrases higher thresholds for GreaterThan", () => {
    expect(humanPredicate(market(1, Comparison.GreaterThan, 1), FRANCE_ENGLAND)).toBe(
      "France to score more than 1 goal",
    );
    expect(humanPredicate(market(1, Comparison.GreaterThan, 2), FRANCE_ENGLAND)).toBe(
      "France to score more than 2 goals",
    );
  });

  it("phrases LessThan, including the 'not to score' shorthand", () => {
    expect(humanPredicate(market(1, Comparison.LessThan, 1), FRANCE_ENGLAND)).toBe(
      "France not to score",
    );
    expect(humanPredicate(market(1, Comparison.LessThan, 3), FRANCE_ENGLAND)).toBe(
      "France to score fewer than 3 goals",
    );
  });

  it("phrases EqualTo, including the zero-goals case", () => {
    expect(humanPredicate(market(2, Comparison.EqualTo, 0), FRANCE_ENGLAND)).toBe(
      "England not to score",
    );
    expect(humanPredicate(market(2, Comparison.EqualTo, 2), FRANCE_ENGLAND)).toBe(
      "England to score exactly 2 goals",
    );
  });

  it("refuses impossible/degenerate thresholds rather than saying nonsense", () => {
    // `< 0` can never hold; a negative threshold is not a goal count.
    expect(humanPredicate(market(1, Comparison.LessThan, 0), FRANCE_ENGLAND)).toBeNull();
    expect(
      humanPredicate(market(1, Comparison.GreaterThan, -1), FRANCE_ENGLAND),
    ).toBeNull();
  });
});

describe("describePredicate / predicateHeadline — pairing human with technical", () => {
  it("returns both forms, technical always present", () => {
    expect(describePredicate(market(1, Comparison.GreaterThan, 0), FRANCE_ENGLAND)).toEqual(
      { human: "France to score", technical: "stat #1 > 0" },
    );
    expect(describePredicate(market(9, Comparison.GreaterThan, 0), FRANCE_ENGLAND)).toEqual(
      { human: null, technical: "stat #9 > 0" },
    );
  });

  it("headline prefers the human sentence and falls back to technical", () => {
    expect(predicateHeadline(market(1, Comparison.GreaterThan, 0), FRANCE_ENGLAND)).toBe(
      "France to score",
    );
    expect(predicateHeadline(market(9, Comparison.GreaterThan, 0), FRANCE_ENGLAND)).toBe(
      "stat #9 > 0",
    );
  });
});

describe("sideOutcome — what each side means, with an honest negation", () => {
  it("states YES and its negation for the common '> 0' market", () => {
    const m = market(1, Comparison.GreaterThan, 0);
    expect(sideOutcome(m, FRANCE_ENGLAND, "Yes")).toBe("France scores");
    expect(sideOutcome(m, FRANCE_ENGLAND, "No")).toBe("France doesn't score");
  });

  it("uses participant 2's name for stat key 2", () => {
    const m = market(2, Comparison.GreaterThan, 0);
    expect(sideOutcome(m, FRANCE_ENGLAND, "Yes")).toBe("England scores");
    expect(sideOutcome(m, FRANCE_ENGLAND, "No")).toBe("England doesn't score");
  });

  it("negates '> n' as 'n or fewer'", () => {
    const m = market(1, Comparison.GreaterThan, 2);
    expect(sideOutcome(m, FRANCE_ENGLAND, "Yes")).toBe(
      "France scores more than 2 goals",
    );
    expect(sideOutcome(m, FRANCE_ENGLAND, "No")).toBe("France scores 2 goals or fewer");
  });

  it("negates '< n' as 'n or more', with the '< 1' shorthand", () => {
    const m1 = market(1, Comparison.LessThan, 1);
    expect(sideOutcome(m1, FRANCE_ENGLAND, "Yes")).toBe("France doesn't score");
    expect(sideOutcome(m1, FRANCE_ENGLAND, "No")).toBe("France scores");
    const m3 = market(1, Comparison.LessThan, 3);
    expect(sideOutcome(m3, FRANCE_ENGLAND, "Yes")).toBe(
      "France scores fewer than 3 goals",
    );
    expect(sideOutcome(m3, FRANCE_ENGLAND, "No")).toBe("France scores 3 goals or more");
  });

  it("negates '= n', with the '= 0' shorthand", () => {
    const m0 = market(2, Comparison.EqualTo, 0);
    expect(sideOutcome(m0, FRANCE_ENGLAND, "Yes")).toBe("England doesn't score");
    expect(sideOutcome(m0, FRANCE_ENGLAND, "No")).toBe("England scores");
    const m2 = market(2, Comparison.EqualTo, 2);
    expect(sideOutcome(m2, FRANCE_ENGLAND, "Yes")).toBe(
      "England scores exactly 2 goals",
    );
    expect(sideOutcome(m2, FRANCE_ENGLAND, "No")).toBe(
      "England doesn't score exactly 2 goals",
    );
  });

  it("never invents an outcome for an unmapped stat, missing names, or degenerate thresholds", () => {
    expect(
      sideOutcome(market(9, Comparison.GreaterThan, 0), FRANCE_ENGLAND, "Yes"),
    ).toBeNull();
    expect(
      sideOutcome(market(9, Comparison.GreaterThan, 0), FRANCE_ENGLAND, "No"),
    ).toBeNull();
    expect(sideOutcome(market(1, Comparison.GreaterThan, 0), null, "No")).toBeNull();
    expect(
      sideOutcome(market(1, Comparison.LessThan, 0), FRANCE_ENGLAND, "No"),
    ).toBeNull();
    expect(
      sideOutcome(market(1, Comparison.GreaterThan, -1), FRANCE_ENGLAND, "Yes"),
    ).toBeNull();
  });
});

describe("teamForStatKey", () => {
  it("maps 1 → participant1, 2 → participant2, nothing else", () => {
    expect(teamForStatKey(1, FRANCE_ENGLAND)).toBe("France");
    expect(teamForStatKey(2, FRANCE_ENGLAND)).toBe("England");
    expect(teamForStatKey(3, FRANCE_ENGLAND)).toBeNull();
    expect(teamForStatKey(1, null)).toBeNull();
  });
});
