"use client";

import { useEffect, useState } from "react";
import { CircleCheck, CircleDot, Link2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ExplorerLink } from "@/components/shared/explorer-link";
import type { ExplorerCluster } from "@/lib/solana/config";
import { type MarketAccount } from "@/lib/solana/forge-client";
import { marketShareUrl } from "@/lib/solana/share";
import {
  describePredicate,
  type FixtureParticipants,
  technicalPredicate,
} from "@/lib/solana/predicate";
import { formatSol } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * The technical predicate — kept as the exported default so non-settlement surfaces (hero,
 * track record, agent dashboard) that have no participant names keep rendering the exact
 * on-chain form. Settlement components pass participants and render the human sentence.
 */
export function predicateLabel(market: MarketAccount): string {
  return technicalPredicate(market);
}

/**
 * Teams as a headline ("France vs England"). When no team names resolve the market is not a
 * real capture match — test markets use synthetic ids offset from real ones, so nothing in the
 * fixtures data can or should ever name them. "Demo market" is the honest label; teams are
 * never invented.
 */
export function fixtureHeadline(
  market: MarketAccount,
  participants: FixtureParticipants | null | undefined,
): string {
  return participants
    ? `${participants.participant1} vs ${participants.participant2}`
    : `Demo market #${market.fixtureId.toString()}`;
}

/**
 * Copies this market's deep link (`/settlement?market=<address>`) so a bet can be
 * sent to a group chat — the friend lands on THIS market, not the featured set.
 * Exported: the open-a-market panel shows the same button the moment a market
 * is created, so "share it with your friends" is one affordance, not two copies.
 */
export function ShareBetButton({ address }: { address: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  useEffect(() => {
    if (state === "idle") return;
    const timer = setTimeout(() => setState("idle"), 2000);
    return () => clearTimeout(timer);
  }, [state]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(
        marketShareUrl(window.location.origin, address),
      );
      setState("copied");
    } catch {
      // Clipboard can be unavailable (insecure context, permissions) — say so,
      // don't pretend the link was copied.
      setState("failed");
    }
  }

  return (
    <Button variant="outline" size="sm" onClick={copy} className="self-start">
      {state === "copied" ? (
        <CircleCheck className="text-yes" />
      ) : (
        <Link2 />
      )}
      {state === "copied"
        ? "Link copied"
        : state === "failed"
          ? "Couldn't copy the link"
          : "Share this bet"}
    </Button>
  );
}

function StakeBar({ market }: { market: MarketAccount }) {
  const total = Number(market.potLamports) || 1;
  const yesPct = (Number(market.stakeYes) / total) * 100;
  const settled = market.state === "Settled";
  return (
    <div className="flex flex-col gap-2">
      <div className="flex h-2.5 overflow-hidden rounded-full bg-background/60">
        <div
          className={cn("bg-yes", settled && market.winner !== "Yes" && "opacity-40")}
          style={{ width: `${yesPct}%` }}
        />
        <div
          className={cn("bg-no", settled && market.winner !== "No" && "opacity-40")}
          style={{ width: `${100 - yesPct}%` }}
        />
      </div>
      <div className="flex items-center justify-between text-xs">
        <span className="flex items-center gap-1.5">
          <span className="size-2 rounded-full bg-yes" />
          <span className="text-muted-foreground">YES</span>
          <span className="tabular font-medium">
            {formatSol(market.stakeYes)} SOL
          </span>
        </span>
        <span className="flex items-center gap-1.5">
          <span className="tabular font-medium">
            {formatSol(market.stakeNo)} SOL
          </span>
          <span className="text-muted-foreground">NO</span>
          <span className="size-2 rounded-full bg-no" />
        </span>
      </div>
    </div>
  );
}

export function MarketSummary({
  market,
  participants,
  cluster = "devnet",
}: {
  market: MarketAccount;
  participants?: FixtureParticipants | null;
  cluster?: ExplorerCluster;
}) {
  const settled = market.state === "Settled";
  const { human, technical } = describePredicate(market, participants);
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            {fixtureHeadline(market, participants)}
          </span>
          {/* Lead with the plain-language bet; keep the exact on-chain predicate as the
              technical subtitle so nothing is hidden. */}
          <span className="text-xl font-semibold tracking-tight">
            {human ?? technical}
          </span>
          {human && (
            <span className="font-mono text-xs text-muted-foreground">
              {technical} · match #{market.fixtureId.toString()}
            </span>
          )}
        </div>
        <div className="flex flex-col items-end gap-1.5">
          {settled ? (
            <Badge variant="yes">
              <CircleCheck className="size-3" />
              Settled
            </Badge>
          ) : (
            <Badge variant="accent">
              <CircleDot className="size-3" />
              Open
            </Badge>
          )}
          {settled && (
            <span className="text-xs text-muted-foreground">
              winner{" "}
              <span
                className={cn(
                  "font-semibold",
                  market.winner === "Yes" ? "text-yes" : "text-no",
                )}
              >
                {market.winner}
              </span>
            </span>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between">
          <span className="text-xs text-muted-foreground">Pot</span>
          <span className="tabular text-2xl font-semibold text-gold">
            {formatSol(market.potLamports)}{" "}
            <span className="text-base text-muted-foreground">SOL</span>
          </span>
        </div>
        <StakeBar market={market} />
      </div>

      <dl className="grid grid-cols-1 gap-x-6 gap-y-2.5 border-t border-border/60 pt-4 text-sm sm:grid-cols-2">
        <div className="flex items-center justify-between gap-2">
          <dt className="text-muted-foreground">Market</dt>
          <dd>
            <ExplorerLink value={market.address} cluster={cluster} />
          </dd>
        </div>
        <div className="flex items-center justify-between gap-2">
          <dt className="text-muted-foreground">Vault</dt>
          <dd>
            <ExplorerLink value={market.vault} cluster={cluster} />
          </dd>
        </div>
        <div className="flex items-center justify-between gap-2">
          <dt className="text-muted-foreground">Authority</dt>
          <dd>
            <ExplorerLink value={market.authority} cluster={cluster} />
          </dd>
        </div>
        <div className="flex items-center justify-between gap-2">
          <dt className="text-muted-foreground">Stat key</dt>
          <dd className="tabular font-mono text-xs">#{market.statKey}</dd>
        </div>
      </dl>

      <ShareBetButton address={market.address} />
    </div>
  );
}
