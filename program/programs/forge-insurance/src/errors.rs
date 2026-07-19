//! Custom errors. One `#[error_code]` enum; variant ORDER is the ABI
//! (code = 6000 + index) — append at the END, never reorder.

use anchor_lang::prelude::*;

#[error_code]
pub enum InsuranceError {
    #[msg("Policy is not Open (already funded, settled or claimed)")]
    PolicyNotOpen,

    #[msg("Policy is not Funded — cannot settle")]
    PolicyNotFunded,

    #[msg("Policy is not Settled — cannot claim")]
    PolicyNotSettled,

    #[msg("Policy payout already claimed")]
    AlreadyClaimed,

    #[msg("Coverage amount must be greater than zero")]
    ZeroCoverage,

    #[msg("Premium amount must be greater than zero")]
    ZeroPremium,

    #[msg("Signer is not the insured party of this policy")]
    NotInsured,

    #[msg("Signer is not a party (insured or insurer) to this policy")]
    NotAParty,

    #[msg("Supplied insured/insurer recipient does not match the policy")]
    WrongRecipient,

    #[msg("Supplied settlement engine account does not match the expected program id")]
    WrongEngineProgram,

    #[msg("Supplied txoracle program account does not match the expected program id")]
    WrongOracleProgram,

    #[msg("Arithmetic overflow")]
    Overflow,
}
