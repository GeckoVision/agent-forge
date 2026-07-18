"use client";

import { useEffect, useState } from "react";
import { useConnection } from "@solana/wallet-adapter-react";

import { type Cluster, detectCluster } from "@/lib/solana/cluster";

/**
 * The cluster the app's connection actually points at, read live from its genesis hash.
 *
 * `null` while the lookup is in flight; `"unknown"` when the RPC can't be reached or returns an
 * unrecognised hash. See {@link file://lib/solana/cluster.ts} for why we read the connection's
 * cluster rather than the wallet's (the adapter does not expose the wallet's network).
 */
export function useCluster(): { cluster: Cluster | null; loading: boolean } {
  const { connection } = useConnection();
  const [cluster, setCluster] = useState<Cluster | null>(null);

  useEffect(() => {
    let alive = true;
    detectCluster(connection).then((c) => alive && setCluster(c));
    return () => {
      alive = false;
    };
  }, [connection]);

  return { cluster, loading: cluster === null };
}
