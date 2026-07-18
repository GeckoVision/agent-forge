"""Decision — turn a flagged sharp move into a policy-bounded bet intent.

``decide`` is the one trading rule of the offline core: back the direction of the sharp
money (implied probability rose -> bet the outcome holds, ``Yes``; fell -> ``No``), sized
within a risk ``RiskPolicy`` (a per-bet cap and a per-fixture cap). Sizing is deliberately
flat — the per-bet cap, clamped by the fixture's remaining room — so the decision is
deterministic and not overfit to one fixture; conviction-weighting is a later tuning knob,
not MVP scope.

The custody bound is SEPARATE and enforced downstream by the wallet
(:mod:`gorilla.wallet`): even a bet that sizes within the risk policy is refused if it
exceeds the wallet's spend cap or falls off its purpose allow-list. Two independent bounds,
defense in depth.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from .detector import SharpMove

# ``Yes`` == "the predicate/outcome held". The single source of truth for the bet side; the
# on-chain place_bet/settle client imports THIS to match the program's ``Side = Yes|No``.
Side = Literal["Yes", "No"]


@dataclass(frozen=True)
class RiskPolicy:
    """The trading-risk bound the decision sizes within (distinct from the wallet's custody
    ``Policy``). ``max_stake`` caps a single bet; ``max_per_fixture`` caps cumulative exposure
    to one fixture across a run."""

    max_stake: float
    max_per_fixture: float

    def __post_init__(self) -> None:
        if self.max_stake <= 0 or self.max_per_fixture <= 0:
            raise ValueError("risk caps must be positive")


@dataclass(frozen=True)
class BetIntent:
    """A policy-bounded bet the agent wants to place — the contract the on-chain
    place_bet/settle client consumes to build the ``place_bet`` transaction.

    ``fixture_id`` + ``market`` identify the on-chain ``Market`` PDA (seed
    ``[b"market", fixture_id, stat_key]``; ``market`` is the stat/market label the on-chain
    chunk maps to a ``stat_key``). ``side`` is ``Yes``/``No``; ``amount`` is the stake in
    stake units (devnet SOL in the on-chain chunk). ``rationale`` is off-chain audit metadata
    (which move drove the bet) — never sent on-chain.
    """

    fixture_id: int
    market: str
    side: Side
    amount: float
    rationale: str


def decide(
    move: SharpMove,
    policy: RiskPolicy,
    *,
    staked_on_fixture: float = 0.0,
) -> BetIntent | None:
    """Size a bet on ``move`` within ``policy``, or return ``None`` when the fixture has no
    room left under ``max_per_fixture``.

    ``staked_on_fixture`` is the amount already committed to this fixture in the current run
    (the agent tracks it), so the per-fixture cap holds across ticks. The stake is the per-bet
    cap clamped by the remaining fixture room; a non-positive room means no bet.
    """
    room = min(policy.max_stake, policy.max_per_fixture - staked_on_fixture)
    if room <= 0:
        return None
    side: Side = "Yes" if move.delta > 0 else "No"
    return BetIntent(
        fixture_id=move.fixture_id,
        market=f"{move.market}:{move.outcome}",
        side=side,
        amount=round(room, 6),
        rationale=move.summary(),
    )
