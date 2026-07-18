"""The market-label collision bug — the one that fabricated signals out of real data.

TxLINE publishes the full-match and first-half ``1X2`` lines for a fixture INTERLEAVED at the
same timestamp. The label used to be ``SuperOddsType|MarketParameters``, which ignored
``MarketPeriod``, so those two genuinely different lines shared one detector key and the
detector read the alternation between them as a ~15pp "sharp move" every reading.

On the real France v England book this produced 1623 sharp moves out of 4172 real readings —
every one an artifact. With the period included, the same real data yields 2 genuine moves.

These tests use the exact interleaved shape observed on the live wire.
"""

from __future__ import annotations

from gorilla.detector import SharpDetector
from gorilla.txline_feed import _market_label, group_into_snapshots


def _rec(period, pct, ts, super_type="1X2_PARTICIPANT_RESULT", params=None):
    return {
        "FixtureId": 18257865,
        "BookmakerId": 10021,
        "Bookmaker": "TXLineStablePriceDemargined",
        "SuperOddsType": super_type,
        "MarketParameters": params,
        "MarketPeriod": period,
        "Ts": ts,
        "PriceNames": ["part1", "draw", "part2"],
        "Pct": pct,
    }


def test_market_period_is_part_of_the_label():
    """Full-match and first-half lines of the same type must NOT share a label."""
    full = _market_label(_rec(None, ["42.0", "31.0", "27.0"], 1))
    half = _market_label(_rec("half=1", ["31.0", "47.0", "22.0"], 1))
    assert full != half
    assert full == "1X2_PARTICIPANT_RESULT"
    assert half == "1X2_PARTICIPANT_RESULT|half=1"


def test_market_parameters_still_distinguish_lines():
    """The existing behaviour is preserved: different totals stay different markets."""
    over_2 = _market_label(_rec(None, [], 1, "OVERUNDER_PARTICIPANT_GOALS", "line=2"))
    over_25 = _market_label(_rec(None, [], 1, "OVERUNDER_PARTICIPANT_GOALS", "line=2.5"))
    assert over_2 == "OVERUNDER_PARTICIPANT_GOALS|line=2"
    assert over_2 != over_25


def test_params_and_period_combine():
    label = _market_label(_rec("half=1", [], 1, "OVERUNDER_PARTICIPANT_GOALS", "line=1"))
    assert label == "OVERUNDER_PARTICIPANT_GOALS|line=1|half=1"


def test_interleaved_periods_do_not_fabricate_a_sharp_move():
    """THE regression test. Two stable lines, interleaved, each barely moving: the detector
    must flag NOTHING. Before the fix this produced a ~15pp phantom move on every reading."""
    # Real-shaped values: full match sits ~31% on the draw, first half sits ~47%.
    records = []
    for i, ts in enumerate([1, 2, 3, 4, 5, 6]):
        drift = i * 0.01  # each line is essentially flat — no real move anywhere
        records.append(_rec(None, ["42.0", f"{31.0 + drift}", "27.0"], ts))
        records.append(_rec("half=1", ["31.0", f"{47.0 + drift}", "22.0"], ts))

    snapshots = group_into_snapshots(18257865, records)
    detector = SharpDetector(threshold_pct=3.0)
    moves = [m for m in (detector.observe(s) for s in snapshots) if m is not None]
    assert moves == [], f"fabricated {len(moves)} phantom move(s) from two flat lines"


def test_a_genuine_move_on_one_line_still_fires():
    """The fix must not silence real signals — only phantom ones."""
    records = []
    for i, ts in enumerate([1, 2, 3]):
        full_draw = 31.0 if i < 2 else 36.0  # a real +5pp move on the full-match line
        records.append(_rec(None, ["42.0", str(full_draw), "27.0"], ts))
        records.append(_rec("half=1", ["31.0", "47.0", "22.0"], ts))

    snapshots = group_into_snapshots(18257865, records)
    detector = SharpDetector(threshold_pct=3.0)
    moves = [m for m in (detector.observe(s) for s in snapshots) if m is not None]
    assert len(moves) == 1
    assert moves[0].market == "1X2_PARTICIPANT_RESULT"  # the full-match line, not the half
    assert moves[0].delta == 5.0


def test_group_into_snapshots_orders_by_timestamp_and_drops_unusable_lines():
    records = [
        _rec(None, ["42.0", "31.0", "27.0"], 30),
        _rec(None, ["NA", "NA", "NA"], 20),  # quarter-handicap: no usable probability
        _rec(None, ["41.0", "32.0", "27.0"], 10),
    ]
    snapshots = group_into_snapshots(18257865, records)
    assert [s.ts for s in snapshots] == [10, 30]  # sorted, and the NA reading dropped entirely
