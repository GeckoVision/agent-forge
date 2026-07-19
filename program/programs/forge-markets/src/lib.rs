//! forge-markets — a trustless prediction escrow over TxODDS fixture stats.
//! Anchor 1.0, DEVNET-ONLY.
//!
//! ── The trustless claim ──────────────────────────────────────────────────────
//! The program NEVER decides who wins. `settle` CPIs into TxODDS's on-chain
//! `txoracle::validate_stat` (devnet `6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J`),
//! passing the market's stored predicate + a caller-supplied 3-stage Merkle proof.
//! The oracle proves the stat against ITS OWN on-chain root and evaluates the
//! predicate; this program only records the outcome the oracle certifies. A
//! tampered proof makes the CPI fail, which reverts `settle` — that revert is the
//! whole guarantee.
//!
//! ── Instructions ─────────────────────────────────────────────────────────────
//!   create_market(fixture_id, stat_key, predicate, period, lock_ts) — open a
//!                                    two-sided escrow bound to one stat period,
//!                                    with an optional betting cutoff (lock_ts)
//!   stake(side, amount)                            — back YES/NO with SOL (refused
//!                                                    once lock_ts has passed)
//!   settle(ts, summary, proofs.., stat_a, ..)      — CPI validate_stat → outcome
//!   claim()                                        — winning side withdraws pro-rata
//!   reclaim()                                      — timeout refund of an OWN stake
//!                                    on an unsettleable (still-Open) market
//!
//! Both YES and NO settle through this single `settle`: the oracle returns
//! `Ok(true|false)` and the program records the winner from that bool (a false
//! predicate is `Ok(false)` → NO, not a revert). No separate `settle_no` exists.
//!
//! ── Flagged as founder-gated / out of Phase A ────────────────────────────────
//!   * devnet deploy (keypair + SOL);
//!   * a real txoracle Merkle fixture + confirming the LIVE oracle's `Ok(bool)`
//!     return-data encoding (the mollusk suite uses a program double that models
//!     it — see programs/mock-txoracle + the settlement test crate header).

// Anchor macros emit `cfg(target_os = "solana")`, unknown to host cargo. Declare
// it expected so host `cargo check`/`test` is warning-clean.
#![allow(unexpected_cfgs)]

use anchor_lang::prelude::*;

pub mod errors;
pub mod instructions;
pub mod interface;
pub mod state;

use instructions::*;
use state::Side;
// The oracle-arg types + predicate now live in the settlement-core ENGINE (the
// single source of truth); forge-markets imports them and forwards them to
// `settlement_core::cpi::resolve` at settle.
use settlement_core::{BinaryExpression, ProofNode, ScoresBatchSummary, StatTerm, TraderPredicate};

declare_id!("7Pvo6SEh1zBa1Euvj5QQ4td9GpfsQosTpxhqwWtWUFt6");

// ── On-chain security.txt (production-readiness metadata) ─────────────────────
// Embeds a machine-readable contact + disclosure policy into the deployed binary
// so `query-security-txt` and explorers can surface how to report an issue. This
// is a DEVNET program (see SECURITY.md). Gated `not(feature = "no-entrypoint")`
// per the crate's docs: the macro emits a `#[no_mangle] SECURITY_TXT` symbol, so
// it must be present ONLY in the standalone program binary — never when
// forge-markets is compiled as a CPI library, which would otherwise raise a
// "multiple definition of SECURITY_TXT" link error. The host-target Mollusk suite
// does not link this crate, so its build is unaffected either way.
#[cfg(not(feature = "no-entrypoint"))]
use solana_security_txt::security_txt;

#[cfg(not(feature = "no-entrypoint"))]
security_txt! {
    name: "AgentForge Markets",
    project_url: "https://github.com/GeckoVision/agent-forge",
    source_code: "https://github.com/GeckoVision/agent-forge",
    contacts: "link:https://github.com/GeckoVision/agent-forge/security, link:https://github.com/GeckoVision/agent-forge/issues",
    policy: "https://github.com/GeckoVision/agent-forge/blob/main/SECURITY.md",
    preferred_languages: "en"
}

#[program]
pub mod forge_markets {
    use super::*;

    /// Open a two-sided market over `(fixture_id, stat_key, period)` with a YES
    /// predicate. `period` binds the stat phase the oracle proof must match at settle.
    /// `lock_ts` is the betting cutoff (Unix seconds); pass `0` for no cutoff.
    pub fn create_market(
        ctx: Context<CreateMarket>,
        fixture_id: i64,
        stat_key: u32,
        predicate: TraderPredicate,
        period: i32,
        lock_ts: i64,
    ) -> Result<()> {
        instructions::create_market::create_market_handler(
            ctx, fixture_id, stat_key, predicate, period, lock_ts,
        )
    }

    /// Stake `amount` lamports on `side`.
    pub fn stake(ctx: Context<Stake>, side: Side, amount: u64) -> Result<()> {
        instructions::stake::stake_handler(ctx, side, amount)
    }

    /// Settle the market by CPI-ing `txoracle::validate_stat`. Reverts on a bad proof.
    #[allow(clippy::too_many_arguments)]
    pub fn settle(
        ctx: Context<Settle>,
        ts: i64,
        fixture_summary: ScoresBatchSummary,
        fixture_proof: Vec<ProofNode>,
        main_tree_proof: Vec<ProofNode>,
        stat_a: StatTerm,
        stat_b: Option<StatTerm>,
        op: Option<BinaryExpression>,
    ) -> Result<()> {
        instructions::settle::settle_handler(
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

    /// Withdraw a winning position's pro-rata share of the pot.
    pub fn claim(ctx: Context<Claim>) -> Result<()> {
        instructions::claim::claim_handler(ctx)
    }

    /// Reclaim an OWN stake from a still-Open market once its betting cutoff plus
    /// `RECLAIM_DELAY` has elapsed — the timeout refund for an unsettleable market.
    pub fn reclaim(ctx: Context<Reclaim>) -> Result<()> {
        instructions::reclaim::reclaim_handler(ctx)
    }
}
