import type { Connection } from "@solana/web3.js";

/**
 * Which Solana cluster the panel's transactions actually flow through.
 *
 * ## Why this is read from the genesis hash, not the wallet
 *
 * The founder's three failed bets were never broadcast because the WALLET was pointed at
 * mainnet while the app talks to devnet. We would like to display the wallet's own selected
 * cluster — but the legacy `@solana/wallet-adapter-base` `Adapter` interface exposes NO such
 * field (no `chain`, `cluster`, or `chains`; see `WalletAdapterProps`), and `PhantomWalletAdapter`
 * does not surface the extension's network. So the wallet's cluster genuinely cannot be read
 * from the adapter, and faking it would be a lie on camera.
 *
 * What we CAN read honestly is the cluster on the OTHER side of the connection — the RPC the
 * app builds, signs against, and submits to — by its genesis hash. A stake is built against
 * this connection's blockhash and sent through it, so this is the network the bet truly targets.
 * Showing it prominently, and telling the user their wallet must match it, is the actionable
 * fix for the exact mismatch that broke the demo.
 */

export type Cluster = "devnet" | "mainnet" | "testnet" | "unknown";

// Canonical genesis hashes — a cluster's permanent fingerprint.
const GENESIS_TO_CLUSTER: Record<string, Cluster> = {
  "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d": "mainnet",
  EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG: "devnet",
  "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY": "testnet",
};

export const CLUSTER_LABEL: Record<Cluster, string> = {
  devnet: "Devnet",
  mainnet: "Mainnet",
  testnet: "Testnet",
  unknown: "Unknown network",
};

export function clusterFromGenesisHash(hash: string): Cluster {
  return GENESIS_TO_CLUSTER[hash] ?? "unknown";
}

/**
 * Read the connection's cluster from its genesis hash. Returns `"unknown"` (never throws) when
 * the RPC can't be reached or returns an unrecognised hash — the caller shows an honest
 * "couldn't determine" state rather than assuming devnet.
 */
export async function detectCluster(conn: Connection): Promise<Cluster> {
  try {
    return clusterFromGenesisHash(await conn.getGenesisHash());
  } catch {
    return "unknown";
  }
}
