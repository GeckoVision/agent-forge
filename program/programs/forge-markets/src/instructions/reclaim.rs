//! `reclaim()` — a timeout refund that unsticks an unsettleable market.
//!
//! Closes the stranded-stake hole from the SETTLEMENT-ENGINE.md risk table: if NO
//! oracle root is ever published for a fixture, `settle` can never succeed and the
//! pot sits in the vault forever. `reclaim` lets each staker pull back their OWN
//! stake once the market has been Open well past its betting cutoff.
//!
//! ── The gate: `Open` AND `lock_ts != 0` AND `now >= lock_ts + RECLAIM_DELAY` ──
//!   * `Open` — a Settled market pays winners via `claim`; reclaim refuses it
//!     (`MarketNotOpen`). See the honest boundary note below.
//!   * `lock_ts != 0` — a legacy / opted-out market (no cutoff) has NO reference
//!     point for the timeout, so it has NO reclaim window (`ReclaimUnavailable`).
//!     This keeps legacy behavior byte-identical AND is a safety property: without
//!     it, a `lock_ts == 0` market would compute a timeout of `0 + RECLAIM_DELAY`
//!     (~Jan 1970, always in the past) and be INSTANTLY reclaimable — letting a
//!     staker yank their stake out of a live market at will.
//!   * `now >= lock_ts + RECLAIM_DELAY` — a deliberately generous delay (7 days)
//!     chosen so reclaim can NEVER race a legitimate permissionless settle: anyone
//!     can settle the instant a valid proof exists, so a week-long window means
//!     reclaim only ever fires when settlement is genuinely impossible, not late.
//!
//! ── The honest boundary (reclaim does NOT close every strand) ──
//! reclaim only reaches markets still `Open`. The OTHER stranded-fund case — a
//! market that SETTLED with an empty winning side (`claim.rs` `NoWinningStake`) —
//! is a *Settled* terminal state, which this Open-gated instruction deliberately
//! does not touch. Refunding a zero-winner settled market is different logic
//! (return stakes after a real, adverse outcome — not a timeout) and would need
//! its own instruction; expanding reclaim to cover it is neither cheap nor safe
//! within this model, so the boundary is documented rather than papered over.
//!
//! Pull-payment + checks-effects-interactions: the Position is marked reclaimed
//! (reusing `Position.claimed` as the double-spend guard) and the side's stake
//! decremented BEFORE the vault transfers — so a re-entrant callee can never see an
//! un-reclaimed position, and the `pot == vault` invariant survives a later settle.

use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer, Transfer};

use crate::errors::SettlementError;
use crate::interface::{MARKET_SEED, POSITION_SEED, VAULT_SEED};
use crate::state::{Market, MarketState, Position, Side};

/// Timeout before a stake can be reclaimed, measured from the betting cutoff.
/// 7 days: long enough that it can never beat an honest permissionless settle (a
/// valid proof settles the moment it exists), so reclaim only unsticks a market
/// that is genuinely unsettleable — never one that is merely awaiting settlement.
pub const RECLAIM_DELAY: i64 = 7 * 24 * 60 * 60; // 604_800 seconds

#[derive(Accounts)]
pub struct Reclaim<'info> {
    #[account(
        mut,
        seeds = [
            MARKET_SEED,
            &market.fixture_id.to_le_bytes(),
            &market.stat_key.to_le_bytes(),
        ],
        bump = market.bump,
        // Reclaim is a REFUND, only for a market still Open (never Settled — a
        // settled market pays winners via `claim`). This constraint is also what
        // keeps reclaim off the Settled zero-winner strand (the honest boundary).
        constraint = market.state == MarketState::Open @ SettlementError::MarketNotOpen,
    )]
    pub market: Account<'info, Market>,

    #[account(
        mut,
        seeds = [POSITION_SEED, market.key().as_ref(), staker.key().as_ref()],
        bump = position.bump,
        // The Position PDA seeds already bind `staker`, so a signer can only reach
        // their OWN position — this owner check is redundant on purpose (defense in
        // depth over seed derivation). A mismatch is really "not your position".
        constraint = position.owner == staker.key() @ SettlementError::NotWinningSide,
    )]
    pub position: Account<'info, Position>,

    #[account(
        mut,
        seeds = [VAULT_SEED, market.key().as_ref()],
        bump = market.vault_bump,
    )]
    pub vault: SystemAccount<'info>,

    #[account(mut)]
    pub staker: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn reclaim_handler(ctx: Context<Reclaim>) -> Result<()> {
    // ── CHECKS ──
    let market = &ctx.accounts.market;
    let position = &ctx.accounts.position;

    // Double-reclaim / already-claimed guard (shared with `claim`).
    require!(!position.claimed, SettlementError::AlreadyClaimed);

    // A market with no betting cutoff has no defined timeout → no reclaim window.
    // (Also blocks the 0 + RECLAIM_DELAY ≈ 1970 instant-reclaim footgun.)
    require!(market.lock_ts != 0, SettlementError::ReclaimUnavailable);

    let now = Clock::get()?.unix_timestamp;
    let reclaim_at = market
        .lock_ts
        .checked_add(RECLAIM_DELAY)
        .ok_or(SettlementError::Overflow)?;
    require!(now >= reclaim_at, SettlementError::ReclaimTooEarly);

    let amount = position.amount;
    let side = position.side;
    let market_key = market.key();
    let vault_bump = market.vault_bump;

    // ── EFFECTS (before the transfer — checks-effects-interactions) ──
    // Mark reclaimed FIRST so a re-entrant callee can never see an un-reclaimed
    // position, then decrement the side's stake so `pot == vault` still holds if a
    // (belated) settle + claim ever runs on the remaining positions.
    ctx.accounts.position.claimed = true;
    let market = &mut ctx.accounts.market;
    match side {
        Side::Yes => {
            market.stake_yes = market
                .stake_yes
                .checked_sub(amount)
                .ok_or(SettlementError::Overflow)?
        }
        Side::No => {
            market.stake_no = market
                .stake_no
                .checked_sub(amount)
                .ok_or(SettlementError::Overflow)?
        }
    }

    // ── INTERACTIONS ── the vault PDA signs the refund with its seeds.
    let signer_seeds: &[&[&[u8]]] = &[&[VAULT_SEED, market_key.as_ref(), &[vault_bump]]];
    transfer(
        CpiContext::new_with_signer(
            ctx.accounts.system_program.key(),
            Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.staker.to_account_info(),
            },
            signer_seeds,
        ),
        amount,
    )?;

    emit!(Reclaimed {
        market: market_key,
        staker: ctx.accounts.staker.key(),
        amount,
    });
    Ok(())
}

#[event]
pub struct Reclaimed {
    pub market: Pubkey,
    pub staker: Pubkey,
    pub amount: u64,
}
