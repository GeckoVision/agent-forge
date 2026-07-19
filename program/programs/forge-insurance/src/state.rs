//! Account state for `forge-insurance` — parametric event insurance settled by the
//! SAME `settlement_core` engine as forge-markets. Structurally different from a
//! pari-mutuel market (fixed indemnity, asymmetric insurer/insured roles, non-pooled
//! release) — which is the point: it proves the engine is reusable, not a market helper.

use anchor_lang::prelude::*;
use settlement_core::TraderPredicate;

/// Policy lifecycle.
///   Open    — insurer posted coverage, awaiting the insured's premium.
///   Funded  — insured paid the premium; the risk is live, settle-able.
///   Settled — the engine certified whether the insured event occurred.
///   Claimed — the pot has been released; terminal.
#[derive(AnchorSerialize, AnchorDeserialize, InitSpace, Clone, Copy, Debug, PartialEq, Eq)]
pub enum PolicyState {
    Open,
    Funded,
    Settled,
    Claimed,
}

/// `Policy` — one parametric cover over one fixture stat.
///
/// Parametric model: the insured buys protection against an EVENT defined by the
/// same `(fixture, stat, period, predicate)` tuple a market would use. The engine
/// decides whether the event occurred; the payout is fixed indemnity, not pro-rata.
///
/// Seeds: `[b"policy", fixture_id.to_le_bytes(), stat_key.to_le_bytes(), insured]`.
#[account]
#[derive(InitSpace)]
pub struct Policy {
    /// TxODDS fixture the cover is about.
    pub fixture_id: i64, // 8
    /// The stat key the event predicate is evaluated over.
    pub stat_key: u32, // 4
    /// The stat period (F1-bound at settle, in the engine).
    pub period: i32, // 4
    /// The insured EVENT condition (e.g. "corners > 10"), evaluated on-chain by
    /// txoracle via the engine — never by this program.
    pub predicate: TraderPredicate, // 4 + 1
    /// Who posted the coverage (paid out to on a no-event outcome).
    pub insurer: Pubkey, // 32
    /// Who is protected (paid the indemnity on an event outcome). Bound in the PDA seed.
    pub insured: Pubkey, // 32
    /// Fixed indemnity the insured receives if the event occurs.
    pub coverage: u64, // 8
    /// Price the insured pays for the cover (the insurer's earning).
    pub premium: u64, // 8
    /// The SOL vault PDA holding coverage + premium (`[b"pvault", policy]`).
    ///
    /// SOL keeps the demo simplest. USDC is the PRODUCTION choice for a fixed
    /// indemnity (a stable unit) — the engine never touches the vault, so it is
    /// asset-agnostic: forge-markets can escrow SOL and forge-insurance USDC, both
    /// settling on the same proof. SOL here only to avoid an SPL-token dependency.
    pub pvault: Pubkey, // 32
    /// Open | Funded | Settled | Claimed.
    pub state: PolicyState, // 1
    /// Set at settle from the engine's bool — did the insured event occur?
    pub event_occurred: bool, // 1
    /// Set once the pot has been released (double-claim guard).
    pub claimed: bool, // 1
    /// Canonical bump, STORED.
    pub bump: u8, // 1
    /// pvault PDA canonical bump, STORED (so claim can sign the release).
    pub pvault_bump: u8, // 1
    /// `insurance:v1`.
    pub schema_version: u8, // 1
    /// Future use (no realloc churn).
    pub _reserved: [u8; 24], // 24
}
