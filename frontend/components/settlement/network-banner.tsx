"use client";

import { Info, LoaderCircle, TriangleAlert } from "lucide-react";

import { useCluster } from "@/hooks/use-cluster";
import { CLUSTER_LABEL } from "@/lib/solana/cluster";
import { cn } from "@/lib/utils";

// The app talks to devnet; a transaction signed by a wallet on any other cluster is
// the exact mismatch that silently never-broadcasts. This is the network every
// signing panel expects.
export const EXPECTED_CLUSTER = "devnet";

/**
 * The which-network-am-I-really-on banner, shared by every panel that asks for a
 * signature (stake, create_market). Verified from the connection's genesis hash —
 * NOT the wallet's own selected cluster, which the adapter does not expose (see
 * lib/solana/cluster.ts). `subject` names the thing that fails ("bet", "market").
 */
export function NetworkBanner({ subject }: { subject: string }) {
  const { cluster: appCluster } = useCluster();
  const clusterOk = appCluster === EXPECTED_CLUSTER;

  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-lg border p-2.5 text-xs leading-relaxed",
        appCluster === null
          ? "border-border/70 bg-secondary/40 text-muted-foreground"
          : clusterOk
            ? "border-primary/25 bg-primary/5 text-muted-foreground"
            : "border-destructive/40 bg-destructive/5 text-foreground",
      )}
    >
      {appCluster === null ? (
        <>
          <LoaderCircle className="mt-0.5 size-3.5 shrink-0 animate-spin" />
          <span>Checking which network this app is connected to…</span>
        </>
      ) : clusterOk ? (
        <>
          <Info className="mt-0.5 size-3.5 shrink-0 text-primary" />
          <span>
            This app settles on{" "}
            <span className="font-medium text-foreground">
              {CLUSTER_LABEL[EXPECTED_CLUSTER]}
            </span>
            . Make sure your wallet is set to {CLUSTER_LABEL[EXPECTED_CLUSTER]} too,
            or the {subject} will fail to broadcast.
          </span>
        </>
      ) : (
        <>
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-destructive" />
          <span>
            This app is connected to{" "}
            <span className="font-medium">{CLUSTER_LABEL[appCluster]}</span>, not{" "}
            {CLUSTER_LABEL[EXPECTED_CLUSTER]}. A {subject} signed here will not
            settle as expected — switch to {CLUSTER_LABEL[EXPECTED_CLUSTER]} first.
          </span>
        </>
      )}
    </div>
  );
}
