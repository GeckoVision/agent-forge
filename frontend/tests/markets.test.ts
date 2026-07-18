import { describe, expect, it } from "vitest";
import { Connection, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";

import {
  classifyByDiscriminator,
  fetchMarket,
  fetchMarketTransactions,
  fetchMarkets,
  fetchPositions,
  fetchWalletPositions,
  findAllByFixture,
  findSettleTx,
  selectFeatured,
} from "@/lib/solana/markets";
import type { MarketAccount, MarketStateName } from "@/lib/solana/forge-client";
import { DISCRIMINATORS } from "@/lib/solana/forge-client";
import { FORGE_PROGRAM_ID, getNetworkConfig } from "@/lib/solana/config";
import {
  MARKET_ADDRESS,
  MARKET_DATA,
  MARKET_EXPECTED,
  POSITION_DATA,
} from "./fixtures";

// A light fake Connection — only the methods the data layer touches. Cast at the
// call site keeps the fakes tiny (well under the over-mocking threshold).
function fakeConn(overrides: Record<string, unknown>): Connection {
  return overrides as unknown as Connection;
}

const RATE_LIMIT = () => {
  throw new Error("429 Too Many Requests");
};

describe("fetchMarket", () => {
  it("decodes an existing account", async () => {
    const conn = fakeConn({
      getAccountInfo: async () => ({ data: MARKET_DATA, owner: FORGE_PROGRAM_ID }),
    });
    const m = await fetchMarket(MARKET_ADDRESS, "devnet", conn);
    expect(m?.fixtureId).toBe(MARKET_EXPECTED.fixtureId);
  });

  it("returns null when the account does not exist", async () => {
    const conn = fakeConn({ getAccountInfo: async () => null });
    expect(await fetchMarket(MARKET_ADDRESS, "devnet", conn)).toBeNull();
  });

  it("returns null when the account is NOT owned by the forge program", async () => {
    // A shared ?market= link can point at any account; market-shaped bytes under a
    // different owner must never render as a market.
    const conn = fakeConn({
      getAccountInfo: async () => ({
        data: MARKET_DATA,
        owner: new PublicKey(MARKET_ADDRESS),
      }),
    });
    expect(await fetchMarket(MARKET_ADDRESS, "devnet", conn)).toBeNull();
  });
});

describe("fetchMarkets", () => {
  it("decodes the bulk getProgramAccounts scan", async () => {
    const conn = fakeConn({
      getProgramAccounts: async () => [
        { pubkey: new PublicKey(MARKET_ADDRESS), account: { data: MARKET_DATA } },
      ],
      getAccountInfo: async () => null, // no extra featured markets
    });
    const markets = await fetchMarkets("devnet", conn);
    expect(markets).toHaveLength(1);
    expect(markets[0].address).toBe(MARKET_ADDRESS);
    expect(markets[0].fixtureId).toBe(MARKET_EXPECTED.fixtureId);
  });

  it("degrades to the known-real fallback when the scan is rate-limited (no throw)", async () => {
    const conn = fakeConn({
      getProgramAccounts: RATE_LIMIT,
      getAccountInfo: async () => ({ data: MARKET_DATA, owner: FORGE_PROGRAM_ID }),
    });
    const markets = await fetchMarkets("devnet", conn);
    expect(markets.length).toBe(getNetworkConfig("devnet").fallbackMarkets.length);
  });

  it("resolves (never rejects) even if EVERYTHING rate-limits", async () => {
    const conn = fakeConn({
      getProgramAccounts: RATE_LIMIT,
      getAccountInfo: RATE_LIMIT,
    });
    await expect(fetchMarkets("devnet", conn)).resolves.toEqual([]);
  });

  it("skips accounts that fail to decode", async () => {
    const conn = fakeConn({
      getProgramAccounts: async () => [
        { pubkey: new PublicKey(MARKET_ADDRESS), account: { data: new Uint8Array(10) } },
      ],
      getAccountInfo: async () => null,
    });
    await expect(fetchMarkets("devnet", conn)).resolves.toEqual([]);
  });
});

describe("fetchPositions", () => {
  it("decodes positions from the memcmp scan", async () => {
    const conn = fakeConn({
      getProgramAccounts: async () => [
        { pubkey: new PublicKey(MARKET_ADDRESS), account: { data: POSITION_DATA } },
      ],
    });
    const positions = await fetchPositions(MARKET_ADDRESS, "devnet", conn);
    expect(positions).toHaveLength(1);
    expect(positions[0].amount).toBe(5_000_000n);
    expect(positions[0].side).toBe("No");
  });

  it("returns [] when the scan is rate-limited", async () => {
    const conn = fakeConn({ getProgramAccounts: RATE_LIMIT });
    await expect(fetchPositions(MARKET_ADDRESS, "devnet", conn)).resolves.toEqual([]);
  });
});

describe("fetchWalletPositions", () => {
  const OWNER = "G4miHrpWdyZwB5WJSDQVyeb1Q7XGA2FPFBAKmCaEWYro"; // the fixture position's owner

  it("scans by Position size + owner memcmp at offset 40 (disc 8 + market 32)", async () => {
    let seenFilters: unknown;
    const conn = fakeConn({
      getProgramAccounts: async (_pid: unknown, cfg: { filters: unknown }) => {
        seenFilters = cfg.filters;
        return [
          { pubkey: new PublicKey(MARKET_ADDRESS), account: { data: POSITION_DATA } },
        ];
      },
    });
    const positions = await fetchWalletPositions(OWNER, "devnet", conn);
    expect(seenFilters).toEqual([
      { dataSize: 99 },
      { memcmp: { offset: 40, bytes: OWNER } },
    ]);
    expect(positions).toHaveLength(1);
    expect(positions![0].owner).toBe(OWNER);
    expect(positions![0].amount).toBe(5_000_000n);
  });

  it("returns null (NOT []) when the scan is rate-limited — the caller must say so", async () => {
    // [] would read as "no bets yet", which is a lie when the RPC refused the scan.
    const conn = fakeConn({ getProgramAccounts: RATE_LIMIT });
    await expect(fetchWalletPositions(OWNER, "devnet", conn)).resolves.toBeNull();
  });

  it("skips accounts that fail to decode rather than failing the whole scan", async () => {
    const conn = fakeConn({
      getProgramAccounts: async () => [
        { pubkey: new PublicKey(MARKET_ADDRESS), account: { data: new Uint8Array(10) } },
        { pubkey: new PublicKey(MARKET_ADDRESS), account: { data: POSITION_DATA } },
      ],
    });
    const positions = await fetchWalletPositions(OWNER, "devnet", conn);
    expect(positions).toHaveLength(1);
  });
});

describe("fetchMarketTransactions", () => {
  const config = getNetworkConfig("devnet");

  function parsedTxFor(disc: number[] | null) {
    const instructions = disc
      ? [{ programId: FORGE_PROGRAM_ID, data: bs58.encode(Uint8Array.from(disc)), accounts: [] }]
      : [{ programId: new PublicKey(MARKET_ADDRESS), data: bs58.encode(Uint8Array.from([1, 2, 3])), accounts: [] }];
    return { transaction: { message: { instructions } } };
  }

  it("classifies each tx by its forge discriminator", async () => {
    const conn = fakeConn({
      getSignaturesForAddress: async () => [
        { signature: "sigSettle", blockTime: 20, err: null },
        { signature: "sigCreate", blockTime: 10, err: null },
        { signature: "sigOther", blockTime: 30, err: null },
      ],
      getParsedTransaction: async (sig: string) => {
        if (sig === "sigSettle") return parsedTxFor(DISCRIMINATORS.settle);
        if (sig === "sigCreate") return parsedTxFor(DISCRIMINATORS.create_market);
        return parsedTxFor(null);
      },
    });
    const txs = await fetchMarketTransactions(MARKET_ADDRESS, config, 10, conn);
    expect(txs.map((t) => t.kind)).toEqual(["settle", "create_market", "other"]);
    expect(findSettleTx(txs)?.signature).toBe("sigSettle");
  });

  it("marks errored transactions and never picks an errored settle", async () => {
    const conn = fakeConn({
      getSignaturesForAddress: async () => [
        { signature: "sigSettleErr", blockTime: 1, err: { InstructionError: [] } },
      ],
      getParsedTransaction: async () => parsedTxFor(DISCRIMINATORS.settle),
    });
    const txs = await fetchMarketTransactions(MARKET_ADDRESS, config, 10, conn);
    expect(txs[0].err).toBe(true);
    expect(findSettleTx(txs)).toBeNull();
  });

  it("returns [] when the signatures lookup is rate-limited", async () => {
    const conn = fakeConn({ getSignaturesForAddress: RATE_LIMIT });
    await expect(
      fetchMarketTransactions(MARKET_ADDRESS, config, 10, conn),
    ).resolves.toEqual([]);
  });

  it("labels a tx 'other' when its parse fails, rather than dropping it", async () => {
    const conn = fakeConn({
      getSignaturesForAddress: async () => [
        { signature: "sigBad", blockTime: 1, err: null },
      ],
      getParsedTransaction: RATE_LIMIT,
    });
    const txs = await fetchMarketTransactions(MARKET_ADDRESS, config, 10, conn);
    expect(txs).toHaveLength(1);
    expect(txs[0].kind).toBe("other");
  });
});

describe("selectFeatured / findAllByFixture", () => {
  const market = (
    address: string,
    fixtureId: bigint,
    statKey = 1,
    state: MarketStateName = "Open",
    potLamports = 0n,
  ) => ({ address, fixtureId, statKey, state, potLamports }) as MarketAccount;

  it("features what is actually on chain, and never pads the list", () => {
    const markets = [market("a", 1n), market("b", 2n)];
    expect(selectFeatured(markets, 2).map((m) => m.address)).toEqual(["a", "b"]);
    // one market on chain -> one featured, not a padded pair
    expect(selectFeatured([market("a", 1n)], 2)).toHaveLength(1);
  });

  it("features nothing when the chain read failed", () => {
    expect(selectFeatured(null, 2)).toEqual([]);
  });

  it("features one settled AND one open market, so both stories are tellable", () => {
    // fetchMarkets hands over settled-first; a blind slice(0, 2) would feature two
    // settled markets and leave the bet panel pointed at a market that cannot accept a stake.
    const markets = [
      market("settled-big", 1n, 1, "Settled", 900n),
      market("settled-small", 2n, 1, "Settled", 100n),
      market("open-big", 3n, 1, "Open", 500n),
      market("open-small", 4n, 1, "Open", 50n),
    ];
    const featured = selectFeatured(markets, 2);
    expect(featured.map((m) => m.address)).toEqual(["settled-big", "open-big"]);
    expect(featured.map((m) => m.state)).toEqual(["Settled", "Open"]);
  });

  it("picks the highest-pot market of each state regardless of input order", () => {
    const markets = [
      market("open-small", 1n, 1, "Open", 10n),
      market("settled-small", 2n, 1, "Settled", 20n),
      market("open-big", 3n, 1, "Open", 999n),
      market("settled-big", 4n, 1, "Settled", 888n),
    ];
    expect(selectFeatured(markets, 2).map((m) => m.address)).toEqual([
      "settled-big",
      "open-big",
    ]);
  });

  it("degrades gracefully when every market is settled", () => {
    const markets = [
      market("s1", 1n, 1, "Settled", 300n),
      market("s2", 2n, 1, "Settled", 200n),
    ];
    // no open market exists on chain -> feature the settled ones rather than invent one
    expect(selectFeatured(markets, 2).map((m) => m.address)).toEqual(["s1", "s2"]);
    expect(selectFeatured(markets, 2).every((m) => m.state === "Settled")).toBe(true);
  });

  it("degrades gracefully when every market is open", () => {
    const markets = [
      market("o1", 1n, 1, "Open", 300n),
      market("o2", 2n, 1, "Open", 200n),
    ];
    expect(selectFeatured(markets, 2).map((m) => m.address)).toEqual(["o1", "o2"]);
  });

  it("prefers open markets on DISTINCT matches, so a new match's fresh market surfaces", () => {
    // Two markets exist on the France match (with pots) and two brand-new pot-0 markets on
    // the next match. Pure pot-desc ordering would bury the new match under France's second
    // market — the distinct-match rule features one open market per match instead.
    const markets = [
      market("settled", 1n, 1, "Settled", 900n),
      market("france-1", 2n, 1, "Open", 500n),
      market("france-2", 2n, 2, "Open", 400n),
      market("next-1", 3n, 1, "Open", 0n),
      market("next-2", 3n, 2, "Open", 0n),
    ];
    expect(selectFeatured(markets, 3).map((m) => m.address)).toEqual([
      "settled",
      "france-1",
      "next-1",
    ]);
  });

  it("ranks distinct open matches by kickoff (newest first) when a schedule is known", () => {
    // Mirrors the real devnet shape: a rich-pot market on a match played weeks ago must not
    // bury the matches happening now/next, and a synthetic demo market (no schedule) goes last
    // however it sorts by pot.
    const markets = [
      market("settled", 1n, 1, "Settled", 900n),
      market("today-big", 2n, 1, "Open", 15_000_000n),
      market("today-b", 2n, 2, "Open", 10_000_000n),
      market("weeks-ago-rich", 3n, 1, "Open", 10_000_000n),
      market("tomorrow-fresh", 4n, 1, "Open", 0n),
      market("demo-open", 5n, 1, "Open", 0n),
    ];
    const kickoff: Record<string, number> = { "2": 100, "3": 10, "4": 200 }; // 5 unknown
    const schedule = (fixtureId: bigint) => {
      const ms = kickoff[fixtureId.toString()];
      return ms === undefined ? null : { kickoffMs: ms };
    };
    expect(selectFeatured(markets, 4, schedule).map((m) => m.address)).toEqual([
      "settled",
      "tomorrow-fresh",
      "today-big",
      "weeks-ago-rich",
    ]);
    // without a schedule the old pot-desc order still holds (pot-0 tie → address order)
    expect(selectFeatured(markets, 4).map((m) => m.address)).toEqual([
      "settled",
      "today-big",
      "weeks-ago-rich",
      "demo-open",
    ]);
  });

  it("breaks pot ties deterministically by stat key", () => {
    // Both pot 0 — the lower stat key wins regardless of input order.
    const markets = [
      market("stat2", 3n, 2, "Open", 0n),
      market("stat1", 3n, 1, "Open", 0n),
    ];
    expect(selectFeatured(markets, 1).map((m) => m.address)).toEqual(["stat1"]);
  });

  it("backfills with same-match opens when no other match exists — never drops a slot", () => {
    const markets = [
      market("s", 1n, 1, "Settled", 1n),
      market("o1", 2n, 1, "Open", 5n),
      market("o2", 2n, 2, "Open", 4n),
    ];
    expect(selectFeatured(markets, 3).map((m) => m.address)).toEqual(["s", "o1", "o2"]);
  });

  it("never pads when only one state is present or the chain holds fewer than count", () => {
    expect(selectFeatured([market("s", 1n, 1, "Settled", 5n)], 2)).toHaveLength(1);
    expect(selectFeatured([market("o", 1n, 1, "Open", 5n)], 2)).toHaveLength(1);
    expect(selectFeatured([], 2)).toEqual([]);
    // a bigger count than the chain holds still returns exactly what exists, deduplicated
    const mixed = [
      market("s", 1n, 1, "Settled", 5n),
      market("o", 2n, 1, "Open", 5n),
    ];
    const many = selectFeatured(mixed, 5);
    expect(many).toHaveLength(2);
    expect(new Set(many.map((m) => m.address)).size).toBe(2);
  });

  it("returns EVERY market for a fixture, so no real stake is silently dropped", () => {
    // one fixture, two stats -> two real markets; picking one would hide the other
    const markets = [
      market("a", 1n),
      market("stat2", 18257865n, 2),
      market("stat1", 18257865n, 1),
    ];
    expect(findAllByFixture(markets, 18257865).map((m) => m.address)).toEqual([
      "stat1",
      "stat2",
    ]);
    expect(findAllByFixture(markets, 999)).toEqual([]);
    expect(findAllByFixture(null, 1)).toEqual([]);
  });
});

describe("classifyByDiscriminator", () => {
  it("matches each known instruction", () => {
    expect(classifyByDiscriminator(Uint8Array.from(DISCRIMINATORS.settle))).toBe("settle");
    expect(classifyByDiscriminator(Uint8Array.from(DISCRIMINATORS.stake))).toBe("stake");
    expect(classifyByDiscriminator(Uint8Array.from(DISCRIMINATORS.claim))).toBe("claim");
    expect(classifyByDiscriminator(Uint8Array.from([9, 9, 9, 9, 9, 9, 9, 9]))).toBe("other");
  });
});
