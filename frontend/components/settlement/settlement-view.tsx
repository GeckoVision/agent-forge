"use client";

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ExternalLink, ShieldCheck, Sparkles, Unlink } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  fixtureHeadline,
  MarketSummary,
} from "@/components/settlement/market-summary";
import { MerkleProofViewer } from "@/components/settlement/merkle-proof-viewer";
import { SettlementActivity } from "@/components/settlement/settlement-activity";
import { OpenMarketPanel } from "@/components/settlement/open-market-panel";
import { PlaceBetPanel } from "@/components/settlement/place-bet-panel";
import { useMarkets } from "@/hooks/use-markets";
import { useLinkedMarket } from "@/hooks/use-linked-market";
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
import type { MarketAccount } from "@/lib/solana/forge-client";
import { mergeLinkedMarket, resolveBetMarket } from "@/lib/solana/share";
import { cn } from "@/lib/utils";

export function SettlementView() {
  const config = getNetworkConfig(DATA_MODE);
  const { markets, loading } = useMarkets();
  const {
    lookup: participantsFor,
    covered,
    loading: fixturesLoading,
  } = useFixtureParticipants();
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
  // A shared link (`?market=<address>`) resolves to a real on-chain market, or to the
  // honest "this link doesn't point to a market" state — never an invented market.
  const linked = useLinkedMarket(useSearchParams().get("market"));
  // A market opened (or joined) through the open-a-market panel this session — merged
  // into the tabs exactly like a linked market, so landing on it needs no refetch/scan.
  const [opened, setOpened] = useState<MarketAccount | null>(null);
  const tabs = useMemo(
    () => mergeLinkedMarket(mergeLinkedMarket(featured, linked.market), opened),
    [featured, linked.market, opened],
  );

  const [picked, setPicked] = useState<string | null>(null);
  const [openPanelShown, setOpenPanelShown] = useState(false);
  // The linked market acts as an explicit pick (that's the whole point of the link),
  // until the visitor picks a tab themselves.
  const selected =
    picked ?? linked.market?.address ?? featured[0]?.address ?? null;
  const explicitPick = picked !== null || linked.market !== null;
  const anyOpen = tabs.some((m) => m.state !== "Settled");

  // Keyed by address so a stale result for a previously-selected market is
  // detectable during render (no synchronous reset inside the effect).
  const [txState, setTxState] = useState<{
    address: string | null;
    txs: MarketTx[] | null;
  }>({ address: null, txs: null });

  const market = tabs.find((m) => m.address === selected) ?? null;

  // The bet panel needs a market that can actually accept a stake. Until the visitor (or
  // their shared link) picks a market we point it at the open one; a pick is honoured —
  // a settled market's fail-closed refusal is a real thing to show, not a bug to route around.
  const betMarket = resolveBetMarket(tabs, selected, explicitPick);

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

  // Landing is the same for a freshly created market and an already-open one being
  // joined: it becomes a tab and the page selects it (share button front and centre).
  const landOnMarket = (m: MarketAccount) => {
    setOpened(m);
    setPicked(m.address);
  };

  return (
    <div className="flex flex-col">
      <div className="mx-auto w-full max-w-6xl px-4 sm:px-6">
        {/* a shared link that doesn't resolve — say so honestly, keep the page working */}
        {linked.status === "invalid" && (
          <p className="mb-3 flex items-center gap-2 rounded-lg border border-border/70 bg-secondary/40 p-2.5 text-xs leading-relaxed text-muted-foreground">
            <Unlink className="size-3.5 shrink-0" />
            This link doesn&rsquo;t point to a market — here&rsquo;s what&rsquo;s
            live instead.
          </p>
        )}

        {/* market selector */}
        <div className="flex flex-wrap items-center gap-2">
          {tabs.map((m) => {
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
          {tabs.length === 0 && !loading && (
            <p className="text-sm text-muted-foreground">
              No markets could be read from devnet right now — the public RPC may
              be rate-limiting the program scan.
            </p>
          )}
          {/* the other half of the group-chat wedge: don't just join a bet — start one */}
          <Button
            variant="outline"
            onClick={() => setOpenPanelShown((v) => !v)}
            className={cn(openPanelShown && "border-accent/40 bg-accent/5")}
          >
            <Sparkles className="text-accent" />
            Open a market
          </Button>
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

        {/* open a market — inline panel, one signature, lands on the share link */}
        {openPanelShown && (
          <Card className="mt-5">
            <CardContent>
              <OpenMarketPanel
                covered={covered}
                loadingFixtures={fixturesLoading}
                cluster={config.explorerCluster}
                onLand={landOnMarket}
                onClose={() => setOpenPanelShown(false)}
              />
            </CardContent>
          </Card>
        )}

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
                {!anyOpen && (
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
