"""The full offline loop — feed replay -> detect -> decide -> sign, end to end, $0.

Light fakes only (an injected scripted feed + a SandboxWallet); no network, no mocks.
"""

from __future__ import annotations

from gorilla.agent import (
    BET_PURPOSE,
    RefusedBet,
    SignedBet,
    run_agent,
    to_tx_intent,
)
from gorilla.decision import BetIntent, RiskPolicy
from gorilla.txline_feed import replay
from gorilla.wallet import Policy, SandboxWallet

_RISK = RiskPolicy(max_stake=10.0, max_per_fixture=25.0)


def _wallet(max_spend: float = 50.0) -> SandboxWallet:
    w = SandboxWallet(funded_amount=100.0)
    w.authorize(Policy(max_spend=max_spend, allowed_purposes=frozenset({BET_PURPOSE})))
    return w


def test_full_loop_produces_one_signed_bet_intent():
    run = run_agent(replay(fixture_id=42, move_at=3), wallet=_wallet(), policy=_RISK)
    assert len(run.signed) == 1 and not run.refused
    bet = run.signed[0].intent
    assert isinstance(bet, BetIntent)
    assert bet.side == "Yes"  # the scripted move is an up-move on Home
    assert bet.fixture_id == 42 and bet.amount == 10.0
    assert run.signed[0].result.ref.startswith("sandbox:")
    assert run.exposure == {42: 10.0}


def test_loop_is_deterministic():
    a = run_agent(replay(fixture_id=42), wallet=_wallet(), policy=_RISK)
    b = run_agent(replay(fixture_id=42), wallet=_wallet(), policy=_RISK)
    assert [s.result.ref for s in a.signed] == [s.result.ref for s in b.signed]


def test_wallet_refuses_an_over_cap_bet_before_signing():
    """Custody bound: a decision within the risk policy is still refused by a tight wallet cap,
    and the refusal is recorded (never raised), so the loop completes."""
    run = run_agent(replay(fixture_id=42, move_at=3), wallet=_wallet(max_spend=5.0), policy=_RISK)
    assert not run.signed
    assert len(run.refused) == 1
    assert isinstance(run.refused[0], RefusedBet)
    assert "cap" in run.refused[0].reason
    assert run.exposure == {}  # nothing committed


def test_no_move_no_bet():
    """A flat market (no sharp move) yields no bet and no refusal."""
    run = run_agent(
        replay(fixture_id=42, drift=0.1, move={"Home": 0.0, "Away": 0.0}),
        wallet=_wallet(),
        policy=_RISK,
    )
    assert not run.signed and not run.refused


def test_signed_result_is_a_bet_intent_not_a_raw_dict():
    run = run_agent(replay(fixture_id=42, move_at=3), wallet=_wallet(), policy=_RISK)
    assert all(isinstance(s, SignedBet) for s in run.signed)


def test_to_tx_intent_maps_side_and_amount_onto_the_custody_purpose():
    bet = BetIntent(fixture_id=42, market="1x2:Home", side="Yes", amount=7.5, rationale="r")
    tx = to_tx_intent(bet)
    assert tx.purpose == BET_PURPOSE and tx.amount == 7.5
    assert "Yes" in tx.description and "1x2:Home" in tx.description
