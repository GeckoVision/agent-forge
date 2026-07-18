# forge-markets — on-chain trustless prediction escrow (Anchor 1.0, devnet)

`forge_markets` is the settlement half of Gorilla Markets: a two-sided
prediction escrow over one TxODDS fixture stat. **The program never decides an
outcome.** `settle` CPIs `txoracle::validate_stat`; the oracle proves the stat
against its own on-chain Merkle root and evaluates the market's stored predicate.
A tampered proof makes the CPI fail, which reverts `settle` — that revert is the
whole trust guarantee.

- **Program id (devnet):** `7Pvo6SEh1zBa1Euvj5QQ4td9GpfsQosTpxhqwWtWUFt6`
- **CPI target (TxODDS txoracle, devnet):** `6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J`

## Layout

```
program/
├── Anchor.toml                 devnet; only forge_markets is a deploy target
├── Cargo.toml                  workspace (forge-markets, mock-txoracle, tests)
├── programs/
│   ├── forge-markets/          the settlement program (create_market/stake/settle/claim)
│   └── mock-txoracle/          Mollusk-only CPI test double (NEVER deployed to devnet)
├── tests/                      Mollusk suite (happy + tamper-revert exit gate)
└── .deploy-keys/               gitignored throwaway devnet keypairs
```

## Instructions

| Ix | Args | Signer | Notes |
|---|---|---|---|
| `create_market` | `fixture_id, stat_key, predicate` | authority | opens the escrow; stores the YES predicate |
| `stake` (= `place_bet`) | `side, amount` | staker | transfers lamports into the vault; records a `Position` |
| `settle` | `ts, fixture_summary, fixture_proof, main_tree_proof, stat_a, stat_b?, op?` | anyone | CPIs `validate_stat`; `Ok` ⇒ winner=Yes, Settled; `Err` ⇒ revert |
| `claim` | — | winning staker | pro-rata payout; the vault PDA signs |

PDAs: `Market [b"market", fixture_id, stat_key]`, `Vault [b"vault", market]`,
`Position [b"position", market, staker]` (all brand-free).

## Toolchain

`anchor-cli` 1.0.x (pinned to 1.0.2 in `Anchor.toml [toolchain]` via avm),
`solana-cli` / `cargo-build-sbf` 3.1.x (Agave), platform-tools v1.52,
`rustc`/`cargo` 1.94.x host. `anchor-lang` 1.0.2 (member crates), Mollusk 0.13 +
`solana-sdk` 3 + `borsh` 1 + `sha2` 0.10 (host test crate).

## Build

```bash
# forge_markets (Anchor deploy target) → target/deploy/forge_markets.so + IDL
anchor build

# mock-txoracle test double (NOT an Anchor member; build directly)
cargo build-sbf --manifest-path programs/mock-txoracle/Cargo.toml
```

## Test — the trust-critical Mollusk suite

Mollusk drives both programs in-process; it loads the `.so`s from `SBF_OUT_DIR`.

```bash
SBF_OUT_DIR="$(pwd)/target/deploy" cargo test -p forge-markets-tests
```

Exit gate (all must pass):
- `happy_path_valid_proof_settles_yes_and_pays_out` — valid proof ⇒ CPI Ok ⇒ YES wins ⇒ winner claims the pot pro-rata.
- `tampered_proof_reverts_settle` — a flipped root byte ⇒ CPI Err ⇒ `settle` reverts, market stays Open. **The trust headline.**
- `anchor_disc_matches_idl` — our Anchor-derived `validate_stat` discriminator equals the txoracle IDL's (byte-exact CPI).
- `create_market_opens_market`, `settle_rejects_wrong_oracle_program`.

## Deploy to devnet

Throwaway keypairs live in `.deploy-keys/` (gitignored). `declare_id!` is the
frozen identity; if the program keypair is lost, the program can only be
re-deployed at a new id (update `declare_id!`, `Anchor.toml`, and the test
`SETTLEMENT_ID`).

```bash
AUTH=.deploy-keys/deploy-authority.json
solana airdrop 2 "$(solana-keygen pubkey $AUTH)" --url devnet   # ~3.1 SOL rent needed; repeat if rate-limited
anchor deploy --provider.cluster devnet --provider.wallet "$AUTH"
```

`anchor deploy` reads the program keypair from `target/deploy/forge_markets-keypair.json`.

## mock-txoracle — Path (c) local fallback demo

The mock is a Mollusk-only stand-in loaded AT the real txoracle id. It is **never
deployed to devnet** (we don't own that keypair). For a local-validator demo of
the byte-exact CPI + tamper-revert, load it by address:

```bash
solana-test-validator \
  --bpf-program 6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J target/deploy/mock_txoracle.so \
  --bpf-program 7Pvo6SEh1zBa1Euvj5QQ4td9GpfsQosTpxhqwWtWUFt6 target/deploy/forge_markets.so
```
