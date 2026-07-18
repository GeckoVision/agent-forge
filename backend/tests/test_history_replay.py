"""The REAL captured-history fallback.

When the live World Cup API closes, the agent replays the exact wire records that came off it —
never the synthetic placeholder. These tests build a tiny capture in a tmp dir shaped exactly
like the real one (compact JSON, one record per line, day-partitioned) and pin that:

  * the replay produces the same typed snapshots the live path does;
  * a MISSING capture fails loudly instead of quietly degrading into synthesized prices;
  * the compact-JSON record shape is matched (the real capture writes ``{"FixtureId":123,...}``
    with NO space after the colon — a separator-sensitive scan silently finds nothing).
"""

from __future__ import annotations

import json

import pytest

from gorilla.txline_feed import (
    HISTORY_PATH_ENV,
    FeedError,
    history_dir,
    history_replay,
)

FIXTURE_ID = 18257865
OTHER_FIXTURE = 18257739


def _record(fixture_id, ts, pct, period=None, params="line=2"):
    return {
        "FixtureId": fixture_id,
        "BookmakerId": 10021,
        "Bookmaker": "TXLineStablePriceDemargined",
        "SuperOddsType": "OVERUNDER_PARTICIPANT_GOALS",
        "MarketParameters": params,
        "MarketPeriod": period,
        "Ts": ts,
        "PriceNames": ["over", "under"],
        "Pct": pct,
    }


def _write_capture(tmp_path, records_by_day):
    odds = tmp_path / "raw" / "odds"
    odds.mkdir(parents=True)
    for day, records in records_by_day.items():
        # COMPACT separators — exactly how the real capture is written.
        lines = [json.dumps(r, separators=(",", ":")) for r in records]
        (odds / f"day-{day}.jsonl").write_text("\n".join(lines) + "\n")
    return tmp_path


def test_replay_reads_the_compact_json_the_real_capture_writes(tmp_path):
    """The bug this pins: the capture has NO space after the colon, so a needle of
    ``'"FixtureId": 123'`` matches nothing and the fallback wrongly reports 'no odds'."""
    _write_capture(
        tmp_path,
        {
            20650: [_record(FIXTURE_ID, 10, ["75.700", "24.300"])],
            20651: [_record(FIXTURE_ID, 20, ["79.618", "20.382"])],
        },
    )
    snapshots = history_replay(FIXTURE_ID, path=tmp_path)
    assert len(snapshots) == 2
    assert [s.ts for s in snapshots] == [10, 20]
    assert snapshots[0].quotes[0].pct == {"over": 75.700, "under": 24.300}


def test_replay_orders_across_day_files(tmp_path):
    _write_capture(
        tmp_path,
        {
            20651: [_record(FIXTURE_ID, 30, ["1.0", "99.0"])],
            20650: [_record(FIXTURE_ID, 10, ["2.0", "98.0"])],
        },
    )
    assert [s.ts for s in history_replay(FIXTURE_ID, path=tmp_path)] == [10, 30]


def test_replay_isolates_the_requested_fixture(tmp_path):
    _write_capture(
        tmp_path,
        {
            20650: [
                _record(FIXTURE_ID, 10, ["75.0", "25.0"]),
                _record(OTHER_FIXTURE, 10, ["40.0", "60.0"]),
            ]
        },
    )
    snapshots = history_replay(FIXTURE_ID, path=tmp_path)
    assert all(q.fixture_id == FIXTURE_ID for s in snapshots for q in s.quotes)
    assert len(snapshots[0].quotes) == 1


def test_replay_keeps_distinct_periods_distinct(tmp_path):
    """The market-period fix must hold on the replay path too."""
    _write_capture(
        tmp_path,
        {
            20650: [
                _record(FIXTURE_ID, 10, ["75.0", "25.0"], period=None),
                _record(FIXTURE_ID, 10, ["60.0", "40.0"], period="half=1"),
            ]
        },
    )
    markets = {q.market for s in history_replay(FIXTURE_ID, path=tmp_path) for q in s.quotes}
    assert markets == {
        "OVERUNDER_PARTICIPANT_GOALS|line=2",
        "OVERUNDER_PARTICIPANT_GOALS|line=2|half=1",
    }


def test_limit_caps_the_replay(tmp_path):
    _write_capture(
        tmp_path, {20650: [_record(FIXTURE_ID, ts, ["50.0", "50.0"]) for ts in (1, 2, 3, 4)]}
    )
    assert len(history_replay(FIXTURE_ID, path=tmp_path, limit=2)) == 2


def test_a_missing_capture_fails_loudly(tmp_path):
    """An absent fallback must FAIL — never silently synthesize a market."""
    with pytest.raises(FeedError, match="no captured TxODDS history"):
        history_replay(FIXTURE_ID, path=tmp_path / "absent")


def test_a_fixture_absent_from_the_capture_fails_loudly(tmp_path):
    _write_capture(tmp_path, {20650: [_record(OTHER_FIXTURE, 10, ["50.0", "50.0"])]})
    with pytest.raises(FeedError, match="no odds for fixture"):
        history_replay(FIXTURE_ID, path=tmp_path)


def test_a_corrupt_line_is_skipped_not_fatal(tmp_path):
    """The capture is untrusted input."""
    odds = tmp_path / "raw" / "odds"
    odds.mkdir(parents=True)
    good = json.dumps(_record(FIXTURE_ID, 10, ["50.0", "50.0"]), separators=(",", ":"))
    (odds / "day-20650.jsonl").write_text(f"{{not json {FIXTURE_ID}\n{good}\n")
    assert len(history_replay(FIXTURE_ID, path=tmp_path)) == 1


def test_history_dir_honours_the_env_override(tmp_path, monkeypatch):
    monkeypatch.setenv(HISTORY_PATH_ENV, str(tmp_path / "capture"))
    assert history_dir() == tmp_path / "capture"
