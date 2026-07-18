"use client";

import { useEffect, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { CircleAlert, HandCoins } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ConnectButton } from "@/components/wallet/connect-button";
import { fixtureHeadline } from "@/components/settlement/market-summary";
import { useFixtureParticipants } from "@/hooks/use-fixture-participants";
import { DATA_MODE } from "@/lib/solana/config";
import type { MarketAccount, PositionAccount } from "@/lib/solana/forge-client";
import { fetchWalletPositions } from "@/lib/solana/markets";
import { buildPnl, type PnlOutcome, type PnlRow } from "@/lib/solana/payout";
import { predicateHeadline } from "@/lib/solana/predicate";
import { formatSol, shortAddress } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * The connected wallet's profits vs losses: every Position it holds under the
 * program, joined with each market's settled state. On-chain facts only — an
 * open bet is "open" (never an estimated number), and a failed program scan says
 * so instead of rendering an empty table as "no bets".
 */

/** ± formatting for the net column — the sign is the point of the table. */
function signedSol(net: bigint): string {
  if (net === 0n) return "0";
  const abs = net < 0n ? -net : net;
  return `${net > 0n ? "+" : "−"}${formatSol(abs)}`;
}

function netClass(net: bigint | null): string {
  if (net === null) return "text-muted-foreground";
  if (net > 0n) return "text-yes";
  if (net < 0n) return "text-no";
  return "text-muted-foreground";
}

const OUTCOME_BADGE: Record<PnlOutcome, { label: string; variant: "yes" | "no" | "accent" | "secondary" }> = {
  won: { label: "Won", variant: "yes" },
  lost: { label: "Lost", variant: "no" },
  open: { label: "Open", variant: "accent" },
  unknown: { label: "Unknown", variant: "secondary" },
};

function payoutCell(row: PnlRow): string {
  if (row.payoutLamports === null) return "—";
  if (row.outcome === "won") {
    return `${formatSol(row.payoutLamports)} ${row.position.claimed ? "(claimed)" : "(claimable)"}`;
  }
  return formatSol(row.payoutLamports);
}

export function WalletPnl({
  markets,
  marketsLoading,
}: {
  markets: MarketAccount[] | null;
  marketsLoading: boolean;
}) {
  const { publicKey } = useWallet();
  const { lookup: participantsFor } = useFixtureParticipants();
  const owner = publicKey?.toBase58() ?? null;

  // Keyed by owner so a stale scan for a previous wallet never renders as this one.
  // `positions: null` = the scan itself failed (rate-limited) — a distinct state.
  const [scan, setScan] = useState<{
    owner: string;
    positions: PositionAccount[] | null;
  } | null>(null);
  useEffect(() => {
    if (!owner) return;
    let alive = true;
    fetchWalletPositions(owner, DATA_MODE).then(
      (positions) => alive && setScan({ owner, positions }),
    );
    return () => {
      alive = false;
    };
  }, [owner]);

  const header = (
    <div className="flex items-baseline justify-between">
      <h2 className="flex items-center gap-2 text-sm font-semibold tracking-wide text-muted-foreground uppercase">
        <HandCoins className="size-4" />
        Your bets
      </h2>
      {owner && (
        <span className="font-mono text-xs text-muted-foreground">
          {shortAddress(owner)}
        </span>
      )}
    </div>
  );

  if (!owner) {
    return (
      <div className="flex flex-col gap-3">
        {header}
        <Card>
          <CardContent className="flex flex-col items-start gap-3">
            <p className="text-sm text-muted-foreground">
              Connect a wallet to see its bets across every market of the program —
              stake, outcome and net P&amp;L, read straight from on-chain positions.
            </p>
            <ConnectButton />
          </CardContent>
        </Card>
      </div>
    );
  }

  const loading = marketsLoading || scan === null || scan.owner !== owner;
  if (loading) {
    return (
      <div className="flex flex-col gap-3">
        {header}
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  // Degrade honestly: a refused scan is NOT "no bets yet".
  if (scan.positions === null) {
    return (
      <div className="flex flex-col gap-3">
        {header}
        <Card>
          <CardContent className="flex items-start gap-2 text-sm text-muted-foreground">
            <CircleAlert className="mt-0.5 size-4 shrink-0" />
            <span>
              Couldn&rsquo;t scan your positions — the RPC is rate-limiting the program
              scan right now. Nothing is shown rather than an incomplete list; try again
              in a moment.
            </span>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (scan.positions.length === 0) {
    return (
      <div className="flex flex-col gap-3">
        {header}
        <Card>
          <CardContent className="text-sm text-muted-foreground">
            No bets yet — this wallet holds no position under the program.
          </CardContent>
        </Card>
      </div>
    );
  }

  const { rows, totals } = buildPnl(scan.positions, markets ?? []);

  return (
    <div className="flex flex-col gap-3">
      {header}
      <Card>
        <CardContent className="overflow-x-auto">
          <table className="w-full min-w-[36rem] text-sm">
            <thead>
              <tr className="border-b border-border/60 text-left text-xs text-muted-foreground">
                <th className="pb-2 pr-3 font-medium">Market</th>
                <th className="pb-2 pr-3 font-medium">Side</th>
                <th className="pb-2 pr-3 text-right font-medium">Stake (SOL)</th>
                <th className="pb-2 pr-3 font-medium">Outcome</th>
                <th className="pb-2 pr-3 text-right font-medium">Payout (SOL)</th>
                <th className="pb-2 text-right font-medium">Net (SOL)</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const badge = OUTCOME_BADGE[row.outcome];
                const parts = row.market ? participantsFor(row.market.fixtureId) : null;
                return (
                  <tr key={row.position.address} className="border-b border-border/40">
                    <td className="py-2.5 pr-3">
                      {row.market ? (
                        <span className="flex flex-col">
                          <span className="font-medium">
                            {predicateHeadline(row.market, parts)}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            {fixtureHeadline(row.market, parts)}
                          </span>
                        </span>
                      ) : (
                        <span className="flex flex-col">
                          <span className="font-mono text-xs">
                            {shortAddress(row.position.market)}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            market unreadable right now
                          </span>
                        </span>
                      )}
                    </td>
                    <td className="py-2.5 pr-3">
                      <span
                        className={cn(
                          "font-semibold",
                          row.position.side === "Yes" ? "text-yes" : "text-no",
                        )}
                      >
                        {row.position.side.toUpperCase()}
                      </span>
                    </td>
                    <td className="tabular py-2.5 pr-3 text-right">
                      {formatSol(row.position.amount)}
                    </td>
                    <td className="py-2.5 pr-3">
                      <Badge variant={badge.variant}>{badge.label}</Badge>
                    </td>
                    <td className="tabular py-2.5 pr-3 text-right">{payoutCell(row)}</td>
                    <td className={cn("tabular py-2.5 text-right", netClass(row.netLamports))}>
                      {row.netLamports === null ? "—" : signedSol(row.netLamports)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="text-sm font-medium">
                <td className="pt-3 pr-3" colSpan={2}>
                  Totals
                </td>
                <td className="tabular pt-3 pr-3 text-right">
                  {formatSol(totals.stakedLamports)}
                </td>
                <td className="pt-3 pr-3 text-xs text-muted-foreground">
                  {totals.openStakedLamports > 0n
                    ? `${formatSol(totals.openStakedLamports)} still open`
                    : "all settled"}
                </td>
                <td className="tabular pt-3 pr-3 text-right">
                  {formatSol(totals.returnedLamports)}
                </td>
                <td
                  className={cn(
                    "tabular pt-3 text-right font-semibold",
                    netClass(totals.netLamports),
                  )}
                >
                  {signedSol(totals.netLamports)}
                </td>
              </tr>
            </tfoot>
          </table>
          <p className="mt-3 text-xs text-muted-foreground">
            Net P&amp;L counts settled markets only — open stakes are neither won nor
            lost yet. Every number is decoded from on-chain accounts; nothing is
            estimated.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
