"""Privy Solana policy — falsified OFFLINE (Pattern B), no network.

The policy JSON is built, then run through :func:`simulate_privy_evaluation` (a model of Privy's
documented per-instruction engine) against the REAL forge_markets / System instructions the loop
signs. The live test-sign later confirms the enclave agrees; here we prove the design is right —
especially the load-bearing subtlety that the SOL cap must be a DENY rule, not an ALLOW.
"""

from __future__ import annotations

import pytest
from solders.instruction import Instruction
from solders.keypair import Keypair
from solders.system_program import TransferParams, transfer

from gorilla.forge_client import (
    COMPUTE_BUDGET_ID,
    FORGE_PROGRAM_ID,
    SYSTEM_PROGRAM_ID,
    TXORACLE_PROGRAM_ID,
    claim_tx,
    settle_tx,
    stake_tx,
    to_lamports,
)
from gorilla.privy_http import PrivyError
from gorilla.privy_policy import (
    DEFAULT_MAX_LAMPORTS,
    PrivyControlPlane,
    build_forge_markets_policy,
    simulate_privy_evaluation,
)

FIXTURE_ID = 18179549
STAT_KEY = 1
_ME = Keypair().pubkey()


def _self_transfer(lamports: int) -> Instruction:
    return transfer(TransferParams(from_pubkey=_ME, to_pubkey=_ME, lamports=lamports))


def _stake_ixs(sol: float = 0.01) -> list[Instruction]:
    return list(stake_tx(FIXTURE_ID, STAT_KEY, _ME, "Yes", to_lamports(sol)).instructions)


def _proof() -> dict:
    from pathlib import Path

    from gorilla.forge_client import load_recorded_proof

    here = Path(__file__).resolve().parent
    return load_recorded_proof(here.parent / "scripts" / "fixtures" / "recorded_stat_proof.json")


# ── policy document shape ──────────────────────────────────────────────────────────
def test_policy_document_shape():
    p = build_forge_markets_policy()
    assert p["version"] == "1.0"
    assert p["chain_type"] == "solana"
    assert 1 <= len(p["name"]) <= 50
    assert len(p["rules"]) == 2
    assert all(r["method"] == "signAndSendTransaction" for r in p["rules"])


def test_every_rule_name_is_within_privy_50_char_limit():
    """Regression: Privy rejects a rule name > 50 chars (400, verified live). Keep names short."""
    p = build_forge_markets_policy()
    assert all(1 <= len(r["name"]) <= 50 for r in p["rules"])


def test_program_allowlist_covers_forge_system_computebudget():
    p = build_forge_markets_policy()
    allow = next(r for r in p["rules"] if r["action"] == "ALLOW")
    cond = allow["conditions"][0]
    assert cond["field_source"] == "solana_program_instruction"
    assert cond["field"] == "programId"
    assert cond["operator"] == "in"
    assert set(cond["value"]) == {
        str(FORGE_PROGRAM_ID),
        str(SYSTEM_PROGRAM_ID),
        str(COMPUTE_BUDGET_ID),
    }


def test_sol_cap_is_a_deny_gt_rule_not_an_allow():
    """Load-bearing: Privy evaluates every instruction and DENY beats ALLOW. An ``ALLOW lte cap``
    would be silently overridden by the program-allowlist ALLOW, so only a ``DENY gt cap`` caps
    value. Guard the exact operator/action so a refactor can't quietly weaken the cap."""
    p = build_forge_markets_policy(cap_lamports=DEFAULT_MAX_LAMPORTS)
    deny = next(r for r in p["rules"] if r["action"] == "DENY")
    cond = deny["conditions"][0]
    assert cond["field_source"] == "solana_system_program_instruction"
    assert cond["field"] == "Transfer.lamports"
    assert cond["operator"] == "gt"
    assert cond["value"] == str(DEFAULT_MAX_LAMPORTS)


def test_policy_name_bounds_enforced():
    with pytest.raises(ValueError, match="1-50"):
        build_forge_markets_policy(name="x" * 51)
    with pytest.raises(ValueError, match="cap"):
        build_forge_markets_policy(cap_lamports=0)


# ── offline evaluation against REAL instructions ────────────────────────────────────
def test_evaluator_allows_the_forge_loop_and_the_test_sign():
    p = build_forge_markets_policy()
    assert simulate_privy_evaluation(p, _stake_ixs()) is True
    assert simulate_privy_evaluation(p, list(claim_tx(FIXTURE_ID, STAT_KEY, _ME).instructions))
    # settle carries [ComputeBudget prelude, settle] — both programs are allow-listed.
    settle = list(settle_tx(FIXTURE_ID, STAT_KEY, _proof()).instructions)
    assert len(settle) == 2
    assert simulate_privy_evaluation(p, settle) is True
    # the enclave-path test-sign (0-lamport System self-transfer) is within policy.
    assert simulate_privy_evaluation(p, [_self_transfer(0)]) is True
    assert simulate_privy_evaluation(p, [_self_transfer(to_lamports(0.01))]) is True


def test_evaluator_denies_over_cap_transfer():
    p = build_forge_markets_policy()  # cap 0.05 SOL
    assert simulate_privy_evaluation(p, [_self_transfer(to_lamports(0.05) + 1)]) is False
    assert simulate_privy_evaluation(p, [_self_transfer(to_lamports(0.1))]) is False
    # exactly at the cap is allowed (gt, not gte).
    assert simulate_privy_evaluation(p, [_self_transfer(to_lamports(0.05))]) is True


def test_evaluator_denies_off_allowlist_program():
    p = build_forge_markets_policy()
    # txoracle is NOT in the allow-list (only forge/system/computebudget are).
    off = Instruction(TXORACLE_PROGRAM_ID, b"\x00" * 8, [])
    assert simulate_privy_evaluation(p, [off]) is False
    # a stray program mixed into an otherwise-fine tx fails the whole tx (every ix must ALLOW).
    assert simulate_privy_evaluation(p, [*_stake_ixs(), off]) is False


def test_evaluator_denies_over_cap_even_mixed_with_forge():
    p = build_forge_markets_policy()
    mixed = [*_stake_ixs(), _self_transfer(to_lamports(1.0))]
    assert simulate_privy_evaluation(p, mixed) is False


def test_custom_cap_and_programs_are_honored():
    tiny = build_forge_markets_policy(
        cap_lamports=1_000, allowed_program_ids=(str(FORGE_PROGRAM_ID),)
    )
    # System program no longer allow-listed -> a self-transfer is denied.
    assert simulate_privy_evaluation(tiny, [_self_transfer(0)]) is False
    # forge stake still allowed.
    assert simulate_privy_evaluation(tiny, _stake_ixs()) is True


# ── control plane: create + attach + read, transport injected (no network) ──────────
class FakeControlTransport:
    def __init__(self, *, policy_id: str = "pol_abc123", wallet: dict | None = None) -> None:
        self.policy_id = policy_id
        self.wallet = wallet or {"id": "w", "owner_id": None, "policy_ids": []}
        self.calls: list[tuple[str, str, dict | None]] = []

    def __call__(self, method: str, path: str, body: dict | None) -> dict:
        self.calls.append((method, path, body))
        if method == "POST" and path == "/v1/policies":
            return {"id": self.policy_id, **(body or {})}
        if method == "PATCH":
            return {**self.wallet, "policy_ids": (body or {}).get("policy_ids", [])}
        return self.wallet


def test_create_policy_posts_and_returns_id():
    t = FakeControlTransport()
    cp = PrivyControlPlane("app", "secret", transport=t)
    pid = cp.create_policy(build_forge_markets_policy())
    assert pid == "pol_abc123"
    method, path, body = t.calls[0]
    assert (method, path) == ("POST", "/v1/policies")
    assert body is not None and body["chain_type"] == "solana"


def test_attach_policy_patches_wallet_policy_ids():
    t = FakeControlTransport()
    cp = PrivyControlPlane("app", "secret", transport=t)
    resp = cp.attach_policy("vhjrgx9dao8x2nv725n0050o", "pol_abc123")
    assert resp["policy_ids"] == ["pol_abc123"]
    method, path, body = t.calls[0]
    assert method == "PATCH"
    assert path == "/v1/wallets/vhjrgx9dao8x2nv725n0050o"
    assert body == {"policy_ids": ["pol_abc123"]}


def test_create_policy_without_id_raises():
    def bad(method: str, path: str, body: dict | None) -> dict:
        return {"error": "nope"}

    cp = PrivyControlPlane("app", "secret", transport=bad)
    with pytest.raises(PrivyError, match="no id"):
        cp.create_policy(build_forge_markets_policy())


def test_get_wallet_reads_owner_and_policies():
    t = FakeControlTransport(wallet={"id": "w", "owner_id": None, "policy_ids": ["pol_abc123"]})
    cp = PrivyControlPlane("app", "secret", transport=t)
    w = cp.get_wallet("w")
    assert w["owner_id"] is None
    assert w["policy_ids"] == ["pol_abc123"]
