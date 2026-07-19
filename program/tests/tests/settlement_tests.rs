//! forge-markets Mollusk suite — the Phase-A exit gate.
//!
//! Covers the two trust-critical paths from the plan:
//!   - HAPPY: create → stake YES + NO → settle with a VALID proof (root matches
//!     the seeded on-chain root) → the `validate_stat` CPI succeeds → winner = Yes,
//!     state = Settled → the winning staker claims the whole pot pro-rata.
//!   - NEGATIVE: the SAME flow but with a TAMPERED sub-tree root → the CPI fails →
//!     `settle` reverts → the market stays Open. (This revert is the whole
//!     trustless claim: the program never decides, the oracle does.)
//!
//! Plus: the CPI program is pinned by address, and our Anchor-derived discriminator
//! equals the IDL's — the byte-exactness sanity checks.

use forge_markets_tests::*;
use solana_sdk::pubkey::Pubkey;

const FIXTURE_ID: i64 = 12_345;
const STAT_KEY: u32 = 7;
/// The stat period the market binds (mirrors the real recorded proof's period = 4).
/// `settle` must be given a proof for THIS period; a different period reverts (F1).
const PERIOD: i32 = 4;

/// The "true" on-chain root the txoracle double holds.
fn true_root() -> [u8; 32] {
    let mut r = [0u8; 32];
    for (i, b) in r.iter_mut().enumerate() {
        *b = (i as u8).wrapping_mul(3).wrapping_add(1);
    }
    r
}

fn predicate() -> TraderPredicate {
    TraderPredicate {
        threshold: 1,
        comparison: Comparison::GreaterThan,
    }
}

type SettleArgs = (
    i64,
    ScoresBatchSummary,
    Vec<ProofNode>,
    Vec<ProofNode>,
    StatTerm,
    Option<StatTerm>,
    Option<BinaryExpression>,
);

/// Build the validate_stat argument fixtures for a submitted sub-tree root, with a
/// caller-chosen stat value. The double reverts (Err) on a root mismatch; otherwise
/// it evaluates `predicate()` (GreaterThan `threshold`) over `stat_value` and returns
/// `Ok(true|false)` — so a test drives YES vs NO by choosing `stat_value` relative to
/// the threshold, independently of the proof root.
fn settle_args_with_value(submitted_root: [u8; 32], stat_value: i32) -> SettleArgs {
    let summary = ScoresBatchSummary {
        fixture_id: FIXTURE_ID,
        update_stats: ScoresUpdateStats {
            update_count: 1,
            min_timestamp: 1_700_000_000,
            max_timestamp: 1_700_000_500,
        },
        events_sub_tree_root: submitted_root,
    };
    let stat_a = StatTerm {
        stat_to_prove: ScoreStat {
            key: STAT_KEY,
            value: stat_value,
            period: PERIOD,
        },
        event_stat_root: submitted_root,
        stat_proof: vec![ProofNode {
            hash: [9u8; 32],
            is_right_sibling: true,
        }],
    };
    (
        1_700_000_500,
        summary,
        vec![ProofNode {
            hash: [1u8; 32],
            is_right_sibling: false,
        }],
        vec![ProofNode {
            hash: [2u8; 32],
            is_right_sibling: true,
        }],
        stat_a,
        None,
        None,
    )
}

/// Default fixtures: stat value 2 > predicate threshold 1 → predicate holds → YES.
fn settle_args(submitted_root: [u8; 32]) -> SettleArgs {
    settle_args_with_value(submitted_root, 2)
}

/// create → both stakes; returns (env, market, staker_yes, staker_no).
fn setup_open_market(stake_yes: u64, stake_no: u64) -> (Env, Pubkey, Pubkey, Pubkey) {
    let mut env = Env::new();
    let authority = Pubkey::new_unique();
    let staker_y = Pubkey::new_unique();
    let staker_n = Pubkey::new_unique();
    env.set(authority, funded(100 * SOL));
    env.set(staker_y, funded(100 * SOL));
    env.set(staker_n, funded(100 * SOL));

    let (market, _) = market_pda(FIXTURE_ID, STAT_KEY);

    let res = env.process(&ix_create_market(
        &authority,
        FIXTURE_ID,
        STAT_KEY,
        &predicate(),
        PERIOD,
    ));
    assert!(
        res.program_result.is_ok(),
        "create_market failed: {:?}",
        res.program_result
    );

    let res = env.process(&ix_stake(&market, &staker_y, Side::Yes, stake_yes));
    assert!(
        res.program_result.is_ok(),
        "stake YES failed: {:?}",
        res.program_result
    );
    let res = env.process(&ix_stake(&market, &staker_n, Side::No, stake_no));
    assert!(
        res.program_result.is_ok(),
        "stake NO failed: {:?}",
        res.program_result
    );

    (env, market, staker_y, staker_n)
}

#[test]
fn anchor_disc_matches_idl() {
    // The settlement program serializes this disc for the CPI; the real txoracle
    // (and our double) dispatch on the same Anchor-derived bytes.
    assert_eq!(
        ix_disc("validate_stat"),
        VALIDATE_STAT_DISC_IDL,
        "validate_stat discriminator must equal the txoracle IDL's"
    );
}

#[test]
fn create_market_opens_market() {
    let (env, market, _, _) = setup_open_market(3 * SOL, 1 * SOL);
    let m = decode_market(&env.get(&market).data).expect("market decodes");
    assert_eq!(m.fixture_id, FIXTURE_ID);
    assert_eq!(m.stat_key, STAT_KEY);
    assert_eq!(m.state, MarketState::Open);
    assert_eq!(m.stake_yes, 3 * SOL);
    assert_eq!(m.stake_no, 1 * SOL);
    assert_eq!(m.predicate, predicate());

    // The vault holds exactly the pot (sum of stakes), nothing more.
    let (vault, _) = vault_pda(&market);
    assert_eq!(env.get(&vault).lamports, 4 * SOL, "vault holds the pot");
}

#[test]
fn happy_path_valid_proof_settles_yes_and_pays_out() {
    let (mut env, market, staker_y, staker_n) = setup_open_market(3 * SOL, 1 * SOL);
    let (vault, _) = vault_pda(&market);
    let (roots_key, _) = (Pubkey::new_unique(), 0u8);
    env.set(roots_key, daily_roots_account(&true_root()));

    // VALID: the submitted sub-tree root matches the on-chain root → CPI Ok.
    let (ts, summary, fp, mp, stat_a, stat_b, op) = settle_args(true_root());
    let res = env.process(&ix_settle(
        &market,
        &roots_key,
        &TXORACLE_ID,
        ts,
        &summary,
        &fp,
        &mp,
        &stat_a,
        &stat_b,
        &op,
    ));
    assert!(
        res.program_result.is_ok(),
        "settle with valid proof must succeed: {:?}",
        res.program_result
    );

    let m = decode_market(&env.get(&market).data).expect("market decodes");
    assert_eq!(m.state, MarketState::Settled, "market must be Settled");
    assert_eq!(m.winner, Side::Yes, "predicate held → YES wins");

    let pot = 4 * SOL;
    assert_eq!(env.get(&vault).lamports, pot, "pot intact pre-claim");

    // The single YES staker claims the whole pot pro-rata (3/3 of 4 SOL).
    let res = env.process(&ix_claim(&market, &staker_y));
    assert!(
        res.program_result.is_ok(),
        "winner claim must succeed: {:?}",
        res.program_result
    );
    assert_eq!(env.get(&vault).lamports, 0, "vault drained to the winner");
    let py = decode_position(&env.get(&position_pda(&market, &staker_y).0).data).unwrap();
    assert!(py.claimed, "position marked claimed");

    // The losing NO staker cannot claim.
    let res = env.process(&ix_claim(&market, &staker_n));
    assert!(
        res.program_result.is_err(),
        "losing side must not be able to claim: {:?}",
        res.program_result
    );
}

#[test]
fn predicate_false_settles_no_and_pays_the_no_side() {
    // Regression for the settle-outcome bug: a VALID proof (root matches → the CPI
    // does NOT revert) whose predicate is FALSE must settle NO — not be mis-recorded
    // as a YES win. The oracle returns Ok(false); settle must read that bool.
    let (mut env, market, staker_y, staker_n) = setup_open_market(3 * SOL, 1 * SOL);
    let (roots_key, _) = (Pubkey::new_unique(), 0u8);
    env.set(roots_key, daily_roots_account(&true_root()));

    // Valid root (no revert) BUT stat value 0 is not > threshold 1 → predicate false.
    let (ts, summary, fp, mp, stat_a, stat_b, op) = settle_args_with_value(true_root(), 0);
    let res = env.process(&ix_settle(
        &market,
        &roots_key,
        &TXORACLE_ID,
        ts,
        &summary,
        &fp,
        &mp,
        &stat_a,
        &stat_b,
        &op,
    ));
    assert!(
        res.program_result.is_ok(),
        "a valid proof with a false predicate must SETTLE (Ok(false)), not revert: {:?}",
        res.program_result
    );

    let m = decode_market(&env.get(&market).data).expect("market decodes");
    assert_eq!(
        m.state,
        MarketState::Settled,
        "predicate-false is still a settled outcome"
    );
    assert_eq!(
        m.winner,
        Side::No,
        "predicate did NOT hold → NO must win (bug: hardcoded YES paid the wrong side)"
    );

    // The NO staker (the real winner) claims the whole pot; the YES staker cannot.
    let (vault, _) = vault_pda(&market);
    let res = env.process(&ix_claim(&market, &staker_n));
    assert!(
        res.program_result.is_ok(),
        "NO winner claim must succeed: {:?}",
        res.program_result
    );
    assert_eq!(
        env.get(&vault).lamports,
        0,
        "vault drained to the NO winner"
    );
    let res = env.process(&ix_claim(&market, &staker_y));
    assert!(
        res.program_result.is_err(),
        "YES (losing) side must not be able to claim: {:?}",
        res.program_result
    );
}

#[test]
fn tampered_proof_reverts_settle() {
    let (mut env, market, _, _) = setup_open_market(3 * SOL, 1 * SOL);
    let (roots_key, _) = (Pubkey::new_unique(), 0u8);
    env.set(roots_key, daily_roots_account(&true_root()));

    // TAMPER: flip one byte of the submitted sub-tree root → mismatch vs the
    // on-chain root → validate_stat CPI fails → settle must revert.
    let mut tampered = true_root();
    tampered[0] ^= 0xFF;
    let (ts, summary, fp, mp, stat_a, stat_b, op) = settle_args(tampered);
    let res = env.process(&ix_settle(
        &market,
        &roots_key,
        &TXORACLE_ID,
        ts,
        &summary,
        &fp,
        &mp,
        &stat_a,
        &stat_b,
        &op,
    ));
    assert!(
        res.program_result.is_err(),
        "tampered proof must make settle revert: {:?}",
        res.program_result
    );

    // Market unchanged — still Open (settle folded nothing because it failed).
    let m = decode_market(&env.get(&market).data).expect("market decodes");
    assert_eq!(
        m.state,
        MarketState::Open,
        "market must stay Open after revert"
    );
}

#[test]
fn settle_rejects_wrong_oracle_program() {
    let (mut env, market, _, _) = setup_open_market(3 * SOL, 1 * SOL);
    let (roots_key, _) = (Pubkey::new_unique(), 0u8);
    env.set(roots_key, daily_roots_account(&true_root()));

    // A look-alike program id in the txoracle_program slot → the address
    // constraint must reject before any CPI happens.
    let impostor = Pubkey::new_unique();
    let (ts, summary, fp, mp, stat_a, stat_b, op) = settle_args(true_root());
    let res = env.process(&ix_settle(
        &market, &roots_key, &impostor, ts, &summary, &fp, &mp, &stat_a, &stat_b, &op,
    ));
    assert!(
        res.program_result.is_err(),
        "settle must reject a non-txoracle program: {:?}",
        res.program_result
    );
}

// ── F1 (audit finding, severity 9): market-binding of the oracle args ──────────
// `settle` is permissionless and the oracle only proves "this is a genuine stat in
// SOME genuine fixture" — it has no concept of THIS market. Without binding the
// caller-supplied fixture_summary / stat_a / stat_b / op to the market, an attacker
// settles against a DIFFERENT-but-genuine TxODDS data point whose value yields their
// preferred outcome (the oracle still returns Ok(true)), draining the pot. These
// tests submit args that WOULD satisfy the oracle (root matches → the double does
// NOT revert) but do NOT correspond to the market, and assert settle rejects them
// BEFORE the CPI. Each keeps the market Open (nothing folded).

#[test]
fn settle_rejects_fixture_id_mismatch() {
    let (mut env, market, _, _) = setup_open_market(3 * SOL, 1 * SOL);
    let (roots_key, _) = (Pubkey::new_unique(), 0u8);
    env.set(roots_key, daily_roots_account(&true_root()));

    // A genuine proof (root matches the seeded root → the oracle would say Ok(true))
    // whose fixture_id is NOT this market's fixture.
    let (ts, mut summary, fp, mp, stat_a, stat_b, op) = settle_args(true_root());
    summary.fixture_id = FIXTURE_ID + 999;
    let res = env.process(&ix_settle(
        &market, &roots_key, &TXORACLE_ID, ts, &summary, &fp, &mp, &stat_a, &stat_b, &op,
    ));
    assert!(
        res.program_result.is_err(),
        "settle must reject a fixture_id ≠ the market's (F1): {:?}",
        res.program_result
    );
    let m = decode_market(&env.get(&market).data).expect("market decodes");
    assert_eq!(
        m.state,
        MarketState::Open,
        "market must stay Open after a rejected settle"
    );
}

#[test]
fn settle_rejects_stat_key_mismatch() {
    let (mut env, market, _, _) = setup_open_market(3 * SOL, 1 * SOL);
    let (roots_key, _) = (Pubkey::new_unique(), 0u8);
    env.set(roots_key, daily_roots_account(&true_root()));

    // A genuine, provable stat — but for a DIFFERENT stat key than the market bound.
    let (ts, summary, fp, mp, mut stat_a, stat_b, op) = settle_args(true_root());
    stat_a.stat_to_prove.key = STAT_KEY + 1;
    let res = env.process(&ix_settle(
        &market, &roots_key, &TXORACLE_ID, ts, &summary, &fp, &mp, &stat_a, &stat_b, &op,
    ));
    assert!(
        res.program_result.is_err(),
        "settle must reject a stat_key ≠ the market's (F1): {:?}",
        res.program_result
    );
    let m = decode_market(&env.get(&market).data).expect("market decodes");
    assert_eq!(m.state, MarketState::Open, "market must stay Open");
}

#[test]
fn settle_rejects_multi_stat_expression() {
    let (mut env, market, _, _) = setup_open_market(3 * SOL, 1 * SOL);
    let (roots_key, _) = (Pubkey::new_unique(), 0u8);
    env.set(roots_key, daily_roots_account(&true_root()));

    // A second stat + a binary op could shift the evaluated value off the market's
    // single bound stat_key — the market predicate is single-stat, so reject any
    // two-stat settle.
    let (ts, summary, fp, mp, stat_a, _stat_b, _op) = settle_args(true_root());
    let stat_b = Some(stat_a.clone());
    let op = Some(BinaryExpression::Add);
    let res = env.process(&ix_settle(
        &market, &roots_key, &TXORACLE_ID, ts, &summary, &fp, &mp, &stat_a, &stat_b, &op,
    ));
    assert!(
        res.program_result.is_err(),
        "settle must reject a spurious stat_b/op (F1): {:?}",
        res.program_result
    );
    let m = decode_market(&env.get(&market).data).expect("market decodes");
    assert_eq!(m.state, MarketState::Open, "market must stay Open");
}

#[test]
fn settle_rejects_overlong_proof() {
    // Determinism / CU bound (SETTLEMENT-ENGINE.md): the engine `require!`s every
    // supplied Merkle proof is <= MAX_PROOF_NODES (32). A proof longer than that —
    // which would otherwise make settle cost an unbounded, caller-chosen amount of
    // CU — is rejected by the engine BEFORE the txoracle CPI, so settle reverts and
    // the market stays Open.
    let (mut env, market, _, _) = setup_open_market(3 * SOL, 1 * SOL);
    let (roots_key, _) = (Pubkey::new_unique(), 0u8);
    env.set(roots_key, daily_roots_account(&true_root()));

    let (ts, summary, _fp, mp, stat_a, stat_b, op) = settle_args(true_root());
    // 33 nodes > MAX_PROOF_NODES (32) in the fixture_proof.
    let overlong: Vec<ProofNode> = (0..33)
        .map(|_| ProofNode {
            hash: [7u8; 32],
            is_right_sibling: false,
        })
        .collect();
    let res = env.process(&ix_settle(
        &market, &roots_key, &TXORACLE_ID, ts, &summary, &overlong, &mp, &stat_a, &stat_b, &op,
    ));
    assert!(
        res.program_result.is_err(),
        "settle must reject an over-length proof (engine ProofTooLong): {:?}",
        res.program_result
    );
    let m = decode_market(&env.get(&market).data).expect("market decodes");
    assert_eq!(m.state, MarketState::Open, "market must stay Open");
}

#[test]
fn settle_rejects_period_mismatch() {
    let (mut env, market, _, _) = setup_open_market(3 * SOL, 1 * SOL);
    let (roots_key, _) = (Pubkey::new_unique(), 0u8);
    env.set(roots_key, daily_roots_account(&true_root()));

    // Same fixture + stat, but a proof for a DIFFERENT period (e.g. half-time vs
    // full-time). The stat value differs by period and would flip the outcome, so a
    // period ≠ the market's must be rejected.
    let (ts, summary, fp, mp, mut stat_a, stat_b, op) = settle_args(true_root());
    stat_a.stat_to_prove.period = PERIOD + 1;
    let res = env.process(&ix_settle(
        &market, &roots_key, &TXORACLE_ID, ts, &summary, &fp, &mp, &stat_a, &stat_b, &op,
    ));
    assert!(
        res.program_result.is_err(),
        "settle must reject a period ≠ the market's (F1): {:?}",
        res.program_result
    );
    let m = decode_market(&env.get(&market).data).expect("market decodes");
    assert_eq!(m.state, MarketState::Open, "market must stay Open");
}
