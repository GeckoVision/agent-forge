//! GATE — the make-or-break probe for the settlement-engine extraction.
//!
//! SETTLEMENT-ENGINE.md names as its #1 technical risk: does Solana return-data
//! survive a two-hop CPI? The engine-PROGRAM design (option A: a thin program
//! others CPI) depends on it. After the engine CPIs txoracle, `get_return_data()`
//! holds txoracle's bytes; the engine's own `Ok(bool)` return must OVERWRITE that,
//! so a consumer that CPIs the engine and reads immediately gets the ENGINE's bool.
//!
//! This suite wires a trivial consumer → trivial engine → mock-txoracle and proves
//! the consumer recovers the engine's returned bool for BOTH Ok(true) and Ok(false).
//! To make it DISCRIMINATING, `gate_engine::relay` returns the NEGATION of the
//! oracle's bool: if Anchor did NOT re-set return data on the engine's return, the
//! consumer would read txoracle's un-negated leftover and these assertions would
//! fail. Green here ⇒ the engine-program hop is real ⇒ proceed with the extraction.

use borsh::{BorshDeserialize, BorshSerialize};
use mollusk_svm::program::create_program_account_loader_v3;
use mollusk_svm::Mollusk;
use sha2::{Digest, Sha256};
use solana_sdk::account::Account;
use solana_sdk::instruction::{AccountMeta, Instruction};
use solana_sdk::pubkey::Pubkey;

const GATE_ENGINE_ID: Pubkey = solana_sdk::pubkey!("9G418GNv2hnfNsGZwJ8rMJeJuqn6ng5VkL9tyRQodp73");
const GATE_CONSUMER_ID: Pubkey =
    solana_sdk::pubkey!("63tVMMkpEvayZAJSxhoUsmpHqen6PqAqnUqyJYJXMi8b");
const TXORACLE_ID: Pubkey = solana_sdk::pubkey!("6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J");
const SYSTEM_PROGRAM: Pubkey = solana_sdk::pubkey!("11111111111111111111111111111111");

fn ix_disc(name: &str) -> [u8; 8] {
    let mut h = Sha256::new();
    h.update(b"global:");
    h.update(name.as_bytes());
    let out = h.finalize();
    let mut d = [0u8; 8];
    d.copy_from_slice(&out[0..8]);
    d
}

fn true_root() -> [u8; 32] {
    let mut r = [0u8; 32];
    for (i, b) in r.iter_mut().enumerate() {
        *b = (i as u8).wrapping_mul(3).wrapping_add(1);
    }
    r
}

fn daily_roots_account(root: &[u8; 32]) -> Account {
    let mut data = vec![0u8; 64];
    data[0..32].copy_from_slice(root);
    Account {
        lamports: 5_000_000,
        data,
        owner: TXORACLE_ID,
        executable: false,
        rent_epoch: 0,
    }
}

/// The consumer-owned scratch account whose byte[0] receives the returned bool.
fn result_account() -> Account {
    Account {
        lamports: 1_000_000,
        data: vec![0u8; 1],
        owner: GATE_CONSUMER_ID,
        executable: false,
        rent_epoch: 0,
    }
}

fn program_stub(id: &Pubkey) -> Account {
    create_program_account_loader_v3(id)
}

/// Drive the whole hop for a given `steer` (the stat value the engine feeds the
/// oracle, compared `GreaterThan 1`). Returns the byte the consumer recorded.
fn run_probe(steer: i32) -> (bool, u8) {
    let mut mollusk = Mollusk::new(&GATE_CONSUMER_ID, "gate_consumer");
    mollusk.add_program(&GATE_ENGINE_ID, "gate_engine");
    mollusk.add_program(&TXORACLE_ID, "mock_txoracle");

    let roots_key = Pubkey::new_unique();
    let result_key = Pubkey::new_unique();

    let mut data = ix_disc("probe").to_vec();
    data.extend_from_slice(&borsh::to_vec(&steer).unwrap());

    let ix = Instruction {
        program_id: GATE_CONSUMER_ID,
        accounts: vec![
            AccountMeta::new_readonly(GATE_ENGINE_ID, false),
            AccountMeta::new_readonly(roots_key, false),
            AccountMeta::new_readonly(TXORACLE_ID, false),
            AccountMeta::new(result_key, false),
        ],
        data,
    };

    let accounts = vec![
        (GATE_ENGINE_ID, program_stub(&GATE_ENGINE_ID)),
        (roots_key, daily_roots_account(&true_root())),
        (TXORACLE_ID, program_stub(&TXORACLE_ID)),
        (result_key, result_account()),
    ];

    let res = mollusk.process_instruction(&ix, &accounts);
    let ok = res.program_result.is_ok();
    let byte = res
        .resulting_accounts
        .iter()
        .find(|(k, _)| *k == result_key)
        .map(|(_, a)| a.data.first().copied().unwrap_or(0xEE))
        .unwrap_or(0xEE);
    (ok, byte)
}

#[test]
fn gate_two_hop_return_data_survives_ok_true() {
    // Oracle sees value 5 > 1 → Ok(true). Engine returns !true = false. If the
    // consumer reads the engine's re-set return data, it records 0 (false).
    let (ok, byte) = run_probe(5);
    assert!(ok, "consumer probe must succeed on the true path");
    assert_eq!(
        byte, 0,
        "consumer must read the ENGINE's bool (!oracle_true = false); reading \
         txoracle's leftover would wrongly give 1"
    );
}

#[test]
fn gate_two_hop_return_data_survives_ok_false() {
    // Oracle sees value 0, not > 1 → Ok(false). Engine returns !false = true. The
    // consumer must record 1 (true) — the engine's negated value, not the leftover 0.
    let (ok, byte) = run_probe(0);
    assert!(ok, "consumer probe must succeed on the false path");
    assert_eq!(
        byte, 1,
        "consumer must read the ENGINE's bool (!oracle_false = true); reading \
         txoracle's leftover would wrongly give 0"
    );
}

/// A borsh round-trip sanity so the disc computation matches Anchor's convention.
#[test]
fn probe_disc_is_stable() {
    assert_eq!(ix_disc("probe").len(), 8);
    #[derive(BorshSerialize, BorshDeserialize)]
    struct S {
        v: i32,
    }
    let b = borsh::to_vec(&S { v: 7 }).unwrap();
    assert_eq!(S::try_from_slice(&b).unwrap().v, 7);
}
