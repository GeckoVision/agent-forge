//! Engine errors. One `#[error_code]` enum; variant ORDER is the ABI
//! (code = 6000 + index) — append at the END, never reorder.

use anchor_lang::prelude::*;

#[error_code]
pub enum EngineError {
    // ── oracle program pin + fail-closed return-data decode (preserved from
    //    forge-markets; same semantics, the trust guarantee) ──
    #[msg("Supplied txoracle program account does not match the expected program id")]
    WrongOracleProgram,

    #[msg("txoracle CPI set no return data — cannot determine the outcome")]
    OracleNoReturnData,

    #[msg("txoracle CPI return data came from an unexpected program")]
    OracleReturnWrongProgram,

    #[msg("txoracle CPI return data was not a decodable bool")]
    OracleBadReturnData,

    // ── F1 binding of the caller-supplied oracle args to the declared query ──
    // `resolve` is permissionless and the oracle only proves "a genuine stat in a
    // genuine fixture" — it has no concept of the CONSUMER's market/policy. These
    // bind the args to the `PredicateQuery` the consumer declared, so an attacker
    // cannot resolve against a different-but-genuine data point. Moved verbatim
    // (semantics) from forge-markets settle.rs:71-91 — now on `query`, not a Market.
    #[msg("Proof fixture_id does not match the declared query fixture_id")]
    FixtureMismatch,

    #[msg("Proven stat key does not match the declared query stat_key")]
    StatMismatch,

    #[msg("Query is single-stat: a second stat term / binary op is not allowed")]
    MultiStatNotAllowed,

    #[msg("Proven stat period does not match the declared query period")]
    PeriodMismatch,

    // ── determinism: variable-length proof → variable CU. Bound it. ──
    #[msg("A supplied Merkle proof exceeds the maximum node bound")]
    ProofTooLong,
}
