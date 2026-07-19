//! Account state for `forge-markets` (Anchor, Borsh).
//!
//! Conventions (`.claude/rules/anchor.md`): `#[derive(InitSpace)]`, canonical
//! bump STORED, `_reserved` tails so future fields never force a realloc.

use anchor_lang::prelude::*;

use settlement_core::TraderPredicate;

/// Which side of the market a stake / the settled outcome is on.
///
/// Borsh variant index: `Yes = 0`, `No = 1`. `Yes` == "the market's predicate
/// held" (proven by the txoracle CPI). `No` == "it did not".
#[derive(AnchorSerialize, AnchorDeserialize, InitSpace, Clone, Copy, Debug, PartialEq, Eq)]
pub enum Side {
    Yes,
    No,
}

/// Market lifecycle. `Open` accepts stakes; `Settled` is terminal (winner fixed).
#[derive(AnchorSerialize, AnchorDeserialize, InitSpace, Clone, Copy, Debug, PartialEq, Eq)]
pub enum MarketState {
    Open,
    Settled,
}

/// `Market` — a two-sided prediction escrow over one fixture stat.
///
/// The outcome is NOT stored until `settle`, and `settle` sets it ONLY on the
/// strength of a successful `txoracle::validate_stat` CPI — the program itself
/// never evaluates the stat or the predicate (that is the trustless invariant).
///
/// Seeds: `[b"market", fixture_id.to_le_bytes(), stat_key.to_le_bytes()]`.
#[account]
#[derive(InitSpace)]
pub struct Market {
    /// TxODDS fixture id this market is about.
    pub fixture_id: i64, // 8
    /// The stat key (`ScoreStat.key`) the predicate is evaluated over.
    pub stat_key: u32, // 4
    /// The YES condition, evaluated on-chain by txoracle (never by this program).
    pub predicate: TraderPredicate, // 4 + 1 (threshold i32 + Comparison u8)
    /// The SOL vault PDA holding the pot (`[b"vault", market]`).
    pub vault: Pubkey, // 32
    /// Total lamports staked on YES.
    pub stake_yes: u64, // 8
    /// Total lamports staked on NO.
    pub stake_no: u64, // 8
    /// Open | Settled.
    pub state: MarketState, // 1
    /// Winning side — meaningful only once `state == Settled`.
    pub winner: Side, // 1
    /// The account authority that created the market (bookkeeping).
    pub authority: Pubkey, // 32
    /// Canonical bump, STORED.
    pub bump: u8, // 1
    /// Vault PDA canonical bump, STORED (so `claim` can sign the payout).
    pub vault_bump: u8, // 1
    /// `forge:v1`.
    pub schema_version: u8, // 1
    /// The stat PERIOD the predicate is evaluated over (e.g. full-time vs half-time).
    /// Bound so `settle` cannot prove the same fixture+stat for a different period and
    /// flip the outcome (F1). Drawn from the reserved tail so the account byte-size is
    /// UNCHANGED (no realloc; existing markets stay decodable). `ScoreStat.period` is i32.
    pub period: i32, // 4  (taken from _reserved: 32 → 28)
    /// Future use (no realloc churn).
    pub _reserved: [u8; 28], // 28
}

/// `Position` — one staker's stake on one market. Pro-rata claim reads this.
///
/// Seeds: `[b"position", market.key(), staker.key()]`. v1 = one stake per staker
/// per market (`init`, not the banned `init_if_needed`); re-staking / averaging
/// is deferred.
#[account]
#[derive(InitSpace)]
pub struct Position {
    /// The market this position belongs to.
    pub market: Pubkey, // 32
    /// The staker (== the signer that funded it).
    pub owner: Pubkey, // 32
    /// Which side they backed.
    pub side: Side, // 1
    /// Lamports staked.
    pub amount: u64, // 8
    /// Set once the payout has been withdrawn (prevents double-claim).
    pub claimed: bool, // 1
    /// Canonical bump, STORED.
    pub bump: u8, // 1
    /// Future use.
    pub _reserved: [u8; 16], // 16
}
