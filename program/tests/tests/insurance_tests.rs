//! forge-insurance Mollusk suite — the SECOND consumer of the settlement engine.
//!
//! Together with settlement_tests.rs (forge-markets), this is the killer artifact:
//! two structurally different programs CPI the SAME `settlement_core` engine (→ the
//! mock-txoracle double), each settling correctly on Ok(true)/Ok(false), each with a
//! tamper-revert. forge-insurance re-implements NO CPI or F1-binding logic — it only
//! calls the engine — so its trust properties are INHERITED from the shared primitive.
//!
//! Coverage:
//!   - event occurs (predicate held → engine Ok(true))  → insured indemnified,
//!     insurer keeps premium, vault drained;
//!   - event does NOT occur (engine Ok(false))          → insurer recovers
//!     coverage + premium, vault drained;
//!   - tampered proof (root mismatch → engine Err)      → settle_policy reverts,
//!     policy stays Funded, the vault is untouched.

use forge_markets_tests::*;
use solana_sdk::pubkey::Pubkey;

const FIXTURE_ID: i64 = 555;
const STAT_KEY: u32 = 3;
const PERIOD: i32 = 2;
const COVERAGE: u64 = 5 * SOL;
const PREMIUM: u64 = 1 * SOL;

fn true_root() -> [u8; 32] {
    let mut r = [0u8; 32];
    for (i, b) in r.iter_mut().enumerate() {
        *b = (i as u8).wrapping_mul(3).wrapping_add(1);
    }
    r
}

/// Event condition: stat value > 1.
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

/// open_policy → bind_policy; returns (env, policy, insurer, insured, roots_key).
fn setup_funded_policy() -> (Env, Pubkey, Pubkey, Pubkey, Pubkey) {
    let mut env = Env::new();
    let insurer = Pubkey::new_unique();
    let insured = Pubkey::new_unique();
    env.set(insurer, funded(100 * SOL));
    env.set(insured, funded(100 * SOL));

    let (policy, _) = policy_pda(FIXTURE_ID, STAT_KEY, &insured);

    let res = env.process(&ix_open_policy(
        &insurer,
        &insured,
        FIXTURE_ID,
        STAT_KEY,
        PERIOD,
        &predicate(),
        COVERAGE,
    ));
    assert!(
        res.program_result.is_ok(),
        "open_policy failed: {:?}",
        res.program_result
    );

    let res = env.process(&ix_bind_policy(&policy, &insured, PREMIUM));
    assert!(
        res.program_result.is_ok(),
        "bind_policy failed: {:?}",
        res.program_result
    );

    let p = decode_policy(&env.get(&policy).data).expect("policy decodes");
    assert_eq!(p.state, PolicyState::Funded, "policy funded after bind");

    let (pvault, _) = pvault_pda(&policy);
    assert_eq!(
        env.get(&pvault).lamports,
        COVERAGE + PREMIUM,
        "vault holds coverage + premium"
    );

    let roots_key = Pubkey::new_unique();
    env.set(roots_key, daily_roots_account(&true_root()));
    (env, policy, insurer, insured, roots_key)
}

#[test]
fn insurance_event_occurs_indemnifies_insured() {
    let (mut env, policy, insurer, insured, roots_key) = setup_funded_policy();
    let (pvault, _) = pvault_pda(&policy);

    // Valid proof (root matches) + stat value 5 > threshold 1 → event occurs.
    let (ts, summary, fp, mp, stat_a, sb, op) = settle_args_with_value(true_root(), 5);
    let res = env.process(&ix_settle_policy(
        &policy, &roots_key, &TXORACLE_ID, ts, &summary, &fp, &mp, &stat_a, &sb, &op,
    ));
    assert!(
        res.program_result.is_ok(),
        "settle_policy (event) must succeed: {:?}",
        res.program_result
    );
    let p = decode_policy(&env.get(&policy).data).unwrap();
    assert_eq!(p.state, PolicyState::Settled);
    assert!(p.event_occurred, "predicate held → event occurred");

    let insured_before = env.get(&insured).lamports;
    let insurer_before = env.get(&insurer).lamports;

    // The insured (a party) triggers the release.
    let res = env.process(&ix_claim_policy(&policy, &insured, &insurer, &insured));
    assert!(
        res.program_result.is_ok(),
        "claim (event) must succeed: {:?}",
        res.program_result
    );

    assert_eq!(
        env.get(&insured).lamports - insured_before,
        COVERAGE,
        "insured is indemnified the coverage"
    );
    assert_eq!(
        env.get(&insurer).lamports - insurer_before,
        PREMIUM,
        "insurer keeps the earned premium"
    );
    assert_eq!(env.get(&pvault).lamports, 0, "vault fully drained");

    let p = decode_policy(&env.get(&policy).data).unwrap();
    assert!(p.claimed, "policy marked claimed");
    assert_eq!(p.state, PolicyState::Claimed);

    // No double claim.
    let res = env.process(&ix_claim_policy(&policy, &insured, &insurer, &insured));
    assert!(
        res.program_result.is_err(),
        "second claim must fail: {:?}",
        res.program_result
    );
}

#[test]
fn insurance_no_event_returns_pot_to_insurer() {
    let (mut env, policy, insurer, insured, roots_key) = setup_funded_policy();
    let (pvault, _) = pvault_pda(&policy);

    // Valid proof (root matches) + stat value 0, NOT > 1 → event does NOT occur.
    let (ts, summary, fp, mp, stat_a, sb, op) = settle_args_with_value(true_root(), 0);
    let res = env.process(&ix_settle_policy(
        &policy, &roots_key, &TXORACLE_ID, ts, &summary, &fp, &mp, &stat_a, &sb, &op,
    ));
    assert!(
        res.program_result.is_ok(),
        "settle_policy (no event) must succeed (Ok(false), not revert): {:?}",
        res.program_result
    );
    let p = decode_policy(&env.get(&policy).data).unwrap();
    assert!(!p.event_occurred, "predicate did not hold → no event");

    let insured_before = env.get(&insured).lamports;
    let insurer_before = env.get(&insurer).lamports;

    // The insurer (a party) triggers the release.
    let res = env.process(&ix_claim_policy(&policy, &insured, &insurer, &insurer));
    assert!(
        res.program_result.is_ok(),
        "claim (no event) must succeed: {:?}",
        res.program_result
    );

    assert_eq!(
        env.get(&insurer).lamports - insurer_before,
        COVERAGE + PREMIUM,
        "insurer recovers coverage + keeps premium"
    );
    assert_eq!(
        env.get(&insured).lamports,
        insured_before,
        "insured receives nothing on a no-event outcome"
    );
    assert_eq!(env.get(&pvault).lamports, 0, "vault fully drained");
}

#[test]
fn insurance_tampered_proof_reverts_and_leaves_funds_untouched() {
    let (mut env, policy, _insurer, _insured, roots_key) = setup_funded_policy();
    let (pvault, _) = pvault_pda(&policy);
    let vault_before = env.get(&pvault).lamports;

    // TAMPER: flip one byte of the submitted root → mismatch vs the on-chain root →
    // the engine's validate_stat CPI Errs → resolve Errs → settle_policy reverts.
    let mut tampered = true_root();
    tampered[0] ^= 0xFF;
    let (ts, summary, fp, mp, stat_a, sb, op) = settle_args_with_value(tampered, 5);
    let res = env.process(&ix_settle_policy(
        &policy, &roots_key, &TXORACLE_ID, ts, &summary, &fp, &mp, &stat_a, &sb, &op,
    ));
    assert!(
        res.program_result.is_err(),
        "tampered proof must make settle_policy revert: {:?}",
        res.program_result
    );

    // Policy unchanged — still Funded, vault intact.
    let p = decode_policy(&env.get(&policy).data).expect("policy decodes");
    assert_eq!(
        p.state,
        PolicyState::Funded,
        "policy must stay Funded after revert"
    );
    assert!(!p.event_occurred);
    assert_eq!(
        env.get(&pvault).lamports,
        vault_before,
        "vault untouched after revert"
    );
}

#[test]
fn insurance_settle_rejects_fixture_mismatch_via_engine() {
    // The F1 binding lives in the engine now — prove forge-insurance inherits it: a
    // genuine proof (root matches) for a DIFFERENT fixture is rejected by the engine,
    // reverting settle_policy. The policy never leaves Funded.
    let (mut env, policy, _insurer, _insured, roots_key) = setup_funded_policy();
    let (ts, mut summary, fp, mp, stat_a, sb, op) = settle_args_with_value(true_root(), 5);
    summary.fixture_id = FIXTURE_ID + 999;
    let res = env.process(&ix_settle_policy(
        &policy, &roots_key, &TXORACLE_ID, ts, &summary, &fp, &mp, &stat_a, &sb, &op,
    ));
    assert!(
        res.program_result.is_err(),
        "engine F1 fixture binding must reject (inherited by insurance): {:?}",
        res.program_result
    );
    let p = decode_policy(&env.get(&policy).data).unwrap();
    assert_eq!(p.state, PolicyState::Funded, "policy stays Funded");
}
