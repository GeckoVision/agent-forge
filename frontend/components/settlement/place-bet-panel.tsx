"use client";

import { useEffect, useMemo, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import {
  Ban,
  CircleAlert,
  CircleCheck,
  FlaskConical,
  Info,
  LoaderCircle,
  Send,
  Ticket,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { ConnectButton } from "@/components/wallet/connect-button";
import { ExplorerLink } from "@/components/shared/explorer-link";
import { shortAddress } from "@/lib/format";
import { useInstructionFlow } from "@/hooks/use-instruction-flow";
import { CLUSTER_LABEL } from "@/lib/solana/cluster";
import type { ExplorerCluster } from "@/lib/solana/config";
import {
  buildStakeIx,
  DISCRIMINATORS,
  toLamports,
  type MarketAccount,
  type Side,
} from "@/lib/solana/forge-client";
import {
  describePredicate,
  type FixtureParticipants,
  sideOutcome,
} from "@/lib/solana/predicate";
import { fixtureHeadline } from "@/components/settlement/market-summary";
import {
  EXPECTED_CLUSTER,
  NetworkBanner,
} from "@/components/settlement/network-banner";
import { cn } from "@/lib/utils";

const AMOUNTS = [0.002, 0.005, 0.01];

export function discHex(name: keyof typeof DISCRIMINATORS): string {
  return DISCRIMINATORS[name].map((b) => b.toString(16).padStart(2, "0")).join(" ");
}

export function AccountRow({
  label,
  pubkey,
  flags,
}: {
  label: string;
  pubkey: string;
  flags: string;
}) {
  return (
    <div className="flex items-center justify-between gap-2 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className="flex items-center gap-2">
        <span className="tabular font-mono text-foreground">
          {shortAddress(pubkey, 4, 4)}
        </span>
        <span className="rounded bg-secondary px-1 py-0.5 font-mono text-[10px] text-muted-foreground">
          {flags}
        </span>
      </span>
    </div>
  );
}

export function PlaceBetPanel({
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

  const [side, setSide] = useState<Side>("Yes");
  const [amount, setAmount] = useState(0.005);
  // The shared simulate-then-send flow — same gates as every signing panel.
  const { phase, message, logs, sig, reset, simulate, send, canSend } =
    useInstructionFlow({
      simOk: "Simulation succeeded — the bet is valid and ready to sign.",
      sent: (outcome) => `Bet placed on-chain (${outcome}).`,
      timeout:
        "Couldn't confirm this bet within 30s. It may not have been broadcast — " +
        "check the signature on the explorer, and that your wallet is on " +
        `${CLUSTER_LABEL[EXPECTED_CLUSTER]}. Nothing has been recorded as placed.`,
    });
  // Whether this wallet already holds a position on this market. The program allows exactly
  // one stake per staker per market (`init`, not `init_if_needed`), so a second stake can
  // never succeed — telling the user up front beats a cryptic failure. Keyed by the position
  // PDA so a stale result for a previous market is never read as the current one.
  const [posState, setPosState] = useState<{ key: string; exists: boolean } | null>(
    null,
  );

  // Build the exact `stake` instruction client-side — the same wire format the
  // deployed program expects (mirrors backend/gorilla/forge_client.py).
  const built = useMemo(() => {
    if (!publicKey || amount <= 0) return null;
    try {
      return buildStakeIx({
        fixtureId: market.fixtureId,
        statKey: market.statKey,
        staker: publicKey,
        side,
        amountLamports: toLamports(amount),
      });
    } catch {
      return null;
    }
  }, [publicKey, amount, market.fixtureId, market.statKey, side]);

  // A single cheap read of the DERIVED position PDA (no scan, no waterfall) — if the account
  // already exists this wallet has already staked here. Non-blocking: render never waits on it,
  // and any RPC hiccup leaves `hasPosition` null so we fall back to the static rule.
  const positionKey = built?.position.toBase58() ?? null;
  useEffect(() => {
    if (!built || !positionKey) return;
    let alive = true;
    connection
      .getAccountInfo(built.position)
      .then((info) => alive && setPosState({ key: positionKey, exists: info !== null }))
      .catch(() => {
        // Leave posState as-is; render falls back to the static one-stake rule on a stale key.
      });
    return () => {
      alive = false;
    };
    // Re-check only when the derived position address changes (wallet/market).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [positionKey]);

  // Only trust a result that matches the current position PDA — no synchronous reset needed.
  const hasPosition =
    posState && posState.key === positionKey ? posState.exists : null;

  if (!publicKey) {
    return (
      <div className="flex flex-col items-start gap-4">
        <div className="flex items-center gap-2">
          <Ticket className="size-4 text-accent" />
          <h3 className="text-sm font-semibold">Place a bet</h3>
        </div>
        <p className="text-sm text-muted-foreground">
          Connect a devnet wallet to build a real <code>stake</code> instruction
          client-side and simulate it against the program.
        </p>
        <ConnectButton />
      </div>
    );
  }

  const settled = market.state === "Settled";
  const headline = fixtureHeadline(market, participants);
  const { human, technical } = describePredicate(market, participants);
  // Placing is only allowed after a clean simulation (or to retry a failed send). This is the
  // gate that item 2's disabled styling and hint make visible.
  const canPlace = canSend;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Ticket className="size-4 text-accent" />
          <h3 className="text-sm font-semibold">Place a bet</h3>
        </div>
        <Badge variant="secondary" className="font-mono">
          stake
        </Badge>
      </div>

      {/* what this bet is, in plain language — teams first, then the wager */}
      <div className="flex flex-col gap-0.5">
        <span className="text-sm font-semibold">{headline}</span>
        <span className="text-sm text-muted-foreground">
          Betting on:{" "}
          <span className="text-foreground">{human ?? technical}</span>
          {human && (
            <span className="ml-1 font-mono text-xs text-muted-foreground/80">
              ({technical})
            </span>
          )}
        </span>
      </div>

      {/* network — the app talks to devnet; a wallet on any other cluster silently fails */}
      <NetworkBanner subject="bet" />

      {/* the one-stake-per-market rule — an explanation shown BEFORE you hit it, not an error */}
      <div className="flex items-start gap-2 rounded-lg border border-border/70 bg-secondary/40 p-2.5 text-xs leading-relaxed text-muted-foreground">
        {hasPosition ? (
          <>
            <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-accent" />
            <span>
              <span className="text-foreground">
                You&rsquo;ve already staked on this market.
              </span>{" "}
              It&rsquo;s one stake per market — you can&rsquo;t add to it or switch sides.
            </span>
          </>
        ) : (
          <>
            <Info className="mt-0.5 size-3.5 shrink-0" />
            <span>
              One stake per market. Once you place it you can&rsquo;t add to it or
              switch sides — so pick your side and amount before you sign.
            </span>
          </>
        )}
      </div>

      {/* side + amount — each side states its outcome so YES/NO is never ambiguous */}
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-2">
          {(["Yes", "No"] as Side[]).map((s) => {
            // Null for unmapped stats — the button then shows plain YES/NO rather than
            // an invented negation.
            const outcome = sideOutcome(market, participants, s);
            return (
              <button
                key={s}
                onClick={() => {
                  setSide(s);
                  reset();
                }}
                className={cn(
                  "flex flex-col items-center gap-0.5 rounded-lg border px-2 py-2 transition-colors cursor-pointer",
                  side === s
                    ? s === "Yes"
                      ? "border-yes/40 bg-yes/10 text-yes"
                      : "border-no/40 bg-no/10 text-no"
                    : "border-border/70 text-muted-foreground hover:bg-secondary",
                )}
              >
                <span className="text-sm font-semibold">{s.toUpperCase()}</span>
                {outcome && (
                  <span
                    className={cn(
                      "text-xs leading-tight",
                      side === s ? "opacity-90" : "text-muted-foreground",
                    )}
                  >
                    {outcome}
                  </span>
                )}
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-2">
          {AMOUNTS.map((a) => (
            <button
              key={a}
              onClick={() => {
                setAmount(a);
                reset();
              }}
              className={cn(
                "tabular flex-1 rounded-md border py-1.5 text-xs font-medium transition-colors cursor-pointer",
                amount === a
                  ? "border-primary/40 bg-primary/10 text-primary"
                  : "border-border/70 text-muted-foreground hover:bg-secondary",
              )}
            >
              {a} SOL
            </button>
          ))}
        </div>
      </div>

      {/* the built instruction */}
      {built && (
        <div className="flex flex-col gap-2 rounded-lg border border-border/70 bg-background/40 p-3">
          <span className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
            Built instruction (client-side)
          </span>
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">discriminator</span>
            <span className="tabular font-mono text-foreground">
              {discHex("stake")}
            </span>
          </div>
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">args</span>
            <span className="tabular font-mono text-foreground">
              side={side === "Yes" ? 0 : 1}, amount={toLamports(amount).toString()}
            </span>
          </div>
          <Separator className="my-1" />
          <AccountRow label="market" pubkey={built.market.toBase58()} flags="w" />
          <AccountRow
            label="position"
            pubkey={built.position.toBase58()}
            flags="w"
          />
          <AccountRow label="vault" pubkey={built.vault.toBase58()} flags="w" />
          <AccountRow
            label="staker"
            pubkey={publicKey.toBase58()}
            flags="s,w"
          />
        </div>
      )}

      {settled && phase === "idle" && (
        <p className="rounded-lg bg-secondary/40 p-2.5 text-xs leading-relaxed text-muted-foreground">
          This featured market is already <span className="text-foreground">Settled</span>
          , so a stake will simulate <span className="text-foreground">fail-closed</span>{" "}
          (<span className="font-mono">MarketNotOpen</span>) — exactly the guard you
          want. Simulate to see the program refuse it safely.
        </p>
      )}

      {/* the full bet, restated in words, right where the user commits to it */}
      <p className="rounded-lg border border-border/70 bg-background/40 p-2.5 text-sm">
        {(() => {
          const outcome = sideOutcome(market, participants, side);
          return outcome ? (
            <>
              You&rsquo;re staking{" "}
              <span className="tabular font-semibold">{amount} SOL</span> that{" "}
              <span
                className={cn(
                  "font-semibold",
                  side === "Yes" ? "text-yes" : "text-no",
                )}
              >
                {outcome}
              </span>
              .
            </>
          ) : (
            // Unmapped stat — state the side and the exact predicate, never a guessed outcome.
            <>
              You&rsquo;re staking{" "}
              <span className="tabular font-semibold">{amount} SOL</span> on{" "}
              <span
                className={cn(
                  "font-semibold",
                  side === "Yes" ? "text-yes" : "text-no",
                )}
              >
                {side.toUpperCase()}
              </span>{" "}
              for <span className="font-mono text-xs">{technical}</span>.
            </>
          );
        })()}
      </p>

      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          onClick={() => built && simulate(built.instruction)}
          disabled={!built || phase === "simulating" || phase === "sending"}
          className="flex-1"
        >
          {phase === "simulating" ? (
            <LoaderCircle className="animate-spin" />
          ) : (
            <FlaskConical />
          )}
          Simulate
        </Button>
        {/* Wrapper carries the not-allowed cursor: the disabled Button has
            `pointer-events-none`, so the hover cursor must live on the parent. */}
        <span className={cn("flex-1", !canPlace && "cursor-not-allowed")}>
          <Button
            onClick={() => built && send(built.instruction)}
            disabled={!canPlace}
            aria-disabled={!canPlace}
            className={cn(
              "w-full",
              // Make "disabled" unmistakable — the solid purple looked clickable and
              // cost three failed attempts.
              !canPlace && "opacity-40 saturate-50",
            )}
          >
            {phase === "sending" ? (
              <LoaderCircle className="animate-spin" />
            ) : (
              <Send />
            )}
            Place bet
          </Button>
        </span>
      </div>
      {!canPlace && phase !== "sending" && (
        <p className="-mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
          <Info className="size-3.5 shrink-0" />
          Run <span className="font-medium text-foreground">Simulate</span> first — it
          checks the bet against the program before you can sign.
        </p>
      )}

      {/* result */}
      {message && (
        <div
          className={cn(
            "flex flex-col gap-2 rounded-lg border p-3 text-sm",
            phase === "sim-ok" || phase === "sent"
              ? "border-primary/30 bg-primary/5"
              : phase === "sim-err" || phase === "send-err"
                ? "border-destructive/30 bg-destructive/5"
                : "border-border/70 bg-card",
          )}
        >
          <span className="flex items-center gap-2 font-medium">
            {phase === "sim-ok" || phase === "sent" ? (
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
    </div>
  );
}
