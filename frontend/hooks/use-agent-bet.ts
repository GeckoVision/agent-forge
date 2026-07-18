"use client";

import { useEffect, useState } from "react";

import { DATA_MODE, getNetworkConfig } from "@/lib/solana/config";
import type { MarketAccount, PositionAccount } from "@/lib/solana/forge-client";
import {
  fetchMarketTransactions,
  fetchPositions,
  findAllByFixture,
  type MarketTx,
} from "@/lib/solana/markets";
import { useMarkets } from "@/hooks/use-markets";

export interface AgentBet {
  market: MarketAccount;
  /** Every stake on that market, from the program's Position accounts. */
  positions: PositionAccount[] | null;
  /** The `stake` transaction, classified by its real instruction discriminator. */
  stakeTx: MarketTx | null;
}

export interface AgentBetsState {
  bets: AgentBet[];
  loading: boolean;
  /** True when devnet could not be read at all — the UI must say so, not guess. */
  unavailable: boolean;
}

/**
 * The agent's stakes as they exist ON CHAIN right now for the replayed fixture.
 *
 * ALL of that fixture's markets are returned, never one picked as "the" bet: the program holds
 * one market per (fixture, stat), and choosing between them in the UI would assert something
 * the chain does not say. Every value — address, stake, signature — is read live; nothing is
 * hardcoded, so if the chain says nothing, the UI shows nothing.
 */
export function useAgentBets(fixtureId: number): AgentBetsState {
  const config = getNetworkConfig(DATA_MODE);
  const { markets, error } = useMarkets();
  const [details, setDetails] = useState<Map<string, AgentBet> | null>(null);

  const forFixture = markets ? findAllByFixture(markets, fixtureId) : [];
  const addresses = forFixture.map((m) => m.address).join(",");

  useEffect(() => {
    if (!addresses) return;
    let alive = true;
    // Sequential: the public devnet RPC 429s bursts, and a degraded read here would look
    // like "no stake" rather than "couldn't read".
    (async () => {
      const out = new Map<string, AgentBet>();
      for (const market of forFixture) {
        const positions = await fetchPositions(market.address, DATA_MODE).catch(() => []);
        const txs = await fetchMarketTransactions(market.address, config, 10).catch(
          () => [] as MarketTx[],
        );
        out.set(market.address, {
          market,
          positions,
          stakeTx: txs.find((t) => t.kind === "stake" && !t.err) ?? null,
        });
      }
      if (alive) setDetails(out);
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addresses]);

  const marketsLoading = markets === null && error === null;
  const bets = forFixture.map(
    (market) =>
      details?.get(market.address) ?? { market, positions: null, stakeTx: null },
  );

  return {
    bets,
    loading: marketsLoading || (forFixture.length > 0 && details === null),
    unavailable: error !== null || (markets !== null && forFixture.length === 0),
  };
}
