import { describe, expect, it } from "vitest";
import { Connection, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";

import {
  classifyByDiscriminator,
  fetchMarket,
  fetchMarketTransactions,
  fetchMarkets,
  fetchPositions,
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
      getAccountInfo: async () => ({ data: MARKET_DATA }),
    });
    const m = await fetchMarket(MARKET_ADDRESS, "devnet", conn);
    expect(m?.fixtureId).toBe(MARKET_EXPECTED.fixtureId);
  });

  it("returns null when the account does not exist", async () => {
    const conn = fakeConn({ getAccountInfo: async () => null });
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
      getAccountInfo: async () => ({ data: MARKET_DATA }),
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
