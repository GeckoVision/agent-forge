//! `settle(ts, fixture_summary, fixture_proof, main_tree_proof, stat_a, stat_b?, op?)`
//! — the trustless heart of the program, now a THIN consumer of settlement-core.
//!
//! forge-markets no longer owns the trustless core. `settle` reads its market's
//! `(fixture_id, stat_key, period, predicate)`, builds a `PredicateQuery`, and CPIs
//! `settlement_core::resolve`. The ENGINE enforces the F1 binding (fixture / stat /
//! single-stat / period), CPIs `txoracle::validate_stat`, and returns the certified
//! bool — or reverts on a tampered proof (the revert propagates through the engine
//! into `settle`, the whole trust guarantee). forge-markets keeps only the
//! outcome-application half: map the bool to a `Side`, write `winner`/`state`.
//!
//!   - engine `Ok(true)`  ⇒ predicate held        ⇒ `winner = Yes`, `state = Settled`.
//!   - engine `Ok(false)` ⇒ predicate did NOT hold ⇒ `winner = No`,  `state = Settled`.
//!   - engine `Err`       ⇒ tampered/undecodable/unbound ⇒ `settle` reverts, Open.
//!
//! The F1 binding that used to live here (former settle.rs:71-91) now lives ONCE in
//! the engine, operating on the query — forge-markets no longer duplicates it.

use anchor_lang::prelude::*;
use settlement_core::{
    BinaryExpression, PredicateQuery, ProofNode, ScoresBatchSummary, StatTerm, TXORACLE_PROGRAM_ID,
};

use crate::errors::SettlementError;
use crate::interface::MARKET_SEED;
use crate::state::{Market, MarketState, Side};

#[derive(Accounts)]
pub struct Settle<'info> {
    #[account(
        mut,
        seeds = [
            MARKET_SEED,
            &market.fixture_id.to_le_bytes(),
            &market.stat_key.to_le_bytes(),
        ],
        bump = market.bump,
        constraint = market.state == MarketState::Open @ SettlementError::MarketNotOpen,
    )]
    pub market: Account<'info, Market>,

    /// CHECK: The settlement-core ENGINE program. Pinned by address so a caller
    /// cannot redirect the `resolve` CPI to a look-alike engine (the engine in turn
    /// pins txoracle — defense in depth at both hops).
    #[account(address = settlement_core::ID @ SettlementError::WrongEngineProgram)]
    pub settlement_engine: UncheckedAccount<'info>,

    /// CHECK: The txoracle-owned daily-roots account. Threaded through settle →
    /// engine → txoracle; this program never interprets its bytes.
    pub daily_scores_merkle_roots: UncheckedAccount<'info>,

    /// CHECK: The txoracle program. Pinned by address here too (belt-and-braces
    /// over the engine's own pin) so the wrong-oracle rejection stays early.
    #[account(address = TXORACLE_PROGRAM_ID @ SettlementError::WrongOracleProgram)]
    pub txoracle_program: UncheckedAccount<'info>,
}

#[allow(clippy::too_many_arguments)]
pub fn settle_handler(
    ctx: Context<Settle>,
    ts: i64,
    fixture_summary: ScoresBatchSummary,
    fixture_proof: Vec<ProofNode>,
    main_tree_proof: Vec<ProofNode>,
    stat_a: StatTerm,
    stat_b: Option<StatTerm>,
    op: Option<BinaryExpression>,
) -> Result<()> {
    // Build the market's declared query — the engine binds the caller's oracle args
    // to exactly this (fixture, stat, period, predicate) before proving anything.
    let market = &ctx.accounts.market;
    let query = PredicateQuery {
        fixture_id: market.fixture_id,
        stat_key: market.stat_key,
        period: market.period,
        predicate: market.predicate,
    };

    // CPI the engine: F1 binding + txoracle CPI + fail-closed decode happen inside.
    // A tampered/unbound proof makes this return Err → settle reverts. A well-formed,
    // bound proof returns Ok(bool): true = predicate held (YES), false = did not (NO).
    let predicate_held = settlement_core::client::resolve(
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

    // Outcome-application half (kept local — the Gorilla-specific part).
    let winner = if predicate_held { Side::Yes } else { Side::No };
    let market = &mut ctx.accounts.market;
    market.winner = winner;
    market.state = MarketState::Settled;

    emit!(MarketSettled {
        market: market.key(),
        winner,
        ts,
    });
    Ok(())
}

#[event]
pub struct MarketSettled {
    pub market: Pubkey,
    pub winner: Side,
    pub ts: i64,
}
