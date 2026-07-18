"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowRight,
  Check,
  Cpu,
  ExternalLink,
  LoaderCircle,
  Play,
  RotateCcw,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { OddsFeed } from "@/components/agent/odds-feed";
import { PolicyPanel } from "@/components/agent/policy-panel";
import { predicateLabel } from "@/components/settlement/market-summary";
import { useAgentBets, type AgentBet } from "@/hooks/use-agent-bet";
import { useReplay } from "@/hooks/use-replay";
import { POLICY } from "@/lib/agent/policy";
import {
  type ReplaySlice,
  formatCaptureTime,
  lineLabel,
  moveIndex,
} from "@/lib/agent/replay";
import { lamportsToSol } from "@/lib/solana/forge-client";
import { DATA_MODE, explorerAddress, explorerTx, getNetworkConfig } from "@/lib/solana/config";
import { shortAddress } from "@/lib/format";
import { cn } from "@/lib/utils";

// phase: 0 idle · 1 reading the recorded book · 2 move flagged · 3 bet sized · 4 on-chain result
type Phase = 0 | 1 | 2 | 3 | 4;

const TICK_MS = 90;

function StepRow({
  index,
  title,
  detail,
  state,
}: {
  index: number;
  title: string;
  detail: string;
  state: "pending" | "active" | "done";
}) {
  return (
    <div className="flex gap-3">
      <span
        className={cn(
          "mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold transition-colors",
          state === "done" && "bg-primary text-primary-foreground",
          state === "active" && "bg-accent/20 text-accent ring-1 ring-accent/40",
          state === "pending" && "bg-secondary text-muted-foreground",
        )}
      >
        {state === "done" ? (
          <Check className="size-3.5" />
        ) : state === "active" ? (
          <LoaderCircle className="size-3.5 animate-spin" />
        ) : (
          index + 1
        )}
      </span>
      <div className="flex flex-col gap-0.5 pb-1">
        <span
          className={cn(
            "text-sm font-medium transition-colors",
            state === "pending" && "text-muted-foreground",
          )}
        >
          {title}
        </span>
        <span
          className={cn(
            "text-xs text-muted-foreground transition-opacity",
            state === "pending" && "opacity-0",
          )}
        >
          {detail}
        </span>
      </div>
    </div>
  );
}

function BetRow({ bet }: { bet: AgentBet }) {
  const config = getNetworkConfig(DATA_MODE);
  const { market, positions, stakeTx } = bet;

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border/60 bg-background/40 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-mono text-xs text-muted-foreground">
          {predicateLabel(market)}
        </span>
        <Badge variant={market.state === "Settled" ? "yes" : "secondary"}>
          {market.state}
        </Badge>
      </div>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <div className="flex flex-col">
          <span className="text-xs text-muted-foreground">Staked Yes</span>
          <span className="tabular text-base font-semibold text-yes">
            {lamportsToSol(market.stakeYes)} SOL
          </span>
        </div>
        <div className="flex flex-col">
          <span className="text-xs text-muted-foreground">Staked No</span>
          <span className="tabular text-base font-semibold">
            {lamportsToSol(market.stakeNo)} SOL
          </span>
        </div>
        <div className="flex flex-col">
          <span className="text-xs text-muted-foreground">Positions</span>
          <span className="tabular text-sm font-medium">
            {positions === null ? "—" : positions.length}
          </span>
        </div>
        <div className="flex flex-col">
          <span className="text-xs text-muted-foreground">Market</span>
          <a
            href={explorerAddress(market.address, config.explorerCluster)}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 font-mono text-sm text-primary hover:underline"
          >
            {shortAddress(market.address)}
            <ExternalLink className="size-3" />
          </a>
        </div>
        <div className="flex flex-col">
          <span className="text-xs text-muted-foreground">Stake tx</span>
          {stakeTx ? (
            <a
              href={explorerTx(stakeTx.signature, config.explorerCluster)}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 font-mono text-sm text-primary hover:underline"
            >
              {shortAddress(stakeTx.signature)}
              <ExternalLink className="size-3" />
            </a>
          ) : (
            <span className="text-sm text-muted-foreground">not read</span>
          )}
        </div>
      </div>
    </div>
  );
}

/** The on-chain outcome — read live, or an honest note about why it isn't showing. */
function OnChainResult({ fixtureId }: { fixtureId: number }) {
  const { bets, loading, unavailable } = useAgentBets(fixtureId);

  if (loading) {
    return (
      <div className="flex flex-col gap-2 rounded-xl border border-border/70 p-4">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
  }

  if (unavailable || bets.length === 0) {
    return (
      <div className="rounded-xl border border-border/70 bg-background/40 p-4">
        <p className="text-sm text-muted-foreground">
          No on-chain market for fixture {fixtureId} could be read from
          devnet right now — the public RPC may be rate-limiting the program
          scan. Nothing is shown rather than a stale or invented figure.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-primary/25 bg-primary/5 p-4">
      <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
        On-chain stakes · Solana devnet · match #{fixtureId}
      </span>
      {bets.map((bet) => (
        <BetRow key={bet.market.address} bet={bet} />
      ))}
      <p className="text-[11px] text-muted-foreground/70">
        Every market this program holds for the match, read live — one per
        stat. Amounts, state and signatures come from the accounts themselves.
      </p>
      <Button asChild variant="outline" size="sm" className="w-fit">
        <Link href="/settlement">
          Follow these markets to settlement
          <ArrowRight />
        </Link>
      </Button>
    </div>
  );
}

/**
 * The recorded replay, once its odds have been read from MongoDB.
 *
 * Split out from {@link AgentDashboard} so the run/reveal timers are only ever created against
 * a real series — a shell that ticks through an empty array would render a chart of nothing.
 */
function ReplayDashboard({ slice }: { slice: ReplaySlice }) {
  const [phase, setPhase] = useState<Phase>(0);
  const [revealed, setRevealed] = useState(0);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  const { series, line, detector, fixture } = slice;
  const move = slice.moves[0];
  const flaggedAt = moveIndex(slice);

  const steps = [
    {
      title: "Replay the real book",
      detail: `${series.length} real readings of ${lineLabel(slice)} · ${line.outcome} · ${line.bookmaker}, from ${line.readingsOnLine} captured on this line.`,
      reachedAt: 1 as const,
    },
    {
      title: "Detect a sharp move",
      detail: move
        ? `${move.old_pct.toFixed(3)}% → ${move.new_pct.toFixed(3)}% (${move.delta_pct > 0 ? "+" : ""}${move.delta_pct.toFixed(3)} pp) at ${formatCaptureTime(move.ts)} — over the ${detector.thresholdPct} pp threshold. ${detector.movesFlagged} moves in ${detector.readingsObserved} readings.`
        : "No move crossed the threshold in this capture.",
      reachedAt: 2 as const,
    },
    {
      title: "Size the bet",
      detail: `${POLICY.stakePerBetSol} SOL — the risk policy's per-bet stake, inside the ${POLICY.maxPerFixtureSol} SOL per-match cap.`,
      reachedAt: 3 as const,
    },
    {
      title: "Sign within custody policy",
      detail: `stake@forge_markets is on the allow-list and under the ${POLICY.maxSpendSol} SOL cap — the result below is read live from devnet.`,
      reachedAt: 4 as const,
    },
  ];

  const clearTimers = () => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
  };

  const run = useCallback(() => {
    clearTimers();
    setPhase(1);
    setRevealed(0);
    const schedule = (fn: () => void, ms: number) =>
      timers.current.push(setTimeout(fn, ms));

    series.forEach((_, i) => schedule(() => setRevealed(i + 1), TICK_MS * (i + 1)));
    const afterTicks = TICK_MS * series.length;

    if (flaggedAt >= 0) {
      schedule(() => setPhase(2), TICK_MS * (flaggedAt + 1) + 200);
    }
    schedule(() => setPhase(3), afterTicks + 400);
    schedule(() => setPhase(4), afterTicks + 900);
  }, [series, flaggedAt]);

  useEffect(() => {
    const t = setTimeout(run, 400);
    return () => {
      clearTimeout(t);
      clearTimers();
    };
  }, [run]);

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card className="lg:col-span-2">
        <CardContent className="flex flex-col gap-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <span className="flex size-9 items-center justify-center rounded-lg bg-accent/15 text-accent ring-1 ring-accent/25">
                <Cpu className="size-4.5" />
              </span>
              <div>
                <h2 className="text-sm font-semibold">
                  Sharp-move betting agent
                </h2>
                <p className="text-xs text-muted-foreground">
                  {fixture.competition} · {fixture.participant1} v{" "}
                  {fixture.participant2} · match #{fixture.id}
                </p>
              </div>
            </div>
            <Button
              size="sm"
              variant={phase === 4 ? "outline" : "default"}
              onClick={run}
            >
              {phase === 0 || phase === 4 ? (
                <>
                  {phase === 4 ? <RotateCcw /> : <Play />}
                  {phase === 4 ? "Replay" : "Run agent"}
                </>
              ) : (
                <>
                  <LoaderCircle className="animate-spin" />
                  Replaying
                </>
              )}
            </Button>
          </div>

          <OddsFeed revealed={revealed} slice={slice} />

          <Separator />

          <div className="flex flex-col gap-3">
            {steps.map((step, i) => {
              const state =
                phase >= step.reachedAt
                  ? "done"
                  : phase === step.reachedAt - 1 && phase > 0
                    ? "active"
                    : "pending";
              return (
                <StepRow
                  key={step.title}
                  index={i}
                  title={step.title}
                  detail={step.detail}
                  state={state}
                />
              );
            })}
          </div>

          {phase >= 4 && <OnChainResult fixtureId={fixture.id} />}
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          <PolicyPanel />
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * Reads the recorded replay from MongoDB via `/api/data/replay`, then renders it.
 *
 * If the capture cannot be read, this says so and stops. There is no fallback series: on an
 * odds chart a placeholder is indistinguishable from a real price, so showing nothing is the
 * only honest failure.
 */
export function AgentDashboard() {
  const { slice, loading, error } = useReplay();

  if (loading) {
    return (
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardContent className="flex flex-col gap-4">
            <Skeleton className="h-9 w-64" />
            <Skeleton className="h-32 w-full" />
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-4 w-3/4" />
          </CardContent>
        </Card>
        <Card>
          <CardContent>
            <PolicyPanel />
          </CardContent>
        </Card>
      </div>
    );
  }

  if (error || !slice) {
    return (
      <Card>
        <CardContent className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold">The recorded capture could not be read</h2>
          <p className="text-sm text-muted-foreground">
            {error ?? "The capture database returned nothing for this match."}
          </p>
          <p className="text-xs text-muted-foreground/70">
            The odds on this page are read from the captured TxLINE records at request time.
            When that read fails, nothing is shown — never a placeholder or a stale series,
            which on a price chart would be indistinguishable from real data.
          </p>
        </CardContent>
      </Card>
    );
  }

  return <ReplayDashboard slice={slice} />;
}
