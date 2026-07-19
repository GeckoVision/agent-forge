//! gate-engine — GATE PROBE ONLY, never deployed.
//!
//! Purpose: falsify the #1 technical risk of the settlement-engine extraction
//! (SETTLEMENT-ENGINE.md, "Return-data across the CPI hop"): after an engine
//! program CPIs `txoracle::validate_stat`, `get_return_data()` holds txoracle's
//! bytes; the engine then returns `Ok(bool)`, which Anchor MUST re-`set_return_data`
//! so the *consumer* that CPIs the engine reads the ENGINE's bool — not txoracle's
//! leftover — when it reads immediately, with no intervening CPI.
//!
//! To make the probe DISCRIMINATING, this engine returns `Ok(!oracle_held)` — the
//! NEGATION of what the oracle certified. If Anchor re-sets return data on the
//! engine's `Result<bool>` return, the consumer reads the negated value; if the
//! consumer instead saw txoracle's leftover bytes, it would read the un-negated
//! value and the gate test would fail. The real `settlement-core` engine returns
//! the oracle bool verbatim (no negation) — the negation exists ONLY to prove the
//! overwrite actually happens.

#![allow(unexpected_cfgs)]

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::{get_return_data, invoke};

declare_id!("9G418GNv2hnfNsGZwJ8rMJeJuqn6ng5VkL9tyRQodp73");

/// The txoracle (mock) program id — same constant forge-markets pins.
pub const TXORACLE_PROGRAM_ID: Pubkey = pubkey!("6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J");
pub const VALIDATE_STAT_DISCRIMINATOR: [u8; 8] = [107, 197, 232, 90, 191, 136, 105, 185];

// ── Minimal mirrored validate_stat arg tree (byte-exact with mock-txoracle) ──
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ScoresUpdateStats {
    pub update_count: i32,
    pub min_timestamp: i64,
    pub max_timestamp: i64,
}
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ScoresBatchSummary {
    pub fixture_id: i64,
    pub update_stats: ScoresUpdateStats,
    pub events_sub_tree_root: [u8; 32],
}
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ProofNode {
    pub hash: [u8; 32],
    pub is_right_sibling: bool,
}
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub enum Comparison {
    GreaterThan,
    LessThan,
    EqualTo,
}
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct TraderPredicate {
    pub threshold: i32,
    pub comparison: Comparison,
}
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ScoreStat {
    pub key: u32,
    pub value: i32,
    pub period: i32,
}
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct StatTerm {
    pub stat_to_prove: ScoreStat,
    pub event_stat_root: [u8; 32],
    pub stat_proof: Vec<ProofNode>,
}
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub enum BinaryExpression {
    Add,
    Subtract,
}

#[error_code]
pub enum GateError {
    #[msg("roots account too small")]
    RootAccountTooSmall,
    #[msg("oracle set no return data")]
    OracleNoReturnData,
    #[msg("oracle return data from wrong program")]
    OracleReturnWrongProgram,
    #[msg("oracle return data not a decodable bool")]
    OracleBadReturnData,
}

#[program]
pub mod gate_engine {
    use super::*;

    /// CPI mock-txoracle with a stat value of `steer` against `GreaterThan 1`,
    /// read the certified bool, and return its NEGATION (see module docs).
    pub fn relay(ctx: Context<Relay>, steer: i32) -> Result<bool> {
        // Match the seeded on-chain root so the mock does not revert on root mismatch.
        let root = {
            let data = ctx.accounts.daily_scores_merkle_roots.try_borrow_data()?;
            require!(data.len() >= 32, GateError::RootAccountTooSmall);
            let mut r = [0u8; 32];
            r.copy_from_slice(&data[0..32]);
            r
        };

        let summary = ScoresBatchSummary {
            fixture_id: 1,
            update_stats: ScoresUpdateStats {
                update_count: 1,
                min_timestamp: 0,
                max_timestamp: 0,
            },
            events_sub_tree_root: root,
        };
        let predicate = TraderPredicate {
            threshold: 1,
            comparison: Comparison::GreaterThan,
        };
        let stat_a = StatTerm {
            stat_to_prove: ScoreStat {
                key: 0,
                value: steer,
                period: 0,
            },
            event_stat_root: root,
            stat_proof: vec![],
        };

        let mut data = Vec::with_capacity(256);
        data.extend_from_slice(&VALIDATE_STAT_DISCRIMINATOR);
        0i64.serialize(&mut data)?; // ts
        summary.serialize(&mut data)?;
        Vec::<ProofNode>::new().serialize(&mut data)?; // fixture_proof
        Vec::<ProofNode>::new().serialize(&mut data)?; // main_tree_proof
        predicate.serialize(&mut data)?;
        stat_a.serialize(&mut data)?;
        None::<StatTerm>.serialize(&mut data)?;
        None::<BinaryExpression>.serialize(&mut data)?;

        let ix = Instruction {
            program_id: TXORACLE_PROGRAM_ID,
            accounts: vec![AccountMeta::new_readonly(
                *ctx.accounts.daily_scores_merkle_roots.key,
                false,
            )],
            data,
        };
        // The INNER CPI sets return data = txoracle's bool.
        invoke(
            &ix,
            &[
                ctx.accounts.daily_scores_merkle_roots.to_account_info(),
                ctx.accounts.txoracle_program.to_account_info(),
            ],
        )?;

        let (returning, bytes) = get_return_data().ok_or(GateError::OracleNoReturnData)?;
        require_keys_eq!(
            returning,
            TXORACLE_PROGRAM_ID,
            GateError::OracleReturnWrongProgram
        );
        let oracle_held =
            bool::try_from_slice(&bytes).map_err(|_| GateError::OracleBadReturnData)?;

        // GATE PROBE: return the NEGATION. On our return, Anchor must
        // set_return_data(!oracle_held), overwriting txoracle's leftover bytes.
        Ok(!oracle_held)
    }
}

#[derive(Accounts)]
pub struct Relay<'info> {
    /// CHECK: passthrough root store, read for its first 32 bytes only.
    pub daily_scores_merkle_roots: UncheckedAccount<'info>,
    /// CHECK: pinned to the txoracle id.
    #[account(address = TXORACLE_PROGRAM_ID)]
    pub txoracle_program: UncheckedAccount<'info>,
}
