"use client";

import type { ReactNode } from "react";
import { CircleCheck, CircleDot } from "lucide-react";

import { cn } from "@/lib/utils";
import { ExplorerLink } from "@/components/shared/explorer-link";
import { Skeleton } from "@/components/ui/skeleton";
import { useMarkets } from "@/hooks/use-markets";
import { formatSol } from "@/lib/format";
import { COMPARISON_SYMBOL, type MarketAccount } from "@/lib/solana/forge-client";

/**
 * The poster's cut-out subject: a poster-native STAT CALLOUT rendered from the
 * SAME real on-chain data the rest of the page uses ({@link useMarkets}) — real
 * fixture id, settled state, pot, YES/NO split, market·vault·authority. No
 * fabricated data.
 *
 * This deliberately does NOT reuse the shared `MarketSummary` presentation: the
 * app's data panels keep their clean identity, while THIS instance wears the
 * poster identity — square edges, a big display pot figure, mono uppercase gold
 * labels, purple YES / red NO / gold pot, on a deep high-contrast panel with a
 * luminous purple/gold edge so it pops off the dark-purple hero (never blends).
 */

function predicateLabel(m: MarketAccount): string {
  return `stat #${m.statKey} ${COMPARISON_SYMBOL[m.predicate.comparison]} ${m.predicate.threshold}`;
}

function MetaRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <dt className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/75">
        {label}
      </dt>
      <dd>{children}</dd>
    </div>
  );
}

function StatCallout({ market }: { market: MarketAccount }) {
  const settled = market.state === "Settled";
  const winnerYes = market.winner === "Yes";
  const total = Number(market.potLamports) || 1;
  const yesPct = (Number(market.stakeYes) / total) * 100;

  return (
    <div className="flex flex-col gap-5">
      {/* header — fixture + poster status badge */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <span className="eyebrow text-gold">
            Match #{market.fixtureId.toString()}
          </span>
          <span className="font-mono text-base font-semibold tracking-tight text-foreground">
            {predicateLabel(market)}
          </span>
        </div>
        <span
          className={cn(
            "inline-flex shrink-0 items-center gap-1.5 rounded-none border px-2.5 py-1 font-mono text-[11px] font-semibold uppercase tracking-wider",
            settled
              ? "border-primary/55 bg-primary/15 text-primary"
              : "border-gold/55 bg-gold/15 text-gold",
          )}
        >
          {settled ? (
            <CircleCheck className="size-3" />
          ) : (
            <CircleDot className="size-3" />
          )}
          {settled ? "Settled" : "Open"}
        </span>
      </div>

      {/* pot — the big stat */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className="eyebrow text-gold">Pot</span>
          {settled && (
            <span className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
              Winner{" "}
              <span
                className={cn(
                  "font-semibold",
                  winnerYes ? "text-yes" : "text-no",
                )}
              >
                {market.winner}
              </span>
            </span>
          )}
        </div>
        <div className="flex items-baseline gap-2">
          <span className="tabular font-display text-5xl leading-none tracking-tight text-gold">
            {formatSol(market.potLamports)}
          </span>
          <span className="font-mono text-sm text-muted-foreground">SOL</span>
        </div>
      </div>

      {/* YES (purple) / NO (red) split */}
      <div className="flex flex-col gap-2">
        <div className="flex h-2.5 overflow-hidden rounded-none bg-black/40">
          <div
            className={cn("bg-yes", settled && !winnerYes && "opacity-35")}
            style={{ width: `${yesPct}%` }}
          />
          <div
            className={cn("bg-no", settled && winnerYes && "opacity-35")}
            style={{ width: `${100 - yesPct}%` }}
          />
        </div>
        <div className="flex items-center justify-between font-mono text-xs">
          <span className="flex items-center gap-1.5">
            <span className="size-2 rounded-none bg-yes" />
            <span className="text-muted-foreground">YES</span>
            <span className="tabular font-semibold text-foreground">
              {formatSol(market.stakeYes)}
            </span>
          </span>
          <span className="flex items-center gap-1.5">
            <span className="tabular font-semibold text-foreground">
              {formatSol(market.stakeNo)}
            </span>
            <span className="text-muted-foreground">NO</span>
            <span className="size-2 rounded-none bg-no" />
          </span>
        </div>
      </div>

      {/* on-chain identities — real explorer links */}
      <dl className="flex flex-col gap-2 border-t border-primary/15 pt-4">
        <MetaRow label="Market">
          <ExplorerLink value={market.address} cluster="devnet" />
        </MetaRow>
        <MetaRow label="Vault">
          <ExplorerLink value={market.vault} cluster="devnet" />
        </MetaRow>
        <MetaRow label="Authority">
          <ExplorerLink value={market.authority} cluster="devnet" />
        </MetaRow>
      </dl>
    </div>
  );
}

export function HeroMarketCard({ className }: { className?: string }) {
  const { markets, loading } = useMarkets();
  // Prefer a settled market — full arc (verdict + pot), the strongest read.
  const featured =
    (markets ?? []).find((m) => m.state === "Settled") ??
    (markets ?? [])[0] ??
    null;

  return (
    <div className={cn("relative w-full max-w-sm", className)}>
      {/* backlight — purple + gold halo bleeding around the panel edge */}
      <div
        aria-hidden
        className="pointer-events-none absolute -inset-6 -z-10 blur-3xl"
        style={{
          background:
            "radial-gradient(58% 58% at 40% 28%, color-mix(in oklch, var(--primary) 55%, transparent), transparent 72%), radial-gradient(52% 52% at 78% 98%, color-mix(in oklch, var(--gold) 36%, transparent), transparent 70%)",
        }}
      />
      {/* deep panel — darker than the hero base, luminous purple/gold edge */}
      <div
        className="relative rounded-none border border-primary/50 shadow-2xl ring-1 ring-primary/20"
        style={{
          background:
            "linear-gradient(180deg, hsl(258 38% 12%) 0%, hsl(258 47% 7%) 100%)",
        }}
      >
        {/* broadcast-graphic accent stripe */}
        <div
          aria-hidden
          className="h-1 w-full"
          style={{
            background:
              "linear-gradient(90deg, var(--primary) 0%, color-mix(in oklch, var(--primary) 45%, var(--gold)) 60%, var(--gold) 100%)",
          }}
        />
        <div className="p-5 sm:p-6">
          {featured ? (
            <StatCallout market={featured} />
          ) : loading ? (
            <div className="flex flex-col gap-4">
              <Skeleton className="h-8 w-44" />
              <Skeleton className="h-12 w-32" />
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              Live markets load from the devnet RPC.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
