"""M9 — the live end-to-end settlement loop on devnet (the trustless-settlement demo).

create_market (predicate that HOLDS for a real proof) -> agent detects a sharp move ->
LocalDevnetWallet stakes YES -> a counterparty stakes NO -> settle by CPI into the REAL
TxODDS oracle with the recorded proof -> assert winner=Yes, Settled -> the winner claims the
pot. Every transaction is signed by a policy-gated wallet and printed with an explorer link.

DEVNET-ONLY. The funder is the deploy authority; stakers are throwaway keypairs (gitignored).
A passing settle CONFIRMS the oracle returns Ok(bool) as the program's 1-byte decoder expects;
if it ever differed, settle fails CLOSED (funds safe) and the on-wire bytes are reported.

    # from backend/ (so ``gorilla`` is importable):
    PYTHONPATH=. uv run python scripts/e2e_settlement.py            # canonical run
    PYTHONPATH=. uv run python scripts/e2e_settlement.py --nonce 1  # fresh re-run
"""

from __future__ import annotations

import argparse
from pathlib import Path

from solders.keypair import Keypair

from gorilla.forge_client import load_recorded_proof
from gorilla.settlement import FORGE_BINDINGS, SettlementResult, run_settlement
from gorilla.solana_rpc import SolanaRpc
from gorilla.wallets import (
    ChainPolicy,
    LocalDevnetWallet,
    fund_if_low,
    load_keypair,
    load_or_create_keypair,
)

_HERE = Path(__file__).resolve().parent
FUNDER_KEY = _HERE.parent.parent / "program" / ".deploy-keys" / "deploy-authority.json"
PROOF_PATH = _HERE / "fixtures" / "recorded_stat_proof.json"
KEYS_DIR = _HERE / "keys"  # gitignored (**/keys/)

BASE_FIXTURE_ID = 18179549
STAT_KEY = 1


def _policy(purposes: set[str], cap: float) -> ChainPolicy:
    return ChainPolicy(
        max_spend=cap,
        allowed_purposes=frozenset(purposes),
        bindings={p: FORGE_BINDINGS[p] for p in purposes},
    )


def main() -> int:
    ap = argparse.ArgumentParser(description="Live devnet settlement e2e (forge_markets).")
    ap.add_argument(
        "--nonce", type=int, default=0, help="offset the market fixture_id for a fresh re-run"
    )
    ap.add_argument("--yes-sol", type=float, default=0.01, help="YES stake (devnet SOL)")
    ap.add_argument("--no-sol", type=float, default=0.005, help="NO stake (devnet SOL)")
    args = ap.parse_args()

    fixture_id = BASE_FIXTURE_ID + args.nonce
    rule = "=" * 78
    print(rule)
    print("Gorilla — live on-chain settlement loop (devnet, real TxODDS proof)")
    print(rule)

    rpc = SolanaRpc()
    funder_kp: Keypair = load_keypair(FUNDER_KEY)
    proof = load_recorded_proof(PROOF_PATH)
    print(
        f"funder (authority)   : {funder_kp.pubkey()}  {rpc.get_balance(str(funder_kp.pubkey())) / 1e9:.4f} SOL"
    )
    print(
        f"market fixture/stat  : {fixture_id} / {STAT_KEY}  (proof fixture {proof['summary']['fixtureId']})"
    )

    staker_yes_kp = load_or_create_keypair(KEYS_DIR / "staker-yes-keypair.json")
    staker_no_kp = load_or_create_keypair(KEYS_DIR / "staker-no-keypair.json")

    # setup: top the throwaway stakers up (rent + stake + fees head-room).
    for kp, target in ((staker_yes_kp, args.yes_sol + 0.02), (staker_no_kp, args.no_sol + 0.02)):
        sig = fund_if_low(rpc, funder_kp, kp.pubkey(), target)
        print(f"fund {kp.pubkey()} -> {'sent ' + sig if sig else 'already funded'}")

    funder = LocalDevnetWallet(keypair=funder_kp, rpc=rpc)
    funder.authorize(_policy({"create-market", "settle"}, cap=1.0))
    yes = LocalDevnetWallet(keypair=staker_yes_kp, rpc=rpc)
    yes.authorize(_policy({"place-bet", "claim"}, cap=args.yes_sol))
    no = LocalDevnetWallet(keypair=staker_no_kp, rpc=rpc)
    no.authorize(_policy({"place-bet", "claim"}, cap=args.no_sol))
    print("policies: funder{create-market,settle} · yes{place-bet,claim} · no{place-bet,claim}\n")

    result: SettlementResult = run_settlement(
        rpc=rpc,
        funder=funder,
        staker_yes=yes,
        staker_no=no,
        fixture_id=fixture_id,
        stat_key=STAT_KEY,
        proof=proof,
        yes_sol=args.yes_sol,
        no_sol=args.no_sol,
    )

    print("\n" + rule)
    print(f"SETTLED · market {result.market}")
    print(
        f"  winner = {result.winner}  state = {result.state}  "
        f"pot = {(result.stake_yes + result.stake_no) / 1e9:g} SOL"
    )
    print("  transaction signatures + explorer links:")
    for label, link in result.explorer_links().items():
        print(f"    {label:13s} {link}")
    print(f"\n  final balances: yes={yes.funded():.4f} SOL  no={no.funded():.4f} SOL")
    print(rule)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
