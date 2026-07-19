//! `claim()` — a winning staker withdraws their pro-rata share of the whole pot.
//!
//! payout = pot * position.amount / stake(winning_side),
//! where pot = stake_yes + stake_no. The entire vault is distributed across the
//! winning side in proportion to each staker's contribution. Lamports leave the
//! vault via an `invoke_signed` System transfer (the vault PDA signs with seeds).

use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer, Transfer};

use crate::errors::SettlementError;
use crate::interface::{MARKET_SEED, VAULT_SEED};
use crate::state::{Market, MarketState, Position, Side};

#[derive(Accounts)]
pub struct Claim<'info> {
    #[account(
        seeds = [
            MARKET_SEED,
            &market.fixture_id.to_le_bytes(),
            &market.stat_key.to_le_bytes(),
        ],
        bump = market.bump,
        constraint = market.state == MarketState::Settled @ SettlementError::MarketNotSettled,
    )]
    pub market: Account<'info, Market>,

    #[account(
        mut,
        seeds = [
            crate::interface::POSITION_SEED,
            market.key().as_ref(),
            staker.key().as_ref(),
        ],
        bump = position.bump,
        // Belt-and-braces: the Position PDA seeds already bind `staker`, so a
        // signer can only ever reach their OWN position — this owner check is
        // redundant on purpose (defense in depth over seed derivation). The
        // `NotWinningSide` error name predates the constraint; a mismatch here
        // is really "not your position".
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

pub fn claim_handler(ctx: Context<Claim>) -> Result<()> {
    // ── CHECKS ──
    let market = &ctx.accounts.market;
    let position = &ctx.accounts.position;

    require!(!position.claimed, SettlementError::AlreadyClaimed);
    require!(
        position.side == market.winner,
        SettlementError::NotWinningSide
    );

    let winner_total = match market.winner {
        Side::Yes => market.stake_yes,
        Side::No => market.stake_no,
    };
    // Honest v1 limit: if the market settled with an EMPTY winning side, this
    // gate makes every claim fail and the pot stays stranded in the vault —
    // there is no reclaim instruction yet for the losing stakers (planned).
    require!(winner_total > 0, SettlementError::NoWinningStake);

    let pot = (market.stake_yes as u128)
        .checked_add(market.stake_no as u128)
        .ok_or(SettlementError::Overflow)?;
    let payout = pot
        .checked_mul(position.amount as u128)
        .ok_or(SettlementError::Overflow)?
        .checked_div(winner_total as u128)
        .ok_or(SettlementError::Overflow)? as u64;

    let market_key = market.key();
    let vault_bump = market.vault_bump;

    // ── EFFECTS (before the transfer — checks-effects-interactions) ──
    // Mark claimed BEFORE any lamports move so a re-entrant callee can never see an
    // unclaimed position. (Was previously set AFTER the transfer — the auditor-reflex
    // anti-pattern flagged in SETTLEMENT-ENGINE.md.)
    ctx.accounts.position.claimed = true;

    // ── INTERACTIONS ── the vault PDA signs the outbound transfer with its seeds.
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
        payout,
    )?;

    emit!(Claimed {
        market: market_key,
        staker: ctx.accounts.staker.key(),
        payout,
    });
    Ok(())
}

#[event]
pub struct Claimed {
    pub market: Pubkey,
    pub staker: Pubkey,
    pub payout: u64,
}
