/**
 * The custody policy the signing wallet is actually authorized with.
 *
 * These are NOT UI constants. The artifact is generated from the backend's real
 * `ChainPolicy` (`gorilla.staking.chain_policy` + the `watch` defaults) by
 * `backend/scripts/export_web_artifacts.py`, so the cap and the program/instruction
 * allow-list the page prints are the ones the signer enforces before a signature exists.
 * Change the policy in Python and regenerate — never edit the numbers here.
 */

import policyJson from "@/data/agent-policy.json";

export interface PolicyBinding {
  purpose: string;
  programId: string;
  instruction: string;
}

export interface AgentPolicy {
  source: string;
  generatedAt: string;
  /** Total spend cap across the authorized session, in SOL. */
  maxSpendSol: number;
  /** Risk-policy stake for a single bet, in SOL. */
  stakePerBetSol: number;
  /** Cumulative exposure cap for one fixture, in SOL. */
  maxPerFixtureSol: number;
  allow: PolicyBinding[];
}

export const POLICY = policyJson as AgentPolicy;

/** Short program label — the full id stays visible in the UI for auditability. */
export function shortProgram(programId: string): string {
  return `${programId.slice(0, 4)}…${programId.slice(-4)}`;
}
