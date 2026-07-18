"""Live devnet settlement e2e — the FINAL smoke, opt-in only.

Skipped unless ``GORILLA_LIVE_E2E=1`` so a bare ``pytest`` never touches the network (the
offline suites in test_forge_client / test_wallets are the debugger; this is the confirmation).

    GORILLA_LIVE_E2E=1 uv run pytest tests/test_e2e_devnet.py -q -s
"""

from __future__ import annotations

import os
import time
from pathlib import Path

import pytest

pytestmark = pytest.mark.skipif(
    os.environ.get("GORILLA_LIVE_E2E") != "1",
    reason="live devnet e2e is opt-in (set GORILLA_LIVE_E2E=1)",
)

_HERE = Path(__file__).resolve().parent
FUNDER_KEY = _HERE.parent.parent / "program" / ".deploy-keys" / "deploy-authority.json"
PROOF_PATH = _HERE.parent / "scripts" / "fixtures" / "recorded_stat_proof.json"


def test_live_settlement_settles_yes_and_pays_the_winner():
    from gorilla.forge_client import load_recorded_proof
    from gorilla.settlement import FORGE_BINDINGS, run_settlement
    from gorilla.solana_rpc import SolanaRpc
    from gorilla.wallets import (
        ChainPolicy,
        LocalDevnetWallet,
        fund_if_low,
        load_keypair,
        load_or_create_keypair,
    )

    rpc = SolanaRpc()
    funder_kp = load_keypair(FUNDER_KEY)
    proof = load_recorded_proof(PROOF_PATH)
    fixture_id = 18179549 + (int(time.time()) % 90000)  # fresh market PDA per run
    yes_sol, no_sol = 0.01, 0.005

    keys = _HERE.parent / "scripts" / "keys"
    staker_yes = load_or_create_keypair(keys / "staker-yes-keypair.json")
    staker_no = load_or_create_keypair(keys / "staker-no-keypair.json")
    fund_if_low(rpc, funder_kp, staker_yes.pubkey(), yes_sol + 0.02)
    fund_if_low(rpc, funder_kp, staker_no.pubkey(), no_sol + 0.02)

    def policy(purposes: set[str], cap: float) -> ChainPolicy:
        return ChainPolicy(
            max_spend=cap,
            allowed_purposes=frozenset(purposes),
            bindings={p: FORGE_BINDINGS[p] for p in purposes},
        )

    funder = LocalDevnetWallet(keypair=funder_kp, rpc=rpc)
    funder.authorize(policy({"create-market", "settle"}, 1.0))
    yes = LocalDevnetWallet(keypair=staker_yes, rpc=rpc)
    yes.authorize(policy({"place-bet", "claim"}, yes_sol))
    no = LocalDevnetWallet(keypair=staker_no, rpc=rpc)
    no.authorize(policy({"place-bet", "claim"}, no_sol))

    result = run_settlement(
        rpc=rpc,
        funder=funder,
        staker_yes=yes,
        staker_no=no,
        fixture_id=fixture_id,
        stat_key=1,
        proof=proof,
        yes_sol=yes_sol,
        no_sol=no_sol,
    )

    # The oracle certified the predicate held -> the on-chain decode of Ok(bool) worked.
    assert result.winner == "Yes"
    assert result.state == "Settled"
    assert all(
        sig
        for sig in (
            result.create_sig,
            result.stake_yes_sig,
            result.stake_no_sig,
            result.settle_sig,
            result.claim_sig,
        )
    )
