"use client";

import { useState } from "react";
import {
  Binary,
  ChevronsDownUp,
  ChevronsUpDown,
  CircleCheck,
  Layers,
  Lock,
  ShieldAlert,
  Sigma,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { HashChip } from "@/components/shared/hash-chip";
import { ProofPath } from "@/components/settlement/proof-path";
import {
  DAILY_ROOT_EPOCH_DAY,
  RECORDED_PROOF,
  RECORDED_QUERY,
  totalProofNodes,
} from "@/lib/solana/proof";
import { cn } from "@/lib/utils";

type Tone = "gold" | "primary" | "accent" | "muted";

const toneRing: Record<Tone, string> = {
  gold: "text-gold bg-gold/10 ring-gold/25",
  primary: "text-primary bg-primary/10 ring-primary/25",
  accent: "text-accent bg-accent/10 ring-accent/25",
  muted: "text-muted-foreground bg-secondary ring-border",
};

function RootLevel({
  icon: Icon,
  tone,
  label,
  sublabel,
  bytes,
  onChain,
}: {
  icon: typeof Layers;
  tone: Tone;
  label: string;
  sublabel: string;
  bytes: number[] | null;
  onChain?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-lg border p-3",
        onChain ? "border-gold/30 bg-gold/5" : "border-border/70 bg-card",
      )}
    >
      <span
        className={cn(
          "flex size-9 shrink-0 items-center justify-center rounded-lg ring-1",
          toneRing[tone],
        )}
      >
        <Icon className="size-4.5" />
      </span>
      <div className="flex min-w-0 flex-col">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold">{label}</span>
          {onChain && (
            <Badge variant="gold" className="gap-1">
              <Lock className="size-3" />
              on-chain
            </Badge>
          )}
        </div>
        <span className="text-xs text-muted-foreground">{sublabel}</span>
      </div>
      <div className="ml-auto shrink-0">
        {bytes ? (
          <HashChip bytes={bytes} tone={tone === "muted" ? "muted" : tone} />
        ) : (
          <span className="tabular text-[11px] text-gold">
            committed · epoch-day {DAILY_ROOT_EPOCH_DAY}
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * `predicateLabel` / `winner` describe the market this proof settled. They are nullable on
 * purpose: when the market cannot be read from the RPC the viewer says so rather than
 * defaulting to a plausible-looking predicate or winner.
 */
export function MerkleProofViewer({
  predicateLabel = null,
  winner = null,
}: {
  predicateLabel?: string | null;
  winner?: string | null;
}) {
  // resetKey remounts the ProofPaths to apply an expand/collapse-all; between
  // resets each path toggles on its own.
  const [{ resetKey, bulk }, setBulk] = useState<{
    resetKey: number;
    bulk: boolean | null;
  }>({ resetKey: 0, bulk: null });

  const perStageDefault = [false, true, false]; // sub-tree open by default
  const openFor = (i: number) => (bulk === null ? perStageDefault[i] : bulk);

  const stat = RECORDED_PROOF.statToProve;
  const predicateHolds = stat.value > 0;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="text-lg font-semibold tracking-tight">
            The proof that settles this market
          </h2>
          <p className="text-sm text-muted-foreground">
            Match #{RECORDED_QUERY.fixtureId} · stat #{RECORDED_QUERY.statKey} ·{" "}
            {totalProofNodes()}{" "}
            Merkle hashes fold up to TxODDS&apos;s committed on-chain root.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="secondary">recorded TxLINE World Cup proof</Badge>
          <button
            onClick={() =>
              setBulk((s) => ({ resetKey: s.resetKey + 1, bulk: true }))
            }
            className="inline-flex items-center gap-1 rounded-md border border-input px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground cursor-pointer"
          >
            <ChevronsUpDown className="size-3.5" />
            Expand
          </button>
          <button
            onClick={() =>
              setBulk((s) => ({ resetKey: s.resetKey + 1, bulk: false }))
            }
            className="inline-flex items-center gap-1 rounded-md border border-input px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground cursor-pointer"
          >
            <ChevronsDownUp className="size-3.5" />
            Collapse
          </button>
        </div>
      </div>

      {/* Pipeline: on-chain root (top) → paths → fixture stat leaf (bottom) */}
      <div className="flex flex-col">
        <RootLevel
          icon={Lock}
          tone="gold"
          label="TxODDS daily root"
          sublabel="the root TxODDS committed on-chain — settle proves against this"
          bytes={null}
          onChain
        />
        <ProofPath
          key={`m-${resetKey}`}
          nodes={RECORDED_PROOF.mainTreeProof}
          targetLabel="the daily root"
          defaultOpen={openFor(0)}
        />
        <RootLevel
          icon={Layers}
          tone="primary"
          label="Events sub-tree root"
          sublabel="travels inside the on-chain match summary"
          bytes={RECORDED_PROOF.summary.eventStatsSubTreeRoot}
        />
        <ProofPath
          key={`s-${resetKey}`}
          nodes={RECORDED_PROOF.subTreeProof}
          targetLabel="the sub-tree root"
          defaultOpen={openFor(1)}
        />
        <RootLevel
          icon={Sigma}
          tone="accent"
          label="Event stat root"
          sublabel="the Merkle root over one event's stats"
          bytes={RECORDED_PROOF.eventStatRoot}
        />
        <ProofPath
          key={`t-${resetKey}`}
          nodes={RECORDED_PROOF.statProof}
          targetLabel="the event stat root"
          defaultOpen={openFor(2)}
        />
        {/* leaf */}
        <div className="flex items-center gap-3 rounded-lg border border-border/70 bg-secondary/40 p-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-secondary text-foreground ring-1 ring-border">
            <Binary className="size-4.5" />
          </span>
          <div className="flex flex-col">
            <span className="text-sm font-semibold">Match stat (the leaf)</span>
            <span className="text-xs text-muted-foreground">
              the single measured value the whole proof commits to
            </span>
          </div>
          <div className="tabular ml-auto flex items-center gap-3 text-xs">
            <span className="text-muted-foreground">
              key <span className="font-semibold text-foreground">{stat.key}</span>
            </span>
            <span className="text-muted-foreground">
              value{" "}
              <span className="font-semibold text-foreground">{stat.value}</span>
            </span>
            <span className="text-muted-foreground">
              period{" "}
              <span className="font-semibold text-foreground">{stat.period}</span>
            </span>
          </div>
        </div>
      </div>

      <Separator />

      {/* Verdict */}
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex items-start gap-2.5 rounded-lg border border-primary/25 bg-primary/5 p-3">
          <CircleCheck className="mt-0.5 size-4.5 shrink-0 text-primary" />
          <div className="flex flex-col gap-1 text-sm">
            <span className="font-medium">validate_stat verifies + evaluates</span>
            <span className="text-xs leading-relaxed text-muted-foreground">
              The oracle recomputes the leaf up the path and checks it equals its{" "}
              <span className="text-foreground">own committed root</span>, then
              evaluates the predicate{" "}
              <span className="font-mono text-foreground">
                {predicateLabel ?? "this market's predicate"}
              </span>{" "}
              (value = {stat.value} → {predicateHolds ? "holds" : "fails"}) →{" "}
              <span className="font-mono text-primary">Ok(true)</span>.
            </span>
          </div>
        </div>
        <div className="flex items-start gap-2.5 rounded-lg border border-border/70 bg-card p-3">
          <ShieldAlert className="mt-0.5 size-4.5 shrink-0 text-gold" />
          <div className="flex flex-col gap-1 text-sm">
            <span className="font-medium">A tampered proof reverts</span>
            <span className="text-xs leading-relaxed text-muted-foreground">
              Flip a single byte and the recomputed root no longer matches the
              committed one — the CPI returns{" "}
              <span className="font-mono text-destructive">Err</span> and{" "}
              <span className="text-foreground">settle reverts</span>. Settled by
              the committed on-chain proof, not an admin.
            </span>
          </div>
        </div>
      </div>

      <div className="flex items-center justify-center gap-2 rounded-lg bg-secondary/40 py-2.5 text-sm">
        <span className="text-muted-foreground">settle records</span>
        {winner ? (
          <Badge variant="yes">
            <CircleCheck className="size-3" />
            winner = {winner}
          </Badge>
        ) : (
          <Badge variant="secondary">winner — market not read</Badge>
        )}
        <span className="text-muted-foreground">— from the proof, nothing else.</span>
      </div>
    </div>
  );
}
