//! settlement-core — the reusable trustless settlement PRIMITIVE, shipped as a
//! thin ENGINE program others CPI (SETTLEMENT-ENGINE.md, option A).
//!
//! ── What it is ───────────────────────────────────────────────────────────────
//! A consumer contract passes a DECLARED `PredicateQuery` (what it thinks it is
//! resolving) plus the raw oracle args; the engine binds the args to that query
//! (the F1 checks), CPIs `txoracle::validate_stat`, and returns the certified bool
//! — or reverts. A consumer physically cannot obtain an outcome for an unbound
//! proof. The engine adds NO cryptographic trust over CPIing txoracle directly
//! (txoracle is the trust root); its reason to exist is a SINGLE audited F1-binding
//! every consumer is forced through, and one deployment to audit.
//!
//! The trust boundary, stated plainly: the engine guarantees the returned bool
//! corresponds to exactly the (fixture, stat, period, predicate) the consumer
//! NAMED; the consumer guarantees that tuple is its own market's/policy's.
//!
//! ── The two-hop return-data contract (proven under Mollusk) ──────────────────
//! `resolve` CPIs txoracle (which sets return data), reads it IMMEDIATELY, then
//! returns `Ok(bool)` — Anchor re-`set_return_data`s the engine's bool. A consumer
//! that CPIs `resolve` and reads `get_return_data()` immediately (no intervening
//! CPI) receives the ENGINE's bool. See `cpi::resolve` and the gate suite.

#![allow(unexpected_cfgs)]

use anchor_lang::prelude::*;

pub mod errors;
pub mod txoracle_cpi;

use errors::EngineError;
pub use txoracle_cpi::{
    BinaryExpression, Comparison, ProofNode, ScoreStat, ScoresBatchSummary, ScoresUpdateStats,
    StatTerm, TraderPredicate, TXORACLE_PROGRAM_ID,
};

declare_id!("9S6SwSp5ShrDV7NLhtUCqttHTgXTPp7PCNuWuSeHjEjT");

/// Anchor discriminator for `settlement_core::resolve` (sha256("global:resolve")[..8]).
/// Consumers building the CPI by hand pin this; `cpi::resolve` uses it internally.
pub const RESOLVE_DISCRIMINATOR: [u8; 8] = [246, 150, 236, 206, 108, 63, 58, 10];

/// Upper bound on nodes in any single supplied Merkle proof.
///
/// Determinism fix (SETTLEMENT-ENGINE.md "proof-length bound"): a variable-length
/// proof means variable CU, so a caller could otherwise make the same settle cost
/// an unpredictable amount and blow a fixed `set_compute_unit_limit`. 32 sibling
/// hashes prove a leaf under a tree of 2^32 leaves — far beyond any real TxODDS
/// daily fixture/event tree. Conservative on purpose; tighten once the live tree
/// height is measured on devnet. Bounds ALL three proofs (fixture, main-tree,
/// per-stat) uniformly.
pub const MAX_PROOF_NODES: usize = 32;

/// What a consumer DECLARES it is resolving. The engine asserts the caller-supplied
/// oracle args match this — a consumer cannot get an outcome for an unbound proof.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct PredicateQuery {
    /// engine asserts `fixture_summary.fixture_id == this`.
    pub fixture_id: i64,
    /// engine asserts `stat_a.stat_to_prove.key == this`.
    pub stat_key: u32,
    /// engine asserts `stat_a.stat_to_prove.period == this`.
    pub period: i32,
    /// The YES condition; forwarded to txoracle (the consumer never lets the caller
    /// override the condition being proven).
    pub predicate: TraderPredicate,
}

#[program]
pub mod settlement_core {
    use super::*;

    /// Resolve `query` against TxODDS. Returns `Ok(true)` (predicate held),
    /// `Ok(false)` (did not hold), or `Err` (tampered/undecodable → the caller
    /// reverts). `stat_b`/`op` are FORBIDDEN (single-stat v1).
    #[allow(clippy::too_many_arguments)]
    pub fn resolve(
        ctx: Context<Resolve>,
        query: PredicateQuery,
        ts: i64,
        fixture_summary: ScoresBatchSummary,
        fixture_proof: Vec<ProofNode>,
        main_tree_proof: Vec<ProofNode>,
        stat_a: StatTerm,
        stat_b: Option<StatTerm>,
        op: Option<BinaryExpression>,
    ) -> Result<bool> {
        // ── F1: bind the caller-supplied oracle args to the DECLARED query BEFORE
        // the CPI. Moved verbatim (semantics) from forge-markets settle.rs:71-91,
        // now operating on `query` instead of a Market account. `resolve` is
        // permissionless; validate_stat only proves "this stat is genuine in a
        // genuine fixture" and has NO concept of the query — so without these an
        // attacker submits a genuine proof for a DIFFERENT data point whose value
        // yields their preferred outcome. ──
        require!(
            fixture_summary.fixture_id == query.fixture_id,
            EngineError::FixtureMismatch
        );
        require!(
            stat_a.stat_to_prove.key == query.stat_key,
            EngineError::StatMismatch
        );
        // Single-stat only: a two-stat Add/Subtract could move the evaluated value
        // off the bound stat_key.
        require!(
            stat_b.is_none() && op.is_none(),
            EngineError::MultiStatNotAllowed
        );
        // Period binds the proof to the query's phase (e.g. full-time, not half-time).
        require!(
            stat_a.stat_to_prove.period == query.period,
            EngineError::PeriodMismatch
        );

        // Determinism: bound every supplied proof length (fixed CU budget).
        require!(
            fixture_proof.len() <= MAX_PROOF_NODES
                && main_tree_proof.len() <= MAX_PROOF_NODES
                && stat_a.stat_proof.len() <= MAX_PROOF_NODES,
            EngineError::ProofTooLong
        );

        // Trustless outcome: the oracle CPI decides. A tampered proof → CPI Err →
        // this reverts. Well-formed → Ok(bool). The bool becomes this instruction's
        // return data on `Ok` (Anchor), which the consumer reads.
        txoracle_cpi::cpi_validate_stat(
            &ctx.accounts.txoracle_program.to_account_info(),
            &ctx.accounts.daily_scores_merkle_roots.to_account_info(),
            ts,
            &fixture_summary,
            &fixture_proof,
            &main_tree_proof,
            &query.predicate,
            &stat_a,
            &stat_b,
            &op,
        )
    }
}

#[derive(Accounts)]
pub struct Resolve<'info> {
    /// CHECK: The txoracle-owned account holding the daily Merkle roots. Passed
    /// straight through to `validate_stat`; the engine never interprets its bytes.
    pub daily_scores_merkle_roots: UncheckedAccount<'info>,

    /// CHECK: The txoracle program. Pinned by address so a caller cannot redirect
    /// the inner CPI to a look-alike program.
    #[account(address = TXORACLE_PROGRAM_ID @ EngineError::WrongOracleProgram)]
    pub txoracle_program: UncheckedAccount<'info>,
}

/// Consumer-facing CPI helper. A consumer contract calls THIS to resolve a query —
/// it re-implements NO CPI or binding logic. It builds the `resolve` instruction,
/// invokes the engine, and reads the returned bool fail-closed (the same
/// no-return-data / wrong-program / bad-bytes hard errors the engine applies to
/// txoracle, now applied to the engine's own return data).
///
/// `engine_program`, `daily_scores_merkle_roots`, `txoracle_program` are the three
/// AccountInfos the consumer must thread through (the last two are the engine's
/// `Resolve` accounts, in order; the engine account itself makes the CPI callable).
///
/// Named `client` (not `cpi`) because Anchor's `#[program]` macro auto-generates a
/// `cpi` module; this is our explicit fail-closed wrapper over it.
pub mod client {
    use super::*;
    use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
    use anchor_lang::solana_program::program::{get_return_data, invoke};

    #[allow(clippy::too_many_arguments)]
    pub fn resolve<'info>(
        engine_program: &AccountInfo<'info>,
        daily_scores_merkle_roots: &AccountInfo<'info>,
        txoracle_program: &AccountInfo<'info>,
        query: &PredicateQuery,
        ts: i64,
        fixture_summary: &ScoresBatchSummary,
        fixture_proof: &[ProofNode],
        main_tree_proof: &[ProofNode],
        stat_a: &StatTerm,
        stat_b: &Option<StatTerm>,
        op: &Option<BinaryExpression>,
    ) -> Result<bool> {
        let mut data = Vec::with_capacity(320);
        data.extend_from_slice(&RESOLVE_DISCRIMINATOR);
        query.serialize(&mut data)?;
        ts.serialize(&mut data)?;
        fixture_summary.serialize(&mut data)?;
        fixture_proof.to_vec().serialize(&mut data)?;
        main_tree_proof.to_vec().serialize(&mut data)?;
        stat_a.serialize(&mut data)?;
        stat_b.serialize(&mut data)?;
        op.serialize(&mut data)?;

        let ix = Instruction {
            program_id: crate::ID,
            accounts: vec![
                AccountMeta::new_readonly(*daily_scores_merkle_roots.key, false),
                AccountMeta::new_readonly(*txoracle_program.key, false),
            ],
            data,
        };

        // The engine CPI. Internally it CPIs txoracle then returns Ok(bool); Anchor
        // re-sets return data to the engine's bool. Read it IMMEDIATELY — no CPI
        // between this invoke and get_return_data (the two-hop contract).
        invoke(
            &ix,
            &[
                engine_program.clone(),
                daily_scores_merkle_roots.clone(),
                txoracle_program.clone(),
            ],
        )?;

        // Fail-closed decode of the ENGINE's return data (mirrors the txoracle decode).
        let (returning_program, return_data) =
            get_return_data().ok_or(EngineError::OracleNoReturnData)?;
        require_keys_eq!(
            returning_program,
            crate::ID,
            EngineError::OracleReturnWrongProgram
        );
        let predicate_held =
            bool::try_from_slice(&return_data).map_err(|_| EngineError::OracleBadReturnData)?;
        Ok(predicate_held)
    }
}
