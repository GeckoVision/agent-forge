//! Custom errors. Anchor 1.0 allows EXACTLY ONE `#[error_code]` enum per program.
//! Variant ORDER is the ABI (code = 6000 + index) — append at the END, never
//! reorder.

use anchor_lang::prelude::*;

#[error_code]
pub enum SettlementError {
    #[msg("Market is not Open (already settled or closed)")]
    MarketNotOpen,

    #[msg("Market is not Settled yet — cannot claim")]
    MarketNotSettled,

    #[msg("Stake amount must be greater than zero")]
    ZeroStake,

    #[msg("This position is on the losing side")]
    NotWinningSide,

    #[msg("Position payout already claimed")]
    AlreadyClaimed,

    // If the winning side has zero stake, every claim fails with this error and
    // the pot is STRANDED in the vault — v1 has no reclaim/refund instruction
    // for the losing side (one is spec'd; see claim.rs).
    #[msg("The winning side has zero total stake — nothing to claim")]
    NoWinningStake,

    #[msg("Supplied txoracle program account does not match the expected program id")]
    WrongOracleProgram,

    #[msg("Arithmetic overflow")]
    Overflow,

    // ── appended (fail-closed oracle-return decoding; never reorder the above) ──
    #[msg("txoracle CPI set no return data — cannot determine the outcome")]
    OracleNoReturnData,

    #[msg("txoracle CPI return data came from an unexpected program")]
    OracleReturnWrongProgram,

    #[msg("txoracle CPI return data was not a decodable bool")]
    OracleBadReturnData,

    // ── appended: F1 market-binding of the caller-supplied oracle args ──────────
    // `settle` is permissionless and the oracle only proves "a genuine stat in a
    // genuine fixture" — it has no concept of THIS market. These bind the args to
    // the market so an attacker cannot settle against a different-but-genuine data
    // point. Appended at the END (never reorder — code = 6000 + variant index).
    #[msg("Proof fixture_id does not match this market's fixture_id")]
    FixtureMismatch,

    #[msg("Proven stat key does not match this market's stat_key")]
    StatMismatch,

    #[msg("Market is single-stat: a second stat term / binary op is not allowed")]
    MultiStatNotAllowed,

    #[msg("Proven stat period does not match this market's period")]
    PeriodMismatch,

    // ── appended: settle now CPIs the settlement-core ENGINE. Pin its program id
    // so a caller cannot redirect the resolve CPI to a look-alike engine. ──
    #[msg("Supplied settlement engine account does not match the expected program id")]
    WrongEngineProgram,
}
