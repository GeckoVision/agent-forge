"use client";

import { Check, Lock, ShieldCheck } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { POLICY, shortProgram } from "@/lib/agent/policy";

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between rounded-lg border border-border/70 bg-background/40 px-3 py-2.5">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="tabular text-sm font-semibold text-primary">{value}</span>
    </div>
  );
}

/**
 * The real custody policy, rendered from the backend's `ChainPolicy` values.
 *
 * These rules are enforced in the signer (`gorilla.wallets._enforce_policy`) BEFORE a
 * signature exists — this panel only reports them. It deliberately does not simulate a
 * refusal in the browser: a client-side re-check would be theatre, not enforcement.
 */
export function PolicyPanel() {
  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-2">
        <span className="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary ring-1 ring-primary/25">
          <Lock className="size-4.5" />
        </span>
        <div>
          <h3 className="text-sm font-semibold">Custody policy</h3>
          <p className="text-xs text-muted-foreground">
            Authorized once; enforced by the signer before a signature exists.
          </p>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <Row label="Total spend cap" value={`${POLICY.maxSpendSol} SOL`} />
        <Row label="Stake per bet" value={`${POLICY.stakePerBetSol} SOL`} />
        <Row label="Max per match" value={`${POLICY.maxPerFixtureSol} SOL`} />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-sm text-muted-foreground">
          Program + instruction allow-list
        </span>
        <div className="flex flex-col gap-1.5">
          {POLICY.allow.map((binding) => (
            <div
              key={binding.purpose}
              className="flex flex-wrap items-center gap-1.5"
            >
              <Badge variant="secondary" className="font-mono">
                <Check className="text-primary" />
                {binding.instruction}
              </Badge>
              <span className="font-mono text-xs text-muted-foreground">
                @ {shortProgram(binding.programId)}
              </span>
              <span className="text-xs text-muted-foreground/70">
                ({binding.purpose})
              </span>
            </div>
          ))}
        </div>
      </div>

      <p className="flex items-start gap-2 rounded-lg bg-primary/5 p-3 text-xs leading-relaxed text-muted-foreground">
        <ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" />
        <span>
          Anything outside these bounds is refused{" "}
          <span className="font-medium text-foreground">unsigned</span>: a
          different program, a different instruction, or a spend over the cap
          never reaches a signature. The built transaction is re-verified against
          the binding — right discriminator, one instruction, no extra signer —
          before the key is touched.
        </span>
      </p>

      <p className="text-[11px] leading-relaxed text-muted-foreground/70">
        Values read from the backend&apos;s real <code>ChainPolicy</code> (
        {POLICY.source}), not typed into this page.
      </p>
    </div>
  );
}
