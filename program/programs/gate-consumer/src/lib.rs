//! gate-consumer — GATE PROBE ONLY, never deployed.
//!
//! Models an arbitrary consumer contract: it CPIs `gate_engine::relay` (which
//! itself CPIs mock-txoracle) and, IMMEDIATELY after the CPI with no intervening
//! CPI, reads `get_return_data()` to recover the engine's returned bool. It writes
//! that bool into `result_account.data[0]` so the Mollusk suite can inspect the
//! EXACT byte the consumer received — proving the two-hop return-data path.

#![allow(unexpected_cfgs)]

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::{get_return_data, invoke};

declare_id!("63tVMMkpEvayZAJSxhoUsmpHqen6PqAqnUqyJYJXMi8b");

pub const GATE_ENGINE_ID: Pubkey = pubkey!("9G418GNv2hnfNsGZwJ8rMJeJuqn6ng5VkL9tyRQodp73");
/// Anchor discriminator for `gate_engine::relay` (sha256("global:relay")[..8]).
pub const RELAY_DISCRIMINATOR: [u8; 8] = [109, 130, 24, 215, 1, 255, 37, 114];

#[error_code]
pub enum GateConsumerError {
    #[msg("engine set no return data")]
    EngineNoReturnData,
    #[msg("engine return data from wrong program")]
    EngineReturnWrongProgram,
    #[msg("engine return data not a decodable bool")]
    EngineBadReturnData,
    #[msg("result account too small")]
    ResultAccountTooSmall,
}

#[program]
pub mod gate_consumer {
    use super::*;

    /// CPI the engine, then read its returned bool and record it.
    pub fn probe(ctx: Context<Probe>, steer: i32) -> Result<()> {
        let mut data = Vec::with_capacity(12);
        data.extend_from_slice(&RELAY_DISCRIMINATOR);
        steer.serialize(&mut data)?;

        let ix = Instruction {
            program_id: GATE_ENGINE_ID,
            accounts: vec![
                AccountMeta::new_readonly(*ctx.accounts.daily_scores_merkle_roots.key, false),
                AccountMeta::new_readonly(*ctx.accounts.txoracle_program.key, false),
            ],
            data,
        };

        // The engine CPI. Internally the engine CPIs txoracle (which sets return
        // data), then returns Ok(bool) — Anchor re-sets return data to the engine's
        // bool. We must read it IMMEDIATELY, before any other CPI.
        invoke(
            &ix,
            &[
                ctx.accounts.gate_engine_program.to_account_info(),
                ctx.accounts.daily_scores_merkle_roots.to_account_info(),
                ctx.accounts.txoracle_program.to_account_info(),
            ],
        )?;

        let (returning, bytes) = get_return_data().ok_or(GateConsumerError::EngineNoReturnData)?;
        require_keys_eq!(
            returning,
            GATE_ENGINE_ID,
            GateConsumerError::EngineReturnWrongProgram
        );
        let engine_bool =
            bool::try_from_slice(&bytes).map_err(|_| GateConsumerError::EngineBadReturnData)?;

        // Record the exact byte the consumer received from the engine.
        let mut result = ctx.accounts.result_account.try_borrow_mut_data()?;
        require!(!result.is_empty(), GateConsumerError::ResultAccountTooSmall);
        result[0] = engine_bool as u8;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Probe<'info> {
    /// CHECK: pinned to the gate-engine id.
    #[account(address = GATE_ENGINE_ID)]
    pub gate_engine_program: UncheckedAccount<'info>,
    /// CHECK: passthrough to the engine's txoracle CPI.
    pub daily_scores_merkle_roots: UncheckedAccount<'info>,
    /// CHECK: passthrough to the engine's txoracle CPI.
    pub txoracle_program: UncheckedAccount<'info>,
    /// CHECK: consumer-owned scratch; byte[0] receives the returned bool.
    #[account(mut, owner = crate::ID @ GateConsumerError::ResultAccountTooSmall)]
    pub result_account: UncheckedAccount<'info>,
}
