//! `bind_policy(premium)` — the insured accepts the cover by depositing the premium
//! into the policy vault. state Open → Funded (the risk is now live and settle-able).

use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer, Transfer};

use crate::errors::InsuranceError;
use crate::interface::{POLICY_SEED, PVAULT_SEED};
use crate::state::{Policy, PolicyState};

#[derive(Accounts)]
pub struct BindPolicy<'info> {
    #[account(
        mut,
        seeds = [
            POLICY_SEED,
            &policy.fixture_id.to_le_bytes(),
            &policy.stat_key.to_le_bytes(),
            policy.insured.as_ref(),
        ],
        bump = policy.bump,
        constraint = policy.state == PolicyState::Open @ InsuranceError::PolicyNotOpen,
        // Only the named insured may bind (the PDA seed already binds this key; the
        // explicit check is defense in depth and yields a clear error).
        constraint = policy.insured == insured.key() @ InsuranceError::NotInsured,
    )]
    pub policy: Account<'info, Policy>,

    #[account(
        mut,
        seeds = [PVAULT_SEED, policy.key().as_ref()],
        bump = policy.pvault_bump,
    )]
    pub pvault: SystemAccount<'info>,

    #[account(mut)]
    pub insured: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn bind_policy_handler(ctx: Context<BindPolicy>, premium: u64) -> Result<()> {
    require!(premium > 0, InsuranceError::ZeroPremium);

    // Move the premium into the vault (insured signs normally).
    transfer(
        CpiContext::new(
            ctx.accounts.system_program.key(),
            Transfer {
                from: ctx.accounts.insured.to_account_info(),
                to: ctx.accounts.pvault.to_account_info(),
            },
        ),
        premium,
    )?;

    let policy = &mut ctx.accounts.policy;
    policy.premium = premium;
    policy.state = PolicyState::Funded;

    emit!(PolicyBound {
        policy: policy.key(),
        premium,
    });
    Ok(())
}

#[event]
pub struct PolicyBound {
    pub policy: Pubkey,
    pub premium: u64,
}
