import { PublicKey } from "@solana/web3.js";

/**
 * The data-source mode. `devnet` is the only path wired today; `mainnet-sim`
 * is a deliberate SEAM for a future "mainnet simulation" toggle (a mainnet-fork
 * RPC + the mainnet oracle id). Every data-source function takes a resolved
 * {@link NetworkConfig}, so flipping the mode is the only change needed later.
 */
export type DataMode = "devnet" | "mainnet-sim";

export const DATA_MODE: DataMode =
  (process.env.NEXT_PUBLIC_DATA_MODE as DataMode | undefined) ?? "devnet";

export type ExplorerCluster = "devnet" | "mainnet" | "custom";

export interface NetworkConfig {
  mode: DataMode;
  label: string;
  /** The deployed `forge_markets` program. */
  forgeProgramId: PublicKey;
  /** The TxODDS on-chain oracle `settle` CPIs into. */
  txoracleProgramId: PublicKey;
  /** Cluster label used to build explorer links. */
  explorerCluster: ExplorerCluster;
  /**
   * Real on-chain markets to fall back to when the bulk `getProgramAccounts` scan is
   * unavailable (public devnet 429s it heavily). NOT a curated feature list — the featured
   * set is derived from live program accounts by {@link selectFeatured}; these addresses are
   * only a degraded read path so the page shows real state instead of nothing.
   */
  fallbackMarkets: string[];
  /** Whether this mode reads live chain data yet. */
  live: boolean;
}

// ── Frozen on-chain identities (verified deployed + executable on devnet) ──────
export const FORGE_PROGRAM_ID = new PublicKey(
  "7Pvo6SEh1zBa1Euvj5QQ4td9GpfsQosTpxhqwWtWUFt6",
);
const DEVNET_TXORACLE_ID = new PublicKey(
  "6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J",
);
const MAINNET_TXORACLE_ID = new PublicKey(
  "9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA",
);

/**
 * Degraded-read addresses only. Two REAL markets this program owns on devnet — read
 * individually when `getProgramAccounts` is rate-limited, so the UI can still render real
 * on-chain state. Whatever they hold on chain is what renders; nothing about them is asserted
 * here. The markets the page features are chosen from live accounts, not from this list.
 */
export const FALLBACK_MARKETS = [
  "3urJkTFSAf6QXLU6QvkbbS4GjLn3Tos8VQjKgGmRrVL8",
  "CBmdQH4sATjCkeVUe8TC6fCmawv8rqf8sM5G39DHf295",
] as const;

const NETWORKS: Record<DataMode, NetworkConfig> = {
  devnet: {
    mode: "devnet",
    label: "Solana Devnet",
    forgeProgramId: FORGE_PROGRAM_ID,
    txoracleProgramId: DEVNET_TXORACLE_ID,
    explorerCluster: "devnet",
    fallbackMarkets: [...FALLBACK_MARKETS],
    live: true,
  },
  // SEAM — not wired to a live RPC yet. A future toggle points this at a
  // mainnet-fork endpoint and swaps the oracle id; the UI/decoders are unchanged.
  "mainnet-sim": {
    mode: "mainnet-sim",
    label: "Mainnet Simulation",
    forgeProgramId: FORGE_PROGRAM_ID,
    txoracleProgramId: MAINNET_TXORACLE_ID,
    explorerCluster: "custom",
    fallbackMarkets: [],
    live: false,
  },
};

export function getNetworkConfig(mode: DataMode = DATA_MODE): NetworkConfig {
  return NETWORKS[mode];
}

/**
 * Same-origin RPC proxy. All chain reads/sends go through our Next.js route
 * handler ({@link file://app/api/rpc/route.ts}) so the Helius API key stays
 * server-side and never reaches the browser bundle.
 */
export function rpcEndpoint(mode: DataMode = DATA_MODE): string {
  const base =
    typeof window !== "undefined" ? window.location.origin : "http://localhost:3000";
  return `${base}/api/rpc?mode=${mode}`;
}

export function explorerAddress(
  address: string,
  cluster: ExplorerCluster = "devnet",
): string {
  const q = cluster === "mainnet" ? "" : `?cluster=${cluster}`;
  return `https://explorer.solana.com/address/${address}${q}`;
}

export function explorerTx(
  signature: string,
  cluster: ExplorerCluster = "devnet",
): string {
  const q = cluster === "mainnet" ? "" : `?cluster=${cluster}`;
  return `https://explorer.solana.com/tx/${signature}${q}`;
}
