//! forge-insurance — parametric event insurance settled by the SAME `settlement_core`
//! engine as forge-markets. Anchor 1.0, DEVNET-ONLY, UNDEPLOYED.
//!
//! ── Why this program exists ──────────────────────────────────────────────────
//! It is the SECOND consumer of the settlement engine, and deliberately NOT a
//! prediction market (which would be the engine's first consumer with N=2 sides —
//! proving nothing). Insurance is structurally different: fixed indemnity, asymmetric
//! insurer/insured roles, non-pooled release — yet it settles on the exact same
//! `validate_stat` proof, via the exact same `settlement_core::client::resolve` call.
//! It re-implements NO CPI or F1-binding logic; that lives once, in the engine.
//!
//!   open_policy(fixture,stat,period,predicate,coverage) — insurer posts coverage
//!   bind_policy(premium)                                — insured pays premium → Funded
//!   settle_policy(ts, summary, proofs.., stat_a, ..)    — CPI the engine → event bool
//!   claim_policy()                                      — release the vault (CEI)

#![allow(unexpected_cfgs)]

use anchor_lang::prelude::*;
use settlement_core::{BinaryExpression, ProofNode, ScoresBatchSummary, StatTerm, TraderPredicate};

pub mod errors;
pub mod instructions;
pub mod interface;
pub mod state;

use instructions::*;

declare_id!("F8kKN4syidmfRuy5atqhUuJPVQFM4DYH5xmqQ9pSQ22A");

#[program]
pub mod forge_insurance {
    use super::*;

    /// Open a parametric cover for a named insured; the insurer deposits `coverage`.
    pub fn open_policy(
        ctx: Context<OpenPolicy>,
        fixture_id: i64,
        stat_key: u32,
        period: i32,
        predicate: TraderPredicate,
        coverage: u64,
    ) -> Result<()> {
        instructions::open_policy::open_policy_handler(
            ctx, fixture_id, stat_key, period, predicate, coverage,
        )
    }

    /// The insured accepts the cover by depositing `premium`. state → Funded.
    pub fn bind_policy(ctx: Context<BindPolicy>, premium: u64) -> Result<()> {
        instructions::bind_policy::bind_policy_handler(ctx, premium)
    }

    /// Settle by CPI-ing the SAME settlement-core engine. Records event_occurred.
    #[allow(clippy::too_many_arguments)]
    pub fn settle_policy(
        ctx: Context<SettlePolicy>,
        ts: i64,
        fixture_summary: ScoresBatchSummary,
        fixture_proof: Vec<ProofNode>,
        main_tree_proof: Vec<ProofNode>,
        stat_a: StatTerm,
        stat_b: Option<StatTerm>,
        op: Option<BinaryExpression>,
    ) -> Result<()> {
        instructions::settle_policy::settle_policy_handler(
            ctx,
            ts,
            fixture_summary,
            fixture_proof,
            main_tree_proof,
            stat_a,
            stat_b,
            op,
        )
    }

    /// Release the vault to the correct party (checks-effects-interactions).
    pub fn claim_policy(ctx: Context<ClaimPolicy>) -> Result<()> {
        instructions::claim_policy::claim_policy_handler(ctx)
    }
}
