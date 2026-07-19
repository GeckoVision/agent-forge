//! `create_market(fixture_id, stat_key, predicate, period, lock_ts)` — open a
//! two-sided escrow over one fixture stat. Stores the YES predicate that txoracle
//! will later evaluate, the stat `period` the settle proof must match (the F1
//! binding — see settle.rs), and the `lock_ts` betting cutoff (0 = no cutoff; see
//! stake.rs); derives + records the SOL vault PDA (funded lazily by the first stake).

use anchor_lang::prelude::*;

use crate::interface::{MARKET_SEED, SCHEMA_VERSION, VAULT_SEED};
use crate::state::{Market, MarketState, Side};
use settlement_core::TraderPredicate;

#[derive(Accounts)]
#[instruction(fixture_id: i64, stat_key: u32)]
pub struct CreateMarket<'info> {
    #[account(
        init,
        payer = authority,
        space = Market::DISCRIMINATOR.len() + Market::INIT_SPACE,
        seeds = [MARKET_SEED, &fixture_id.to_le_bytes(), &stat_key.to_le_bytes()],
        bump
    )]
    pub market: Account<'info, Market>,

    /// SOL vault PDA (system-owned, holds the pot). Not created here — it simply
    /// receives lamports on the first `stake`. Anchor validates it is the canonical
    /// PDA and hands us the bump to store.
    #[account(
        seeds = [VAULT_SEED, market.key().as_ref()],
        bump
    )]
    pub vault: SystemAccount<'info>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn create_market_handler(
    ctx: Context<CreateMarket>,
    fixture_id: i64,
    stat_key: u32,
    predicate: TraderPredicate,
    period: i32,
    lock_ts: i64,
) -> Result<()> {
    let market = &mut ctx.accounts.market;
    market.fixture_id = fixture_id;
    market.stat_key = stat_key;
    market.predicate = predicate;
    market.vault = ctx.accounts.vault.key();
    market.stake_yes = 0;
    market.stake_no = 0;
    market.state = MarketState::Open;
    market.winner = Side::Yes; // placeholder; only meaningful once Settled
    market.authority = ctx.accounts.authority.key();
    market.bump = ctx.bumps.market;
    market.vault_bump = ctx.bumps.vault;
    market.schema_version = SCHEMA_VERSION;
    market.period = period; // bound at settle (F1); see settle.rs / state.rs
    // Betting cutoff. `0` = no cutoff (the caller opts out; also the legacy default
    // for markets created before this field existed). See stake.rs / state.rs.
    market.lock_ts = lock_ts;
    market._reserved = [0u8; 20];

    emit!(MarketCreated {
        market: market.key(),
        fixture_id,
        stat_key,
        threshold: predicate.threshold,
    });
    Ok(())
}

#[event]
pub struct MarketCreated {
    pub market: Pubkey,
    pub fixture_id: i64,
    pub stat_key: u32,
    pub threshold: i32,
}
