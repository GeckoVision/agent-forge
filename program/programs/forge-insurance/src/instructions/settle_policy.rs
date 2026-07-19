//! `settle_policy(ts, fixture_summary, fixture_proof, main_tree_proof, stat_a, ..)`
//! — record whether the insured EVENT occurred, decided by the SAME settlement-core
//! engine forge-markets uses. This handler re-implements NO CPI or binding logic: it
//! builds a `PredicateQuery` from the policy and calls `settlement_core::client::resolve`.
//! The engine enforces the F1 binding + CPIs txoracle + fail-closed decode; a tampered
//! or unbound proof makes `resolve` Err, which propagates and reverts this settle.
//!
//!   - engine `Ok(true)`  ⇒ the event occurred      ⇒ event_occurred = true.
//!   - engine `Ok(false)` ⇒ the event did NOT occur ⇒ event_occurred = false.
//!   - engine `Err`       ⇒ tampered/unbound        ⇒ settle reverts, policy Funded.

use anchor_lang::prelude::*;
use settlement_core::{
    BinaryExpression, PredicateQuery, ProofNode, ScoresBatchSummary, StatTerm, TXORACLE_PROGRAM_ID,
};

use crate::errors::InsuranceError;
use crate::interface::POLICY_SEED;
use crate::state::{Policy, PolicyState};

#[derive(Accounts)]
pub struct SettlePolicy<'info> {
    #[account(
        mut,
        seeds = [
            POLICY_SEED,
            &policy.fixture_id.to_le_bytes(),
            &policy.stat_key.to_le_bytes(),
            policy.insured.as_ref(),
        ],
        bump = policy.bump,
        constraint = policy.state == PolicyState::Funded @ InsuranceError::PolicyNotFunded,
    )]
    pub policy: Account<'info, Policy>,

    /// CHECK: the settlement-core ENGINE, pinned by address (defense in depth over
    /// the engine's own txoracle pin).
    #[account(address = settlement_core::ID @ InsuranceError::WrongEngineProgram)]
    pub settlement_engine: UncheckedAccount<'info>,

    /// CHECK: txoracle daily-roots account, threaded through to the engine → txoracle.
    pub daily_scores_merkle_roots: UncheckedAccount<'info>,

    /// CHECK: the txoracle program, pinned by address.
    #[account(address = TXORACLE_PROGRAM_ID @ InsuranceError::WrongOracleProgram)]
    pub txoracle_program: UncheckedAccount<'info>,
}

#[allow(clippy::too_many_arguments)]
pub fn settle_policy_handler(
    ctx: Context<SettlePolicy>,
    ts: i64,
    fixture_summary: ScoresBatchSummary,
    fixture_proof: Vec<ProofNode>,
    main_tree_proof: Vec<ProofNode>,
    stat_a: StatTerm,
    stat_b: Option<StatTerm>,
    op: Option<BinaryExpression>,
) -> Result<()> {
    let policy = &ctx.accounts.policy;
    let query = PredicateQuery {
        fixture_id: policy.fixture_id,
        stat_key: policy.stat_key,
        period: policy.period,
        predicate: policy.predicate,
    };

    // The SAME engine call forge-markets makes — proving reuse. No binding/CPI here.
    let event_occurred = settlement_core::client::resolve(
        &ctx.accounts.settlement_engine.to_account_info(),
        &ctx.accounts.daily_scores_merkle_roots.to_account_info(),
        &ctx.accounts.txoracle_program.to_account_info(),
        &query,
        ts,
        &fixture_summary,
        &fixture_proof,
        &main_tree_proof,
        &stat_a,
        &stat_b,
        &op,
    )?;

    let policy = &mut ctx.accounts.policy;
    policy.event_occurred = event_occurred;
    policy.state = PolicyState::Settled;

    emit!(PolicySettled {
        policy: policy.key(),
        event_occurred,
        ts,
    });
    Ok(())
}

#[event]
pub struct PolicySettled {
    pub policy: Pubkey,
    pub event_occurred: bool,
    pub ts: i64,
}
