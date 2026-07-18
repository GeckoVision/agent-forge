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
    // Settled first, then pot desc: a settled market is the only one that can carry a
    // proof, so leading with it means any consumer taking the head of this list has the
    // settlement story available. Callers that also need a stakeable market must span
    // both states deliberately — see `selectFeatured`, which does exactly that.
    if (a.state !== b.state) return a.state === "Settled" ? -1 : 1;
    return Number(b.potLamports - a.potLamports);
  });
}

/** The one piece of match metadata featuring cares about: when the match kicks off. */
export interface FixtureSchedule {
  kickoffMs: number;
}

/**
 * Resolve a market's fixture to its schedule, or `null` when the fixture is unknown to the
 * capture (synthetic/demo test markets can never resolve).
 */
export type FixtureScheduleLookup = (fixtureId: bigint) => FixtureSchedule | null;

/**
 * The markets to feature, chosen from what is actually on chain.
 *
 * The rule, in priority order:
 *
 *   1. Lead with the top-pot SETTLED market — it carries the Merkle proof, the page's
 *      centrepiece story.
 *   2. Fill the remaining slots with OPEN markets on DISTINCT matches (top pot per match).
 *      One match can hold several markets (the PDA is per (fixture, stat)); featuring two
 *      of them would bury the next match's brand-new (pot 0) market, which is exactly the
 *      market a visitor can still meaningfully bet on.
 *      When a schedule lookup is provided, distinct matches are ordered by kickoff, newest
 *      first — the matches happening now/next are the ones a viewer can still care about,
 *      while a big-pot market on a match played weeks ago is stale however rich it is.
 *      Matches with no known schedule (synthetic/demo markets) sort last, by pot.
 *   3. Backfill with whatever else exists — remaining settled, then the same-match opens
 *      that step 2 deduplicated away.
 *
 * Ties (e.g. two fresh pot-0 markets on one match) break deterministically by stat key,
 * then address. It never pads the list and never invents a market the program does not own.
 */
export function selectFeatured(
  markets: MarketAccount[] | null,
  count = 2,
  schedule?: FixtureScheduleLookup,
): MarketAccount[] {
  const byPot = [...(markets ?? [])].sort(
    (a, b) =>
      Number(b.potLamports - a.potLamports) ||
      a.statKey - b.statKey ||
      a.address.localeCompare(b.address),
  );
  const settled = byPot.filter((m) => m.state === "Settled");

  // Open markets, one per match — the rest are kept aside as backfill, not dropped.
  const openPerFixture: MarketAccount[] = [];
  const openDuplicates: MarketAccount[] = [];
  const seenFixtures = new Set<string>();
  for (const m of byPot) {
    if (m.state === "Settled") continue;
    const key = m.fixtureId.toString();
    if (seenFixtures.has(key)) {
      openDuplicates.push(m);
    } else {
      seenFixtures.add(key);
      openPerFixture.push(m);
    }
  }

  // Freshest matches first; unknown-schedule (demo) matches keep their pot order, last.
  if (schedule) {
    openPerFixture.sort((a, b) => {
      const ka = schedule(a.fixtureId)?.kickoffMs ?? null;
      const kb = schedule(b.fixtureId)?.kickoffMs ?? null;
      if (ka === null && kb === null) return 0; // stable sort keeps the pot order
      if (ka === null) return 1;
      if (kb === null) return -1;
      return kb - ka;
    });
  }

  const featured: MarketAccount[] = [];
  if (settled.length > 0 && count > 0) featured.push(settled[0]);
  for (const queue of [openPerFixture, settled.slice(1), openDuplicates]) {
    for (const m of queue) {
      if (featured.length >= count) return featured;
      featured.push(m);
    }
  }
  return featured;
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
