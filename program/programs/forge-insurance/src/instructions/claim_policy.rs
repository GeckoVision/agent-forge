//! `claim_policy()` — release the vault after settle. Pull-payment + checks-effects-
//! interactions: the policy is flipped to `Claimed` BEFORE any lamports move, so a
//! re-entrant callee can never observe an unclaimed policy. The vault PDA signs the
//! outbound transfers with its seeds (`invoke_signed`).
//!
//! Payout (the vault holds coverage + premium):
//!   - event occurred  ⇒ the insured is indemnified `coverage`; the insurer keeps
//!                        their earned `premium`. (Insured receives coverage.)
//!   - event did NOT   ⇒ the insurer recovers `coverage` + keeps `premium`
//!                        (`coverage + premium`). The insured's premium was the cost
//!                        of the (unexercised) protection.
//! Either branch fully drains the vault. A party (insured or insurer) triggers it.

use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer, Transfer};

use crate::errors::InsuranceError;
use crate::interface::{POLICY_SEED, PVAULT_SEED};
use crate::state::{Policy, PolicyState};

#[derive(Accounts)]
pub struct ClaimPolicy<'info> {
    #[account(
        mut,
        seeds = [
            POLICY_SEED,
            &policy.fixture_id.to_le_bytes(),
            &policy.stat_key.to_le_bytes(),
            policy.insured.as_ref(),
        ],
        bump = policy.bump,
        constraint = policy.state == PolicyState::Settled @ InsuranceError::PolicyNotSettled,
    )]
    pub policy: Account<'info, Policy>,

    #[account(
        mut,
        seeds = [PVAULT_SEED, policy.key().as_ref()],
        bump = policy.pvault_bump,
    )]
    pub pvault: SystemAccount<'info>,

    /// The insured recipient — must match the policy.
    #[account(mut, constraint = insured.key() == policy.insured @ InsuranceError::WrongRecipient)]
    pub insured: SystemAccount<'info>,

    /// The insurer recipient — must match the policy.
    #[account(mut, constraint = insurer.key() == policy.insurer @ InsuranceError::WrongRecipient)]
    pub insurer: SystemAccount<'info>,

    /// A party to the policy triggers the release (pull-payment). Funds only ever go
    /// to the stored insured/insurer, so this is safe against redirection.
    #[account(
        constraint = claimant.key() == policy.insured || claimant.key() == policy.insurer
            @ InsuranceError::NotAParty
    )]
    pub claimant: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn claim_policy_handler(ctx: Context<ClaimPolicy>) -> Result<()> {
    // ── CHECKS ──
    require!(!ctx.accounts.policy.claimed, InsuranceError::AlreadyClaimed);

    // Snapshot the amounts + outcome before mutating.
    let coverage = ctx.accounts.policy.coverage;
    let premium = ctx.accounts.policy.premium;
    let event_occurred = ctx.accounts.policy.event_occurred;
    let pvault_bump = ctx.accounts.policy.pvault_bump;
    let policy_key = ctx.accounts.policy.key();

    // ── EFFECTS (before any transfer — checks-effects-interactions) ──
    {
        let policy = &mut ctx.accounts.policy;
        policy.claimed = true;
        policy.state = PolicyState::Claimed;
    }

    // ── INTERACTIONS ── the vault PDA signs with its seeds.
    let signer_seeds: &[&[&[u8]]] = &[&[PVAULT_SEED, policy_key.as_ref(), &[pvault_bump]]];

    if event_occurred {
        // Insured indemnified; insurer keeps the premium.
        pay(
            &ctx,
            &ctx.accounts.insured.to_account_info(),
            coverage,
            signer_seeds,
        )?;
        pay(
            &ctx,
            &ctx.accounts.insurer.to_account_info(),
            premium,
            signer_seeds,
        )?;
    } else {
        // No event: insurer recovers coverage and keeps the premium.
        let total = coverage
            .checked_add(premium)
            .ok_or(InsuranceError::Overflow)?;
        pay(
            &ctx,
            &ctx.accounts.insurer.to_account_info(),
            total,
            signer_seeds,
        )?;
    }

    emit!(PolicyClaimed {
        policy: policy_key,
        event_occurred,
        coverage,
        premium,
    });
    Ok(())
}

/// A single signed transfer out of the vault PDA to `to`.
fn pay<'info>(
    ctx: &Context<ClaimPolicy<'info>>,
    to: &AccountInfo<'info>,
    amount: u64,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    transfer(
        CpiContext::new_with_signer(
            ctx.accounts.system_program.key(),
            Transfer {
                from: ctx.accounts.pvault.to_account_info(),
                to: to.clone(),
            },
            signer_seeds,
        ),
        amount,
    )
}

#[event]
pub struct PolicyClaimed {
    pub policy: Pubkey,
    pub event_occurred: bool,
    pub coverage: u64,
    pub premium: u64,
}
