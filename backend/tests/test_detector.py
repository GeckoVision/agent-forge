"""Sharp-move detector — pure logic, no network, no LLM, no feed."""

from __future__ import annotations

from gorilla.detector import OddsSnapshot, PriceQuote, SharpDetector, SharpMove


def _snap(pct: dict[str, float], *, ts: int = 1000, book_id: int = 7) -> OddsSnapshot:
    """One bookmaker's 1x2 line for fixture 42 at time ``ts``."""
    quote = PriceQuote(
        fixture_id=42,
        bookmaker="Acme",
        bookmaker_id=book_id,
        market="1x2",
        ts=ts,
        pct=pct,
    )
    return OddsSnapshot(fixture_id=42, ts=ts, quotes=(quote,))


def test_first_observation_sets_baseline_no_signal():
    det = SharpDetector(threshold_pct=3.0)
    assert det.observe(_snap({"Home": 50.0, "Away": 50.0})) is None


def test_fires_exactly_at_threshold():
    """At exactly the threshold the move fires (>=), not just above it."""
    det = SharpDetector(threshold_pct=3.0)
    det.observe(_snap({"Home": 50.0}, ts=1000))
    move = det.observe(_snap({"Home": 53.0}, ts=1060))  # delta == +3.000
    assert isinstance(move, SharpMove)
    assert move.delta == 3.0 and move.direction == "up"
    assert move.old_pct == 50.0 and move.new_pct == 53.0 and move.ts == 1060


def test_does_not_fire_below_threshold():
    det = SharpDetector(threshold_pct=3.0)
    det.observe(_snap({"Home": 50.0}))
    assert det.observe(_snap({"Home": 52.999})) is None  # delta +2.999 < 3.0


def test_returns_strongest_move_and_prefers_the_up_side_on_a_tie():
    """A symmetric 1x2 move (+9 / -9) returns the up-move (deterministic tie-break)."""
    det = SharpDetector(threshold_pct=3.0)
    det.observe(_snap({"Home": 45.0, "Away": 28.0}))
    move = det.observe(_snap({"Home": 54.0, "Away": 19.0}))  # both cross, |delta|==9
    assert isinstance(move, SharpMove)
    assert move.outcome == "Home" and move.delta == 9.0 and move.direction == "up"


def test_larger_move_wins_over_smaller_one():
    det = SharpDetector(threshold_pct=3.0)
    det.observe(_snap({"Home": 40.0, "Draw": 30.0}))
    move = det.observe(_snap({"Home": 44.0, "Draw": 22.0}))  # Home +4, Draw -8
    assert isinstance(move, SharpMove)
    assert move.outcome == "Draw" and move.delta == -8.0 and move.direction == "down"


def test_direction_and_summary_read_cleanly():
    det = SharpDetector(threshold_pct=3.0)
    det.observe(_snap({"Home": 50.0}, ts=1000))
    move = det.observe(_snap({"Home": 44.0}, ts=1060))  # delta -6.0
    assert isinstance(move, SharpMove)
    assert move.direction == "down"
    assert "fixture 42" in move.summary() and "-6.000 pp" in move.summary()


def test_distinct_books_tracked_independently():
    """A move on book 7 must not be attributed to book 9 (same fixture/market)."""
    det = SharpDetector(threshold_pct=3.0)
    both = OddsSnapshot(
        fixture_id=42,
        ts=1000,
        quotes=(
            PriceQuote(42, "Acme", 7, "1x2", 1000, {"Home": 50.0}),
            PriceQuote(42, "Zeta", 9, "1x2", 1000, {"Home": 50.0}),
        ),
    )
    det.observe(both)
    # Only book 7 updates sharply; book 9 unchanged -> the move is Acme's, never Zeta's.
    move = det.observe(_snap({"Home": 58.0}, book_id=7))
    assert isinstance(move, SharpMove) and move.bookmaker == "Acme"


def test_empty_snapshot_is_silent():
    """A placeholder/empty snapshot (recorded-mode offline) flags nothing, never crashes."""
    det = SharpDetector(threshold_pct=3.0)
    assert det.observe(OddsSnapshot(fixture_id=42, ts=0, quotes=())) is None


def test_threshold_must_be_positive():
    import pytest

    with pytest.raises(ValueError, match="positive"):
        SharpDetector(threshold_pct=0)
