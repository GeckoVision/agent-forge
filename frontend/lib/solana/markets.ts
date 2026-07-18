import { Connection, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";

import { getNetworkConfig, type DataMode, type NetworkConfig } from "./config";
import { getConnection } from "./connection";
import {
  DISCRIMINATORS,
  decodeMarket,
  decodePosition,
  MARKET_ACCOUNT_SIZE,
  POSITION_ACCOUNT_SIZE,
  type MarketAccount,
  type PositionAccount,
} from "./forge-client";

// The `conn` parameter is injectable so every call can be unit-tested with a
// light fake transport; in the app it defaults to the pooled proxy connection.

// ── single account ─────────────────────────────────────────────────────────────
export async function fetchMarket(
  address: string,
  mode: DataMode = "devnet",
  conn: Connection = getConnection(mode),
): Promise<MarketAccount | null> {
  const info = await conn.getAccountInfo(new PublicKey(address));
  if (!info) return null;
  return decodeMarket(address, info.data);
}

// ── all markets the program owns ─────────────────────────────────────────────────
/**
 * All `Market` accounts under the program (via `getProgramAccounts`, filtered by
 * byte size so no account discriminator is needed). If the bulk scan is
 * unavailable — public devnet 429s these heavily — it degrades to fetching a few
 * known real markets individually so the UI still shows real on-chain state.
 */
export async function fetchMarkets(
  mode: DataMode = "devnet",
  conn: Connection = getConnection(mode),
): Promise<MarketAccount[]> {
  const config = getNetworkConfig(mode);
  const byAddress = new Map<string, MarketAccount>();

  try {
    const accounts = await conn.getProgramAccounts(config.forgeProgramId, {
      filters: [{ dataSize: MARKET_ACCOUNT_SIZE }],
    });
    for (const { pubkey, account } of accounts) {
      try {
        byAddress.set(pubkey.toBase58(), decodeMarket(pubkey.toBase58(), account.data));
      } catch {
        // skip anything that doesn't decode as a Market
      }
    }
  } catch {
    // getProgramAccounts unavailable / rate-limited — featured fallback below.
  }

  // Degraded read: pull the known-real markets individually if the scan missed/failed.
  // Sequential (not a burst) so the fallback itself doesn't trip rate limits.
  for (const addr of config.fallbackMarkets) {
    if (!byAddress.has(addr)) {
      const m = await fetchMarket(addr, mode, conn).catch(() => null);
      if (m) byAddress.set(addr, m);
    }
  }

  return [...byAddress.values()].sort((a, b) => {
    // settled first, then by pot desc — the demo-worthy records lead.
    if (a.state !== b.state) return a.state === "Settled" ? -1 : 1;
    return Number(b.potLamports - a.potLamports);
  });
}

/**
 * The markets to feature, chosen from what is actually on chain: settled markets first (they
 * have a proof to show), then by pot — the ordering `fetchMarkets` already applied. Returns
 * fewer than `count`, or none, when the chain holds fewer; it never pads the list.
 */
export function selectFeatured(
  markets: MarketAccount[] | null,
  count = 2,
): MarketAccount[] {
  return (markets ?? []).slice(0, count);
}

/**
 * Every market this program holds for a TxODDS fixture, ordered by stat key.
 *
 * Plural on purpose: the market PDA is seeded by (fixture, stat), so one fixture can carry
 * several markets. Returning a single "the" market would silently drop real on-chain stakes.
 */
export function findAllByFixture(
  markets: MarketAccount[] | null,
  fixtureId: number,
): MarketAccount[] {
  return (markets ?? [])
    .filter((m) => m.fixtureId === BigInt(fixtureId))
    .sort((a, b) => a.statKey - b.statKey);
}

// ── positions on a market ────────────────────────────────────────────────────────
export async function fetchPositions(
  marketAddress: string,
  mode: DataMode = "devnet",
  conn: Connection = getConnection(mode),
): Promise<PositionAccount[]> {
  const config = getNetworkConfig(mode);
  try {
    const accounts = await conn.getProgramAccounts(config.forgeProgramId, {
      filters: [
        { dataSize: POSITION_ACCOUNT_SIZE },
        { memcmp: { offset: 8, bytes: marketAddress } },
      ],
    });
    return accounts
      .map(({ pubkey, account }) => {
        try {
          return decodePosition(pubkey.toBase58(), account.data);
        } catch {
          return null;
        }
      })
      .filter((p): p is PositionAccount => p !== null);
  } catch {
    return [];
  }
}

// ── transaction history for a market (create → stake → settle → claim) ───────────
export type MarketTxKind =
  | "create_market"
  | "stake"
  | "settle"
  | "claim"
  | "other";

export interface MarketTx {
  signature: string;
  kind: MarketTxKind;
  blockTime: number | null;
  err: boolean;
}

export function classifyByDiscriminator(data: Uint8Array): MarketTxKind {
  const head = Array.from(data.subarray(0, 8));
  for (const [name, disc] of Object.entries(DISCRIMINATORS)) {
    if (disc.every((b, i) => b === head[i])) return name as MarketTxKind;
  }
  return "other";
}

/**
 * The market's on-chain lifecycle, newest-first, each classified by matching the
 * `forge_markets` instruction's 8-byte discriminator. Best-effort: any signature
 * we can't fetch/parse is labelled "other" rather than dropped, and a failed
 * signatures lookup degrades to an empty list rather than throwing.
 */
export async function fetchMarketTransactions(
  marketAddress: string,
  config: NetworkConfig,
  limit = 10,
  conn: Connection = getConnection(config.mode),
): Promise<MarketTx[]> {
  const market = new PublicKey(marketAddress);
  let sigs;
  try {
    sigs = await conn.getSignaturesForAddress(market, { limit });
  } catch {
    return [];
  }

  const out: MarketTx[] = [];
  for (const s of sigs) {
    let kind: MarketTxKind = "other";
    try {
      kind = await classifyOneTx(conn, s.signature, config.forgeProgramId);
    } catch {
      kind = "other";
    }
    out.push({
      signature: s.signature,
      kind,
      blockTime: s.blockTime ?? null,
      err: s.err !== null,
    });
  }
  return out;
}

async function classifyOneTx(
  conn: Connection,
  signature: string,
  forgeProgramId: PublicKey,
): Promise<MarketTxKind> {
  const parsed = await conn.getParsedTransaction(signature, {
    maxSupportedTransactionVersion: 0,
  });
  const instructions = parsed?.transaction.message.instructions ?? [];
  for (const ix of instructions) {
    // Our forge instructions come back partially-decoded (base58 `data`).
    if ("data" in ix && ix.programId.equals(forgeProgramId)) {
      return classifyByDiscriminator(bs58.decode(ix.data));
    }
  }
  return "other";
}

/** The single settle transaction for a market, if we can find it. */
export function findSettleTx(txs: MarketTx[]): MarketTx | null {
  return txs.find((t) => t.kind === "settle" && !t.err) ?? null;
}
