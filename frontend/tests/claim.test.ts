import { describe, expect, it } from "vitest";
import { PublicKey } from "@solana/web3.js";

import {
  buildClaimIx,
  DISCRIMINATORS,
  marketPda,
  positionPda,
  vaultPda,
} from "@/lib/solana/forge-client";
import { FORGE_PROGRAM_ID } from "@/lib/solana/config";
import {
  MARKET_ADDRESS,
  MARKET_EXPECTED,
  POSITION_ADDRESS,
  POSITION_EXPECTED,
} from "./fixtures";

// The real devnet staker that owns the POSITION fixture — so the derivation
// below is verified against an account that actually exists on chain.
const STAKER = new PublicKey(POSITION_EXPECTED.owner);

describe("buildClaimIx — first-call-correct wire format", () => {
  // Layout cross-checked against BOTH sources of truth:
  //   backend/gorilla/forge_client.py `build_claim_ix` and
  //   program/programs/forge-markets/src/instructions/claim.rs `Claim<'info>`.
  // They agree: market (r), position (w), vault (w), staker (s,w), system (r),
  // and the data is the bare 8-byte discriminator — `claim` takes no args.
  const { instruction, market, position, vault } = buildClaimIx({
    fixtureId: MARKET_EXPECTED.fixtureId,
    statKey: MARKET_EXPECTED.statKey,
    staker: STAKER,
  });

  it("targets the forge program", () => {
    expect(instruction.programId.equals(FORGE_PROGRAM_ID)).toBe(true);
  });

  it("is exactly the 8-byte `claim` discriminator — no args", () => {
    // sha256("global:claim")[..8], pinned as hex so any drift is byte-visible.
    expect(Buffer.from(instruction.data).toString("hex")).toBe("3ec6d6c1d59f6cd2");
    expect(instruction.data.length).toBe(8);
    expect(Array.from(instruction.data)).toEqual(DISCRIMINATORS.claim);
  });

  it("has the correct account order + signer/writable flags", () => {
    const keys = instruction.keys;
    expect(keys).toHaveLength(5);
    // market is READ-ONLY in claim (unlike stake) — the program only reads the
    // settled state; lamports move from the vault, and only position.claimed flips.
    expect(keys[0].pubkey.equals(market)).toBe(true);
    expect(!keys[0].isWritable && !keys[0].isSigner).toBe(true);
    expect(keys[1].pubkey.equals(position)).toBe(true);
    expect(keys[1].isWritable && !keys[1].isSigner).toBe(true);
    expect(keys[2].pubkey.equals(vault)).toBe(true);
    expect(keys[2].isWritable && !keys[2].isSigner).toBe(true);
    expect(keys[3].pubkey.equals(STAKER)).toBe(true);
    expect(keys[3].isSigner && keys[3].isWritable).toBe(true);
    expect(!keys[4].isSigner && !keys[4].isWritable).toBe(true);
  });

  it("derives the REAL devnet market + position accounts", () => {
    expect(market.toBase58()).toBe(MARKET_ADDRESS);
    // Position PDA seeds are ["position", market, staker] (interface.rs) —
    // verified here against the captured on-chain position account address.
    expect(position.toBase58()).toBe(POSITION_ADDRESS);
    const [expectedPos] = positionPda(new PublicKey(MARKET_ADDRESS), STAKER);
    expect(position.toBase58()).toBe(expectedPos.toBase58());
  });

  it("derives market and vault the same way the read path does", () => {
    const [m] = marketPda(MARKET_EXPECTED.fixtureId, MARKET_EXPECTED.statKey);
    const [v] = vaultPda(m);
    expect(market.toBase58()).toBe(m.toBase58());
    expect(vault.toBase58()).toBe(v.toBase58());
  });
});
