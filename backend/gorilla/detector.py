"""Sharp-move detection — pure logic over typed odds snapshots.

No network, no feed dependency, no LLM. Given successive ``OddsSnapshot`` readings for a
fixture, the detector tracks each price line's implied probability and flags a *sharp move*
when that probability shifts past a threshold (percentage points) between readings. That
signal — which book, which market, which outcome, how far, which way — is what the decision
step turns into a bet.

``OddsSnapshot`` / ``PriceQuote`` are defined HERE, alongside the detector, so the detection
logic is a self-contained, dependency-free unit that its tests can exercise without importing
anything else. The feed (:mod:`gorilla.txline_feed`) produces these types from the wire;
the detector consumes them.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass

# A price line's identity within a fixture: which book, which market, which outcome.
PriceKey = tuple[int, int, str, str]  # (fixture_id, bookmaker_id, market, outcome)


@dataclass(frozen=True)
class PriceQuote:
    """One bookmaker's offer on one market line at a moment: outcome -> implied prob (pp).

    ``pct`` maps each outcome name to its implied probability in percentage points. Lines the
    upstream feed reports as ``NA`` (quarter-handicap) or otherwise unparseable are dropped by
    the feed BEFORE they reach here, so every value in ``pct`` is a real float.
    """

    fixture_id: int
    bookmaker: str
    bookmaker_id: int
    market: str
    ts: int
    pct: Mapping[str, float]


@dataclass(frozen=True)
class OddsSnapshot:
    """A fixture's odds at one instant — the feed's typed unit and the detector's input.

    ``quotes`` is every bookmaker/market line seen in this reading. Offline, recorded mode may
    yield an empty or placeholder snapshot (see ``txline_feed``); the detector simply flags
    nothing from it rather than crashing.
    """

    fixture_id: int
    ts: int
    quotes: tuple[PriceQuote, ...]


@dataclass(frozen=True)
class SharpMove:
    """One flagged shift in an outcome's implied probability."""

    fixture_id: int
    bookmaker: str
    market: str
    outcome: str
    old_pct: float
    new_pct: float
    delta: float  # new_pct - old_pct, signed, in percentage points
    ts: int

    @property
    def direction(self) -> str:
        return "up" if self.delta > 0 else "down"

    def summary(self) -> str:
        return (
            f"[{self.market}] fixture {self.fixture_id} · {self.bookmaker} · "
            f"{self.outcome}: {self.old_pct:.3f}% → {self.new_pct:.3f}% "
            f"({self.delta:+.3f} pp, {self.direction})"
        )


class SharpDetector:
    """Stateful across readings: remembers each line's last implied probability.

    ``observe`` a snapshot and get back THE sharp move — the single largest crossing by
    absolute delta (ties resolved toward the up-move, then outcome name, for determinism) — or
    ``None`` when nothing crossed the threshold. Every line's baseline is updated on every
    observation, so a smaller simultaneous crossing is never lost to *future* detection; it is
    only not the move acted on this tick (one agent, one bet per reading — the small surface
    the demo needs). The first sighting of any line only sets its baseline.
    """

    def __init__(self, *, threshold_pct: float = 3.0) -> None:
        if threshold_pct <= 0:
            raise ValueError("threshold_pct must be positive")
        self.threshold = threshold_pct
        self._last: dict[PriceKey, float] = {}

    def observe(self, snapshot: OddsSnapshot) -> SharpMove | None:
        crossings: list[SharpMove] = []
        for quote in snapshot.quotes:
            for outcome, pct in quote.pct.items():
                key: PriceKey = (
                    quote.fixture_id,
                    quote.bookmaker_id,
                    quote.market,
                    outcome,
                )
                prev = self._last.get(key)
                self._last[key] = pct
                if prev is None:
                    continue  # baseline only — never fires on first sight
                delta = round(pct - prev, 3)
                if abs(delta) >= self.threshold:
                    crossings.append(
                        SharpMove(
                            fixture_id=quote.fixture_id,
                            bookmaker=quote.bookmaker,
                            market=quote.market,
                            outcome=outcome,
                            old_pct=prev,
                            new_pct=pct,
                            delta=delta,
                            ts=quote.ts,
                        )
                    )
        if not crossings:
            return None
        # Strongest by |delta|; tie -> larger signed delta (the up-move) -> outcome name.
        return max(crossings, key=lambda m: (abs(m.delta), m.delta, m.outcome))
