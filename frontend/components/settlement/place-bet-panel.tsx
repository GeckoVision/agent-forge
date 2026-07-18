"use client";

import { useMemo, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import {
  TransactionMessage,
  VersionedTransaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import {
  Ban,
  CircleCheck,
  FlaskConical,
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
import type { ExplorerCluster } from "@/lib/solana/config";
import { confirmSignature } from "@/lib/solana/confirm";
import {
  buildStakeIx,
  customErrorCode,
  DISCRIMINATORS,
  settlementErrorName,
  toLamports,
  type MarketAccount,
  type Side,
} from "@/lib/solana/forge-client";
import { cn } from "@/lib/utils";

const AMOUNTS = [0.002, 0.005, 0.01];

type Phase =
  | "idle"
  | "simulating"
  | "sim-ok"
  | "sim-err"
  | "sending"
  | "sent"
  | "send-err";

function discHex(name: keyof typeof DISCRIMINATORS): string {
  return DISCRIMINATORS[name].map((b) => b.toString(16).padStart(2, "0")).join(" ");
}

function AccountRow({
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
  cluster = "devnet",
}: {
  market: MarketAccount;
  cluster?: ExplorerCluster;
}) {
  const { connection } = useConnection();
  const { publicKey, sendTransaction } = useWallet();

  const [side, setSide] = useState<Side>("Yes");
  const [amount, setAmount] = useState(0.005);
  const [phase, setPhase] = useState<Phase>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [logs, setLogs] = useState<string[] | null>(null);
  const [sig, setSig] = useState<string | null>(null);

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

  const reset = () => {
    setPhase("idle");
    setMessage(null);
    setLogs(null);
    setSig(null);
  };

  async function buildVersionedTx(ix: TransactionInstruction) {
    const { blockhash } = await connection.getLatestBlockhash("confirmed");
    const msg = new TransactionMessage({
      payerKey: publicKey!,
      recentBlockhash: blockhash,
      instructions: [ix],
    }).compileToV0Message();
    return new VersionedTransaction(msg);
  }

  async function simulate() {
    if (!built) return;
    reset();
    setPhase("simulating");
    try {
      const tx = await buildVersionedTx(built.instruction);
      const res = await connection.simulateTransaction(tx, {
        sigVerify: false,
        replaceRecentBlockhash: true,
        commitment: "confirmed",
      });
      setLogs(res.value.logs ?? null);
      if (res.value.err) {
        const code = customErrorCode(res.value.err);
        const name = code ? settlementErrorName(code) : null;
        setPhase("sim-err");
        setMessage(
          name
            ? `Program refused, fail-closed: ${name} (${code}).`
            : `Simulation reverted: ${JSON.stringify(res.value.err)}`,
        );
      } else {
        setPhase("sim-ok");
        setMessage("Simulation succeeded — the bet is valid and ready to sign.");
      }
    } catch (e) {
      setPhase("sim-err");
      setMessage(e instanceof Error ? e.message : String(e));
    }
  }

  async function placeBet() {
    if (!built || !publicKey) return;
    setPhase("sending");
    setMessage(null);
    try {
      const tx = await buildVersionedTx(built.instruction);
      const signature = await sendTransaction(tx, connection);
      setSig(signature);
      // Poll over HTTP (the proxy connection has no ws endpoint for a
      // subscription-based confirmTransaction).
      const outcome = await confirmSignature(connection, signature, {
        timeoutMs: 30_000,
      });
      if (outcome === "failed") {
        setPhase("send-err");
        setMessage("Transaction reverted on-chain.");
        return;
      }
      setPhase("sent");
      setMessage(
        outcome === "timeout"
          ? "Bet submitted — confirmation is taking longer than usual."
          : `Bet placed on-chain (${outcome}).`,
      );
    } catch (e) {
      setPhase("send-err");
      setMessage(e instanceof Error ? e.message : String(e));
    }
  }

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

      {/* side + amount */}
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-2">
          {(["Yes", "No"] as Side[]).map((s) => (
            <button
              key={s}
              onClick={() => {
                setSide(s);
                reset();
              }}
              className={cn(
                "rounded-lg border py-2 text-sm font-semibold transition-colors cursor-pointer",
                side === s
                  ? s === "Yes"
                    ? "border-yes/40 bg-yes/10 text-yes"
                    : "border-no/40 bg-no/10 text-no"
                  : "border-border/70 text-muted-foreground hover:bg-secondary",
              )}
            >
              {s.toUpperCase()}
            </button>
          ))}
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

      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          onClick={simulate}
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
        <Button
          onClick={placeBet}
          disabled={phase !== "sim-ok" && phase !== "send-err"}
          className="flex-1"
        >
          {phase === "sending" ? (
            <LoaderCircle className="animate-spin" />
          ) : (
            <Send />
          )}
          Place bet
        </Button>
      </div>

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
