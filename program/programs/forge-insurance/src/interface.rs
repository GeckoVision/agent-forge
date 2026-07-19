//! Frozen PDA seeds + schema constants for `forge-insurance`.

/// `Policy` PDA. Seeds:
/// `[b"policy", fixture_id.to_le_bytes(), stat_key.to_le_bytes(), insured.key()]`.
pub const POLICY_SEED: &[u8] = b"policy";

/// SOL vault PDA — one per policy, system-owned, holds coverage + premium. Seeds:
/// `[b"pvault", policy.key()]`.
pub const PVAULT_SEED: &[u8] = b"pvault";

/// Schema version (`insurance:v1`).
pub const SCHEMA_VERSION: u8 = 1;
