"use client";

import { useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import {
  TransactionMessage,
  VersionedTransaction,
  type TransactionInstruction,
} from "@solana/web3.js";

import { confirmSignature } from "@/lib/solana/confirm";
import { customErrorCode, settlementErrorName } from "@/lib/solana/forge-client";

/**
 * The shared simulate-then-send flow for a client-built program instruction —
 * extracted from PlaceBetPanel so every panel that signs (stake, create_market)
 * runs the SAME gates: a send is only reachable after a clean simulation, and a
 * confirmation timeout reports the honest truth (a signature proves nothing about
 * whether the transaction was broadcast), never a fake success.
 */

export type IxPhase =
  | "idle"
  | "simulating"
  | "sim-ok"
  | "sim-err"
  | "sending"
  | "sent"
  | "send-err";

export interface IxFlowCopy {
  /** Shown after a clean simulation, e.g. "Simulation succeeded — ready to sign." */
  simOk: string;
  /** Shown on confirmed success; receives the commitment reached. */
  sent: (outcome: string) => string;
  /** The honest may-not-have-broadcast copy shown when confirmation times out. */
  timeout: string;
}

export interface IxFlow {
  phase: IxPhase;
  message: string | null;
  logs: string[] | null;
  sig: string | null;
  reset: () => void;
  simulate: (ix: TransactionInstruction) => Promise<void>;
  /** Resolves `true` only when the transaction confirmed on-chain. */
  send: (ix: TransactionInstruction) => Promise<boolean>;
  /** Sending is only allowed after a clean simulation (or to retry a failed send). */
  canSend: boolean;
}

export function useInstructionFlow(copy: IxFlowCopy): IxFlow {
  const { connection } = useConnection();
  const { publicKey, sendTransaction } = useWallet();

  const [phase, setPhase] = useState<IxPhase>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [logs, setLogs] = useState<string[] | null>(null);
  const [sig, setSig] = useState<string | null>(null);

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

  async function simulate(ix: TransactionInstruction) {
    if (!publicKey) return;
    reset();
    setPhase("simulating");
    try {
      const tx = await buildVersionedTx(ix);
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
        setMessage(copy.simOk);
      }
    } catch (e) {
      setPhase("sim-err");
      setMessage(e instanceof Error ? e.message : String(e));
    }
  }

  async function send(ix: TransactionInstruction): Promise<boolean> {
    if (!publicKey) return false;
    setPhase("sending");
    setMessage(null);
    try {
      const tx = await buildVersionedTx(ix);
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
        return false;
      }
      if (outcome === "timeout") {
        // A signature exists the moment the wallet signs — it proves NOTHING about
        // whether the transaction was broadcast or landed. Report the honest truth.
        setPhase("send-err");
        setMessage(copy.timeout);
        return false;
      }
      setPhase("sent");
      setMessage(copy.sent(outcome));
      return true;
    } catch (e) {
      setPhase("send-err");
      setMessage(e instanceof Error ? e.message : String(e));
      return false;
    }
  }

  const canSend = phase === "sim-ok" || phase === "send-err";

  return { phase, message, logs, sig, reset, simulate, send, canSend };
}
