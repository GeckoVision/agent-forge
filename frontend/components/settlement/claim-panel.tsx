"use client";

import { useEffect, useMemo, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import {
  Ban,
  CircleCheck,
  CircleX,
  FlaskConical,
  HandCoins,
  Info,
  LoaderCircle,
  PartyPopper,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { ExplorerLink } from "@/components/shared/explorer-link";
import { useInstructionFlow } from "@/hooks/use-instruction-flow";
import { CLUSTER_LABEL } from "@/lib/solana/cluster";
import { DATA_MODE, getNetworkConfig, type ExplorerCluster } from "@/lib/solana/config";
import {
  buildClaimIx,
  decodePosition,
  type MarketAccount,
  type PositionAccount,
} from "@/lib/solana/forge-client";
import { fetchMarketTransactions } from "@/lib/solana/markets";
import { claimPayoutLamports, positionOutcome, winnerSideTotal } from "@/lib/solana/payout";
import { sideOutcome, type FixtureParticipants } from "@/lib/solana/predicate";
import {
  EXPECTED_CLUSTER,
  NetworkBanner,
} from "@/components/settlement/network-banner";
import { formatSol } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * The payout card for a SETTLED market: if the connected wallet holds a Position
 * here, show where it stands — won (claim it), already paid out, or lost — from
 * on-chain facts only. Renders nothing when there is nothing to say (no wallet,
 * no position, position unreadable): the bet panel owns the connect story.
 */
export function ClaimPanel({
  market,
  participants,
  cluster = "devnet",
}: {
  market: MarketAccount;
  participants?: FixtureParticipants | null;
  cluster?: ExplorerCluster;
}) {
  const { connection } = useConnection();
  const { publicKey } = useWallet();

  // The claim instruction, built client-side — also hands us the derived position PDA.
  const built = useMemo(() => {
    if (!publicKey) return null;
    return buildClaimIx({
      fixtureId: market.fixtureId,
      statKey: market.statKey,
      staker: publicKey,
    });
  }, [publicKey, market.fixtureId, market.statKey]);

  const { phase, message, logs, sig, simulate, send, canSend } = useInstructionFlow({
    simOk: "Simulation succeeded — the payout is ready to claim.",
    sent: (outcome) => `Payout claimed (${outcome}).`,
    timeout:
      "Couldn't confirm this claim within 30s. It may not have been broadcast — " +
      "check the signature on the explorer, and that your wallet is on " +
      `${CLUSTER_LABEL[EXPECTED_CLUSTER]}. Nothing has been recorded as claimed.`,
  });

  // One cheap read of the DERIVED position PDA — keyed by the PDA so a stale
  // result for a previous wallet/market never renders as the current one. For an
  // already-claimed position, look up its own tx history (a position PDA is only
  // ever touched by this wallet's stake + claim) for the explorer link.
  const positionKey = built?.position.toBase58() ?? null;
  const [posState, setPosState] = useState<{
    key: string;
    position: PositionAccount | null;
    claimSig: string | null;
  } | null>(null);
  useEffect(() => {
    if (!built || !positionKey) return;
    let alive = true;
    (async () => {
      const info = await connection.getAccountInfo(built.position);
      let position: PositionAccount | null = null;
      if (info) {
        try {
          position = decodePosition(positionKey, info.data);
        } catch {
          position = null; // not position-shaped — treat as no position
        }
      }
      let claimSig: string | null = null;
      if (position?.claimed) {
        const txs = await fetchMarketTransactions(
          positionKey,
          getNetworkConfig(DATA_MODE),
          10,
        );
        claimSig = txs.find((t) => t.kind === "claim" && !t.err)?.signature ?? null;
      }
      if (alive) setPosState({ key: positionKey, position, claimSig });
    })().catch(() => {
      // RPC refused — leave the card unrendered rather than guessing.
    });
    return () => {
      alive = false;
    };
    // Re-check only when the derived position address changes (wallet/market).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [positionKey]);

  const current = posState && posState.key === positionKey ? posState : null;
  const position = current?.position ?? null;

  // A confirmed claim this session is an on-chain fact too — flip without refetch.
  const claimedNow = phase === "sent";

  if (market.state !== "Settled" || !publicKey || !built || !position) return null;

  const outcome = positionOutcome(market, position);
  const backed = sideOutcome(market, participants, position.side);
  const stakeSol = formatSol(position.amount);

  // ── lost — say it straight, in the bet's own words ─────────────────────────────
  if (outcome === "lost") {
    return (
      <Card className="mt-5 border-no/30">
        <CardContent className="flex items-start gap-3">
          <CircleX className="mt-0.5 size-4 shrink-0 text-no" />
          <div className="flex flex-col gap-1 text-sm">
            <span className="font-semibold">This one didn&rsquo;t go your way.</span>
            <span className="text-muted-foreground">
              You backed{" "}
              <span className="text-foreground">
                &laquo;{backed ?? `${position.side.toUpperCase()}`}&raquo;
              </span>{" "}
              with <span className="tabular font-medium">{stakeSol} SOL</span> — it
              didn&rsquo;t hold. The pot went to the{" "}
              <span className={market.winner === "Yes" ? "text-yes" : "text-no"}>
                {market.winner.toUpperCase()}
              </span>{" "}
              side.
            </span>
          </div>
        </CardContent>
      </Card>
    );
  }

  const payout = claimPayoutLamports(market, position);
  if (payout === null) return null; // NoWinningStake edge — the program would refuse anyway

  const profit = payout - position.amount;
  const nobodyAgainst = winnerSideTotal(market) === market.potLamports;
  const claimed = position.claimed || claimedNow;

  // ── already paid out ───────────────────────────────────────────────────────────
  if (claimed) {
    const paidSig = sig ?? current?.claimSig ?? null;
    return (
      <Card className="mt-5 border-primary/30">
        <CardContent className="flex items-start gap-3">
          <CircleCheck className="mt-0.5 size-4 shrink-0 text-primary" />
          <div className="flex flex-col gap-1.5 text-sm">
            <span className="font-semibold">
              Paid out — {formatSol(payout)} SOL is in your wallet.
            </span>
            <span className="text-muted-foreground">
              You backed <span className="text-foreground">&laquo;{backed ?? position.side.toUpperCase()}&raquo;</span>{" "}
              with <span className="tabular font-medium">{stakeSol} SOL</span> and it held.
            </span>
            {paidSig && (
              <ExplorerLink value={paidSig} kind="tx" cluster={cluster} short={false} />
            )}
          </div>
        </CardContent>
      </Card>
    );
  }

  // ── won, unclaimed — the payout math, then the same simulate → send gates ──────
  return (
    <Card className="mt-5 border-yes/30">
      <CardContent className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <PartyPopper className="size-4 text-yes" />
            <h3 className="text-sm font-semibold">You won this market</h3>
          </div>
          <Badge variant="secondary" className="font-mono">
            claim
          </Badge>
        </div>

        <p className="text-sm text-muted-foreground">
          You backed{" "}
          <span className="font-semibold text-foreground">
            &laquo;{backed ?? position.side.toUpperCase()}&raquo;
          </span>{" "}
          with <span className="tabular font-medium text-foreground">{stakeSol} SOL</span>{" "}
          — and it held.
        </p>

        <NetworkBanner subject="claim" />

        {/* the exact numbers the program will use — shown BEFORE signing */}
        <div className="flex flex-col gap-1.5 rounded-lg border border-border/70 bg-background/40 p-3 text-xs">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Your stake</span>
            <span className="tabular font-medium">{stakeSol} SOL</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Winning side total</span>
            <span className="tabular font-medium">
              {formatSol(winnerSideTotal(market))} SOL
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Pot</span>
            <span className="tabular font-medium">{formatSol(market.potLamports)} SOL</span>
          </div>
          <div className="mt-1 flex items-center justify-between border-t border-border/60 pt-2 text-sm">
            <span className="text-muted-foreground">Your payout</span>
            <span className="tabular font-semibold text-gold">
              {formatSol(payout)} SOL
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Profit</span>
            <span
              className={cn(
                "tabular font-medium",
                profit > 0n ? "text-yes" : "text-muted-foreground",
              )}
            >
              {profit > 0n ? "+" : ""}
              {formatSol(profit)} SOL
            </span>
          </div>
        </div>

        {/* the honest zero-profit case: an uncontested pot refunds, it doesn't win */}
        {nobodyAgainst && (
          <p className="flex items-start gap-2 rounded-lg bg-secondary/40 p-2.5 text-xs leading-relaxed text-muted-foreground">
            <Info className="mt-0.5 size-3.5 shrink-0" />
            <span>
              <span className="text-foreground">Nobody bet against you</span> — the
              whole pot is the winning side&rsquo;s own stakes, so you get your stake
              back. Profit 0.000.
            </span>
          </p>
        )}

        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            onClick={() => simulate(built.instruction)}
            disabled={phase === "simulating" || phase === "sending"}
            className="flex-1"
          >
            {phase === "simulating" ? (
              <LoaderCircle className="animate-spin" />
            ) : (
              <FlaskConical />
            )}
            Simulate
          </Button>
          <span className={cn("flex-1", !canSend && "cursor-not-allowed")}>
            <Button
              onClick={() => send(built.instruction)}
              disabled={!canSend}
              aria-disabled={!canSend}
              className={cn("w-full", !canSend && "opacity-40 saturate-50")}
            >
              {phase === "sending" ? (
                <LoaderCircle className="animate-spin" />
              ) : (
                <HandCoins />
              )}
              Claim your payout
            </Button>
          </span>
        </div>
        {!canSend && phase !== "sending" && (
          <p className="-mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
            <Info className="size-3.5 shrink-0" />
            Run <span className="font-medium text-foreground">Simulate</span> first — it
            checks the claim against the program before you can sign.
          </p>
        )}

        {/* a confirmed claim ("sent") re-renders as the paid-out card above, so
            only the simulate/failure states ever reach this block */}
        {message && (
          <div
            className={cn(
              "flex flex-col gap-2 rounded-lg border p-3 text-sm",
              phase === "sim-ok"
                ? "border-primary/30 bg-primary/5"
                : phase === "sim-err" || phase === "send-err"
                  ? "border-destructive/30 bg-destructive/5"
                  : "border-border/70 bg-card",
            )}
          >
            <span className="flex items-center gap-2 font-medium">
              {phase === "sim-ok" ? (
                <CircleCheck className="size-4 text-primary" />
              ) : (
                <Ban className="size-4 text-destructive" />
              )}
              {message}
            </span>
            {sig && (
              <ExplorerLink value={sig} kind="tx" cluster={cluster} short={false} />
            )}
            {logs && logs.length > 0 && (
              <pre className="max-h-32 overflow-auto rounded bg-background/60 p-2 font-mono text-[10px] leading-relaxed text-muted-foreground">
                {logs.join("\n")}
              </pre>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
