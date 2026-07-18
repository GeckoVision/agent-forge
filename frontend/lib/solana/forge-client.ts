import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import { Buffer } from "buffer";

import { ByteReader, ByteWriter } from "./borsh";
import { FORGE_PROGRAM_ID } from "./config";

/**
 * Client mirror of `backend/gorilla/forge_client.py`. Turns an intent into
 * the EXACT `forge_markets` instruction the deployed devnet program expects —
 * right 8-byte Anchor discriminator, right account metas, right Borsh args, right
 * PDA derivations — and decodes the public on-chain `Market`/`Position` state.
 * The program is frozen; this file mirrors its wire format as DATA.
 *
 * Only the read + `stake` paths are ported here (what the web surface needs);
 * settle/claim stay server-side in the backend.
 */

export type Side = "Yes" | "No";
export type MarketStateName = "Open" | "Settled";

export enum Comparison {
  GreaterThan = 0,
  LessThan = 1,
  EqualTo = 2,
}

export const COMPARISON_SYMBOL: Record<Comparison, string> = {
  [Comparison.GreaterThan]: ">",
  [Comparison.LessThan]: "<",
  [Comparison.EqualTo]: "=",
};

// Borsh variant index for the program's `Side` enum (Yes = 0, No = 1).
const SIDE_INDEX: Record<Side, number> = { Yes: 0, No: 1 };

// Anchor discriminators = sha256("global:<ix>")[..8] — verified against the IDL.
export const DISCRIMINATORS: Record<string, number[]> = {
  create_market: [103, 226, 97, 235, 200, 188, 251, 254],
  stake: [206, 176, 202, 18, 200, 209, 179, 108],
  settle: [175, 42, 185, 87, 144, 131, 102, 212],
  claim: [62, 198, 214, 193, 213, 159, 108, 210],
};

// Program custom errors (code = 6000 + variant index) — so a simulated stake that
// fails closed reports the exact reason, not a bare number.
export const SETTLEMENT_ERRORS: Record<number, string> = {
  6000: "MarketNotOpen",
  6001: "MarketNotSettled",
  6002: "ZeroStake",
  6003: "NotWinningSide",
  6004: "AlreadyClaimed",
  6005: "NoWinningStake",
  6006: "WrongOracleProgram",
  6007: "Overflow",
  6008: "OracleNoReturnData",
  6009: "OracleReturnWrongProgram",
  6010: "OracleBadReturnData",
  6011: "FixtureMismatch",
  6012: "StatMismatch",
  6013: "MultiStatNotAllowed",
  6014: "PeriodMismatch",
};

export function toLamports(sol: number): bigint {
  return BigInt(Math.round(sol * 1e9));
}

export function lamportsToSol(lamports: bigint | number): number {
  return Number(lamports) / 1e9;
}

// ── PDA seeds (mirror forge-markets/src/interface.rs) ──────────────────────────
const enc = new TextEncoder();
const MARKET_SEED = enc.encode("market");
const VAULT_SEED = enc.encode("vault");
const POSITION_SEED = enc.encode("position");

export function marketPda(fixtureId: bigint, statKey: number): [PublicKey, number] {
  const seed = new ByteWriter().i64(fixtureId).build();
  const key = new ByteWriter().u32(statKey).build();
  return PublicKey.findProgramAddressSync(
    [MARKET_SEED, seed, key],
    FORGE_PROGRAM_ID,
  );
}

export function vaultPda(market: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [VAULT_SEED, market.toBytes()],
    FORGE_PROGRAM_ID,
  );
}

export function positionPda(
  market: PublicKey,
  staker: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [POSITION_SEED, market.toBytes(), staker.toBytes()],
    FORGE_PROGRAM_ID,
  );
}

// ── Decoded account shapes (public on-chain state only) ────────────────────────
export interface TraderPredicate {
  threshold: number;
  comparison: Comparison;
}

export interface MarketAccount {
  address: string;
  fixtureId: bigint;
  statKey: number;
  predicate: TraderPredicate;
  vault: string;
  stakeYes: bigint;
  stakeNo: bigint;
  state: MarketStateName;
  winner: Side; // meaningful only once state === "Settled"
  authority: string;
  potLamports: bigint;
}

export interface PositionAccount {
  address: string;
  market: string;
  owner: string;
  side: Side;
  amount: bigint;
  claimed: boolean;
}

// Byte size of each account (8-byte disc + Borsh body) — used as a getProgramAccounts
// dataSize filter, so we never need the account discriminator.
export const MARKET_ACCOUNT_SIZE = 142;
export const POSITION_ACCOUNT_SIZE = 99;

/** Decode a `Market` account. Field order mirrors `state.rs` exactly. */
export function decodeMarket(address: string, data: Uint8Array): MarketAccount {
  if (data.length < MARKET_ACCOUNT_SIZE) {
    throw new Error("market account too small to decode");
  }
  const r = new ByteReader(data, 8); // skip the Anchor discriminator
  const fixtureId = r.i64();
  const statKey = r.u32();
  const threshold = r.i32();
  const comparison = r.u8() as Comparison;
  const vault = new PublicKey(r.fixed(32)).toBase58();
  const stakeYes = r.u64();
  const stakeNo = r.u64();
  const state: MarketStateName = r.u8() === 0 ? "Open" : "Settled";
  const winner: Side = r.u8() === 0 ? "Yes" : "No";
  const authority = new PublicKey(r.fixed(32)).toBase58();
  return {
    address,
    fixtureId,
    statKey,
    predicate: { threshold, comparison },
    vault,
    stakeYes,
    stakeNo,
    state,
    winner,
    authority,
    potLamports: stakeYes + stakeNo,
  };
}

/** Decode a `Position` account. Field order mirrors `state.rs` exactly. */
export function decodePosition(address: string, data: Uint8Array): PositionAccount {
  if (data.length < POSITION_ACCOUNT_SIZE) {
    throw new Error("position account too small to decode");
  }
  const r = new ByteReader(data, 8);
  const market = new PublicKey(r.fixed(32)).toBase58();
  const owner = new PublicKey(r.fixed(32)).toBase58();
  const side: Side = r.u8() === 0 ? "Yes" : "No";
  const amount = r.u64();
  const claimed = r.bool();
  return { address, market, owner, side, amount, claimed };
}

/**
 * Build the `stake` instruction — the interactive place-a-bet action.
 * Account order MUST match `#[derive(Accounts)] Stake`:
 *   market (w), position (w), vault (w), staker (signer, w), system (r).
 * data = disc("stake") + u8(side) + u64(amount).
 */
export function buildStakeIx(params: {
  fixtureId: bigint;
  statKey: number;
  staker: PublicKey;
  side: Side;
  amountLamports: bigint;
}): { instruction: TransactionInstruction; market: PublicKey; position: PublicKey; vault: PublicKey } {
  const { fixtureId, statKey, staker, side, amountLamports } = params;
  if (amountLamports <= 0n) throw new Error("stake amount must be positive");
  const [market] = marketPda(fixtureId, statKey);
  const [vault] = vaultPda(market);
  const [position] = positionPda(market, staker);

  const data = new ByteWriter()
    .bytes(DISCRIMINATORS.stake)
    .u8(SIDE_INDEX[side])
    .u64(amountLamports)
    .build();

  const instruction = new TransactionInstruction({
    programId: FORGE_PROGRAM_ID,
    keys: [
      { pubkey: market, isSigner: false, isWritable: true },
      { pubkey: position, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: staker, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(data),
  });

  return { instruction, market, position, vault };
}

/** Map an Anchor custom-error code from a simulation into its program error name. */
export function settlementErrorName(code: number): string | null {
  return SETTLEMENT_ERRORS[code] ?? null;
}

/** Extract an Anchor custom-error code from a simulation/transaction err object,
 * e.g. `{ InstructionError: [0, { Custom: 6000 }] }` → `6000`. */
export function customErrorCode(err: unknown): number | null {
  const instructionError = (err as { InstructionError?: [number, unknown] })
    ?.InstructionError;
  if (
    Array.isArray(instructionError) &&
    instructionError[1] &&
    typeof instructionError[1] === "object" &&
    "Custom" in instructionError[1]
  ) {
    return (instructionError[1] as { Custom: number }).Custom;
  }
  return null;
}
