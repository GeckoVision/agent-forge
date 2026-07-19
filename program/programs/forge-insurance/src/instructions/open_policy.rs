//! `open_policy(fixture_id, stat_key, period, predicate, coverage)` — the insurer
//! opens a parametric cover FOR a named insured and deposits the coverage indemnity
//! into the policy vault. state → Open (awaiting the insured's premium).

use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer, Transfer};
use settlement_core::TraderPredicate;

use crate::errors::InsuranceError;
use crate::interface::{POLICY_SEED, PVAULT_SEED, SCHEMA_VERSION};
use crate::state::{Policy, PolicyState};

#[derive(Accounts)]
#[instruction(fixture_id: i64, stat_key: u32)]
pub struct OpenPolicy<'info> {
    #[account(
        init,
        payer = insurer,
        space = Policy::DISCRIMINATOR.len() + Policy::INIT_SPACE,
        seeds = [
            POLICY_SEED,
            &fixture_id.to_le_bytes(),
            &stat_key.to_le_bytes(),
            insured.key().as_ref(),
        ],
        bump
    )]
    pub policy: Account<'info, Policy>,

    /// SOL vault PDA (system-owned). Receives the coverage lamports below, so it is
    /// `mut`. Anchor validates the canonical PDA and hands us the bump.
    #[account(
        mut,
        seeds = [PVAULT_SEED, policy.key().as_ref()],
        bump
    )]
    pub pvault: SystemAccount<'info>,

    /// CHECK: the party being insured; used only to bind the policy PDA seed and to
    /// store `insured`. Does not sign at open (the insurer opens on their behalf).
    pub insured: UncheckedAccount<'info>,

    #[account(mut)]
    pub insurer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn open_policy_handler(
    ctx: Context<OpenPolicy>,
    fixture_id: i64,
    stat_key: u32,
    period: i32,
    predicate: TraderPredicate,
    coverage: u64,
) -> Result<()> {
    require!(coverage > 0, InsuranceError::ZeroCoverage);

    // Move the coverage indemnity into the vault (insurer signs normally).
    transfer(
        CpiContext::new(
            ctx.accounts.system_program.key(),
            Transfer {
                from: ctx.accounts.insurer.to_account_info(),
                to: ctx.accounts.pvault.to_account_info(),
            },
        ),
        coverage,
    )?;

    let policy = &mut ctx.accounts.policy;
    policy.fixture_id = fixture_id;
    policy.stat_key = stat_key;
    policy.period = period;
    policy.predicate = predicate;
    policy.insurer = ctx.accounts.insurer.key();
    policy.insured = ctx.accounts.insured.key();
    policy.coverage = coverage;
    policy.premium = 0;
    policy.pvault = ctx.accounts.pvault.key();
    policy.state = PolicyState::Open;
    policy.event_occurred = false;
    policy.claimed = false;
    policy.bump = ctx.bumps.policy;
    policy.pvault_bump = ctx.bumps.pvault;
    policy.schema_version = SCHEMA_VERSION;
    policy._reserved = [0u8; 24];

    emit!(PolicyOpened {
        policy: policy.key(),
        insurer: policy.insurer,
        insured: policy.insured,
        fixture_id,
        stat_key,
        coverage,
    });
    Ok(())
}

#[event]
pub struct PolicyOpened {
    pub policy: Pubkey,
    pub insurer: Pubkey,
    pub insured: Pubkey,
    pub fixture_id: i64,
    pub stat_key: u32,
    pub coverage: u64,
}
