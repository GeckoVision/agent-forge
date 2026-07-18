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
import type { MarketAccount } from "@/lib/solana/forge-client";
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
  const market = (address: string, fixtureId: bigint, statKey = 1) =>
    ({ address, fixtureId, statKey }) as MarketAccount;

  it("features what is actually on chain, and never pads the list", () => {
    const markets = [market("a", 1n), market("b", 2n)];
    expect(selectFeatured(markets, 2).map((m) => m.address)).toEqual(["a", "b"]);
    // one market on chain -> one featured, not a padded pair
    expect(selectFeatured([market("a", 1n)], 2)).toHaveLength(1);
  });

  it("features nothing when the chain read failed", () => {
    expect(selectFeatured(null, 2)).toEqual([]);
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
