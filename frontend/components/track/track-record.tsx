"use client";

import { CircleCheck, CircleDot, Percent, Trophy, Wallet } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ExplorerLink } from "@/components/shared/explorer-link";
import { predicateLabel } from "@/components/settlement/market-summary";
import { useMarkets } from "@/hooks/use-markets";
import { DATA_MODE, getNetworkConfig } from "@/lib/solana/config";
import type { MarketAccount } from "@/lib/solana/forge-client";
import { formatSol } from "@/lib/format";
import { cn } from "@/lib/utils";

function StatCard({
  icon: Icon,
  label,
  value,
  tone = "default",
  loading,
}: {
  icon: typeof Trophy;
  label: string;
  value: string;
  tone?: "default" | "primary" | "gold" | "accent";
  loading: boolean;
}) {
  return (
    <Card>
      <CardContent className="flex items-center gap-3">
        <span
          className={cn(
            "flex size-10 items-center justify-center rounded-lg ring-1",
            tone === "primary" && "bg-primary/10 text-primary ring-primary/25",
            tone === "gold" && "bg-gold/10 text-gold ring-gold/25",
            tone === "accent" && "bg-accent/10 text-accent ring-accent/25",
            tone === "default" && "bg-secondary text-muted-foreground ring-border",
          )}
        >
          <Icon className="size-5" />
        </span>
        <div className="flex flex-col">
          {loading ? (
            <Skeleton className="h-7 w-12" />
          ) : (
            <span className="tabular text-2xl font-semibold tracking-tight">
              {value}
            </span>
          )}
          <span className="text-xs text-muted-foreground">{label}</span>
        </div>
      </CardContent>
    </Card>
  );
}

function MarketRow({ market }: { market: MarketAccount }) {
  const cluster = getNetworkConfig(DATA_MODE).explorerCluster;
  const settled = market.state === "Settled";
  const total = Number(market.potLamports) || 1;
  const yesPct = (Number(market.stakeYes) / total) * 100;

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border/70 bg-card p-4 sm:flex-row sm:items-center sm:gap-5">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold">
            Match #{market.fixtureId.toString()}
          </span>
          <span className="font-mono text-xs text-muted-foreground">
            {predicateLabel(market)}
          </span>
        </div>
        <ExplorerLink value={market.address} cluster={cluster} />
      </div>

      <div className="flex w-full max-w-[10rem] flex-col gap-1">
        <div className="flex h-1.5 overflow-hidden rounded-full bg-background/60">
          <div className="bg-yes" style={{ width: `${yesPct}%` }} />
          <div className="bg-no" style={{ width: `${100 - yesPct}%` }} />
        </div>
        <span className="tabular text-xs text-muted-foreground">
          {formatSol(market.potLamports)} SOL pot
        </span>
      </div>

      <div className="shrink-0">
        {settled ? (
          <Badge variant={market.winner === "Yes" ? "yes" : "no"}>
            <CircleCheck className="size-3" />
            {market.winner} won
          </Badge>
        ) : (
          <Badge variant="accent">
            <CircleDot className="size-3" />
            Open
          </Badge>
        )}
      </div>
    </div>
  );
}

export function TrackRecord() {
  const { markets, loading, error } = useMarkets();

  const settled = (markets ?? []).filter((m) => m.state === "Settled");
  const wins = settled.filter((m) => m.winner === "Yes");
  const totalPot = (markets ?? []).reduce((a, m) => a + m.potLamports, 0n);
  const hitRate =
    settled.length > 0 ? Math.round((wins.length / settled.length) * 100) : 0;

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard
          icon={Trophy}
          label="Markets on-chain"
          value={String(markets?.length ?? 0)}
          loading={loading}
        />
        <StatCard
          icon={CircleCheck}
          label="Settled by proof"
          value={String(settled.length)}
          tone="primary"
          loading={loading}
        />
        <StatCard
          icon={Percent}
          label="YES hit-rate"
          value={`${hitRate}%`}
          tone="accent"
          loading={loading}
        />
        <StatCard
          icon={Wallet}
          label="Total pot (SOL)"
          value={formatSol(totalPot)}
          tone="gold"
          loading={loading}
        />
      </div>

      <div className="flex flex-col gap-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-semibold tracking-wide text-muted-foreground uppercase">
            Markets
          </h2>
          <span className="text-xs text-muted-foreground">
            decoded from on-chain program accounts
          </span>
        </div>

        {loading ? (
          <div className="flex flex-col gap-3">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-20 w-full" />
            ))}
          </div>
        ) : error ? (
          <p className="text-sm text-destructive">Failed to read markets: {error}</p>
        ) : (markets?.length ?? 0) === 0 ? (
          <p className="text-sm text-muted-foreground">
            No markets found under the program on the current RPC.
          </p>
        ) : (
          <div className="flex flex-col gap-2.5">
            {markets!.map((m) => (
              <MarketRow key={m.address} market={m} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
