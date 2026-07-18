"use client";

import { useEffect, useMemo, useState } from "react";
import { ExternalLink, ShieldCheck } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  fixtureHeadline,
  MarketSummary,
} from "@/components/settlement/market-summary";
import { MerkleProofViewer } from "@/components/settlement/merkle-proof-viewer";
import { SettlementActivity } from "@/components/settlement/settlement-activity";
import { PlaceBetPanel } from "@/components/settlement/place-bet-panel";
import { useMarkets } from "@/hooks/use-markets";
import { useFixtureParticipants } from "@/hooks/use-fixture-participants";
import { predicateHeadline } from "@/lib/solana/predicate";
import { formatSol } from "@/lib/format";
import { DATA_MODE, explorerTx, getNetworkConfig } from "@/lib/solana/config";
import {
  fetchMarketTransactions,
  findSettleTx,
  selectFeatured,
  type MarketTx,
} from "@/lib/solana/markets";
import { cn } from "@/lib/utils";

export function SettlementView() {
  const config = getNetworkConfig(DATA_MODE);
  const { markets, loading } = useMarkets();
  const { lookup: participantsFor } = useFixtureParticipants();
  // The featured markets are whatever the program actually owns on chain (a settled one for
  // the proof, open ones on distinct matches to stake against), not a hardcoded list — so the
  // page can only ever show markets that exist. The capture's kickoff times rank the open
  // matches newest-first; markets on fixtures the capture doesn't know sort last.
  const featured = useMemo(
    () =>
      selectFeatured(markets, 3, (fixtureId) => {
        const kickoffMs = participantsFor(fixtureId)?.kickoffMs;
        return kickoffMs != null ? { kickoffMs } : null;
      }),
    [markets, participantsFor],
  );
  const [picked, setPicked] = useState<string | null>(null);
  const selected = picked ?? featured[0]?.address ?? null;
  const openFeatured = featured.find((m) => m.state !== "Settled") ?? null;

  // Keyed by address so a stale result for a previously-selected market is
  // detectable during render (no synchronous reset inside the effect).
  const [txState, setTxState] = useState<{
    address: string | null;
    txs: MarketTx[] | null;
  }>({ address: null, txs: null });

  const market = featured.find((m) => m.address === selected) ?? null;

  // The bet panel needs a market that can actually accept a stake. Until the visitor picks
  // a market themselves we point it at the open one; once they pick, we honour the pick —
  // a settled market's fail-closed refusal is a real thing to show, not a bug to route around.
  const betMarket = picked ? market : (openFeatured ?? market);

  useEffect(() => {
    if (!selected) return;
    let alive = true;
    fetchMarketTransactions(selected, config, 10)
      .then((t) => alive && setTxState({ address: selected, txs: t }))
      .catch(() => alive && setTxState({ address: selected, txs: [] }));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  const txs = txState.address === selected ? txState.txs : null;
  const txLoading = txs === null;
  const settleTx = txs ? findSettleTx(txs) : null;

  return (
    <div className="flex flex-col">
      <div className="mx-auto w-full max-w-6xl px-4 sm:px-6">
        {/* market selector */}
        <div className="flex flex-wrap items-center gap-2">
          {featured.map((m) => {
            const addr = m.address;
            const active = addr === selected;
            const parts = participantsFor(m.fixtureId);
            const isSettled = m.state === "Settled";
            return (
              <button
                key={addr}
                onClick={() => setPicked(addr)}
                className={cn(
                  "flex min-w-[13rem] flex-1 flex-col gap-1.5 rounded-lg border px-3 py-2.5 text-left transition-colors cursor-pointer",
                  active
                    ? "border-primary/40 bg-primary/5"
                    : "border-border/70 hover:bg-secondary",
                )}
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-2">
                    <span
                      className={cn(
                        "size-2 rounded-full",
                        active ? "bg-primary" : "bg-muted-foreground/40",
                      )}
                    />
                    <span className="text-sm font-medium">
                      {fixtureHeadline(m, parts)}
                    </span>
                  </span>
                  <span
                    className={cn(
                      "rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                      isSettled
                        ? "bg-yes/10 text-yes"
                        : "bg-accent/10 text-accent",
                    )}
                  >
                    {isSettled ? "Settled" : "Open"}
                  </span>
                </span>
                <span className="flex items-center justify-between gap-2 pl-4">
                  <span className="text-xs text-muted-foreground">
                    {predicateHeadline(m, parts)}
                  </span>
                  <span className="tabular text-xs font-medium text-gold">
                    {formatSol(m.potLamports)} SOL
                  </span>
                </span>
              </button>
            );
          })}
          {featured.length === 0 && !loading && (
            <p className="text-sm text-muted-foreground">
              No markets could be read from devnet right now — the public RPC may
              be rate-limiting the program scan.
            </p>
          )}
          {settleTx && (
            <a
              href={explorerTx(settleTx.signature, config.explorerCluster)}
              target="_blank"
              rel="noreferrer"
              className="ml-auto inline-flex items-center gap-1.5 rounded-lg bg-primary/10 px-3 py-2 text-sm font-medium text-primary transition-colors hover:bg-primary/15"
            >
              <ShieldCheck className="size-4" />
              View settle transaction
              <ExternalLink className="size-3.5" />
            </a>
          )}
        </div>

        {/* live market + place a bet */}
        <div className="mt-5 grid gap-4 lg:grid-cols-2">
          <Card>
            <CardContent>
              {market ? (
                <MarketSummary
                  market={market}
                  participants={participantsFor(market.fixtureId)}
                  cluster={config.explorerCluster}
                />
              ) : loading ? (
                <div className="flex flex-col gap-3">
                  <Skeleton className="h-8 w-40" />
                  <Skeleton className="h-16 w-full" />
                  <Skeleton className="h-24 w-full" />
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Could not load this market from the current RPC.
                </p>
              )}
            </CardContent>
          </Card>

          {betMarket && (
            <Card>
              <CardContent>
                {betMarket.address !== market?.address && (
                  <p className="mb-4 rounded-lg bg-secondary/40 p-2.5 text-xs leading-relaxed text-muted-foreground">
                    The market shown left is already settled, so this bet targets the open
                    market on chain —{" "}
                    <span className="text-foreground">
                      {fixtureHeadline(betMarket, participantsFor(betMarket.fixtureId))}
                    </span>
                    , {predicateHeadline(betMarket, participantsFor(betMarket.fixtureId))}.
                  </p>
                )}
                {!openFeatured && (
                  <p className="mb-4 rounded-lg bg-secondary/40 p-2.5 text-xs leading-relaxed text-muted-foreground">
                    No open market is live on{" "}
                    <span className="text-foreground">{config.explorerCluster}</span> right
                    now — every market the program owns is already settled, so any stake
                    below will be refused by the program.
                  </p>
                )}
                <PlaceBetPanel
                  market={betMarket}
                  participants={participantsFor(betMarket.fixtureId)}
                  cluster={config.explorerCluster}
                />
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      {/* the centerpiece — the page's single cream-inverted spotlight */}
      <section className="surface-cream my-10 border-y border-border">
        <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
          <p className="eyebrow mb-6 text-primary">The proof</p>
          <MerkleProofViewer
            predicateLabel={
              market
                ? predicateHeadline(market, participantsFor(market.fixtureId))
                : null
            }
            winner={market && market.state === "Settled" ? market.winner : null}
          />
        </div>
      </section>

      <div className="mx-auto w-full max-w-6xl px-4 sm:px-6">
        {/* lifecycle */}
        <Card>
          <CardContent>
            <SettlementActivity
              txs={txs}
              loading={txLoading}
              cluster={config.explorerCluster}
            />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
