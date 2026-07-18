"""Decision — sharp move -> policy-bounded bet intent."""

from __future__ import annotations

import pytest

from gorilla.decision import BetIntent, RiskPolicy, decide
from gorilla.detector import SharpMove


def _move(delta: float, *, outcome: str = "Home") -> SharpMove:
    old, new = 45.0, 45.0 + delta
    return SharpMove(
        fixture_id=42,
        bookmaker="Pinnacle",
        market="1x2",
        outcome=outcome,
        old_pct=old,
        new_pct=new,
        delta=delta,
        ts=1000,
    )


def test_up_move_backs_yes():
    bet = decide(_move(+9.0), RiskPolicy(max_stake=10.0, max_per_fixture=25.0))
    assert isinstance(bet, BetIntent)
    assert bet.side == "Yes"
    assert bet.fixture_id == 42 and bet.market == "1x2:Home"
    assert "up" in bet.rationale


def test_down_move_backs_no():
    bet = decide(_move(-7.0, outcome="Away"), RiskPolicy(max_stake=10.0, max_per_fixture=25.0))
    assert isinstance(bet, BetIntent)
    assert bet.side == "No" and bet.market == "1x2:Away"


def test_amount_is_the_per_bet_cap_when_fixture_has_room():
    bet = decide(_move(+9.0), RiskPolicy(max_stake=8.0, max_per_fixture=100.0))
    assert bet is not None and bet.amount == 8.0


def test_amount_clamped_to_remaining_per_fixture_room():
    """Per-bet cap 10, but only 3 of the per-fixture budget is left -> stake clamps to 3."""
    bet = decide(
        _move(+9.0),
        RiskPolicy(max_stake=10.0, max_per_fixture=25.0),
        staked_on_fixture=22.0,
    )
    assert bet is not None and bet.amount == 3.0


def test_no_bet_when_fixture_cap_is_exhausted():
    bet = decide(
        _move(+9.0),
        RiskPolicy(max_stake=10.0, max_per_fixture=25.0),
        staked_on_fixture=25.0,
    )
    assert bet is None


def test_risk_caps_must_be_positive():
    with pytest.raises(ValueError, match="positive"):
        RiskPolicy(max_stake=0.0, max_per_fixture=25.0)
    with pytest.raises(ValueError, match="positive"):
        RiskPolicy(max_stake=10.0, max_per_fixture=-1.0)
