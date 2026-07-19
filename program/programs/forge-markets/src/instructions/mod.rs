//! Instruction handlers + their `#[derive(Accounts)]` contexts.
//!
//! `lib.rs` calls each `*_handler` by its fully-qualified path; the glob re-export
//! brings the `__client_accounts_*` / `__cpi_client_accounts_*` helper modules
//! that `#[program]` wires into scope. Handlers are named distinctly (`*_handler`)
//! so the glob does not collide.

pub mod claim;
pub mod create_market;
pub mod reclaim;
pub mod settle;
pub mod stake;

pub use claim::*;
pub use create_market::*;
pub use reclaim::*;
pub use settle::*;
pub use stake::*;
