"""The web artifacts must be REAL or absent — never synthesized to fill a page.

Runs against a tiny on-disk capture written by the test itself (same wire shape as the real
one), so the whole export path is falsifiable offline with no network and no 1.4GB fixture.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from gorilla.web_export import (
    ExportError,
    build_policy_slice,
    build_replay_slice,
    fixture_meta,
    write_artifacts,
)

FIXTURE_ID = 18257865


def _odds_record(ts: int, pct: float, *, period: str = "", market: str = "1X2_PARTICIPANT_RESULT"):
    return {
        "FixtureId": FIXTURE_ID,
        "BookmakerId": 10021,
        "Bookmaker": "TXLineStablePriceDemargined",
        "SuperOddsType": market,
        "MarketParameters": "",
        "MarketPeriod": period,
        "Ts": ts,
        # The wire ships parallel PriceNames/Pct lists, with Pct as 3-dp strings.
        "PriceNames": ["part1", "part2"],
        "Pct": [f"{pct:.3f}", f"{100 - pct:.3f}"],
    }


@pytest.fixture
def capture(tmp_path: Path) -> Path:
    """A miniature capture: a flat book, then one move well past the 3pp threshold."""
    odds = tmp_path / "raw" / "odds"
    odds.mkdir(parents=True)
    series = [40.0, 40.2, 40.1, 40.4, 46.9, 47.1, 47.0, 47.2]
    records = [_odds_record(1_784_150_000_000 + i * 60_000, p) for i, p in enumerate(series)]
    (odds / "day-20652.jsonl").write_text(
        "\n".join(json.dumps(r) for r in records) + "\n", encoding="utf-8"
    )
    (tmp_path / "raw" / "fixtures.jsonl").write_text(
        json.dumps(
            {
                "FixtureId": FIXTURE_ID,
                "Participant1": "France",
                "Participant2": "England",
                "Competition": "World Cup",
                "CompetitionId": 72,
                "StartTime": 1_784_408_400_000,
            }
        )
        + "\n",
        encoding="utf-8",
    )
    return tmp_path


def test_slice_is_labelled_recorded_not_live(capture: Path) -> None:
    slice_ = build_replay_slice(FIXTURE_ID, path=capture)
    assert slice_["provenance"]["kind"] == "recorded-replay"
    assert "not live" in slice_["provenance"]["note"].lower()


def test_series_and_move_are_the_real_captured_values(capture: Path) -> None:
    slice_ = build_replay_slice(FIXTURE_ID, path=capture)
    move = slice_["moves"][0]
    assert move["old_pct"] == 40.4
    assert move["new_pct"] == 46.9
    assert move["delta_pct"] == pytest.approx(6.5)
    assert move["direction"] == "up"
    # the charted series carries the flagged reading, so chart and signal describe one book
    assert any(r["ts"] == move["ts"] and r["pct"] == move["new_pct"] for r in slice_["series"])
    assert [r["pct"] for r in slice_["series"]] == [40.0, 40.2, 40.1, 40.4, 46.9, 47.1, 47.0, 47.2]


def test_window_bounds_describe_the_slice_honestly(capture: Path) -> None:
    slice_ = build_replay_slice(FIXTURE_ID, path=capture, window=4)
    line = slice_["line"]
    assert line["windowEnd"] - line["windowStart"] == len(slice_["series"])
    assert line["readingsOnLine"] == 8  # the UI can say "N of M"


def test_fixture_identity_comes_from_the_capture(capture: Path) -> None:
    meta = fixture_meta(FIXTURE_ID, path=capture)
    assert meta.participant1 == "France"
    assert meta.competition == "World Cup"


def test_a_fixture_the_capture_does_not_hold_raises(capture: Path) -> None:
    with pytest.raises(ExportError):
        fixture_meta(999, path=capture)


def test_a_book_with_no_real_move_exports_nothing(tmp_path: Path) -> None:
    """No signal is a valid outcome; inventing one is not. It must fail, not fabricate."""
    odds = tmp_path / "raw" / "odds"
    odds.mkdir(parents=True)
    flat = [_odds_record(1_784_150_000_000 + i * 60_000, 40.0 + i * 0.1) for i in range(6)]
    (odds / "day-20652.jsonl").write_text(
        "\n".join(json.dumps(r) for r in flat) + "\n", encoding="utf-8"
    )
    with pytest.raises(ExportError, match="no move"):
        build_replay_slice(FIXTURE_ID, path=tmp_path)


def test_missing_capture_raises_rather_than_degrading(tmp_path: Path) -> None:
    with pytest.raises(ExportError):
        build_replay_slice(FIXTURE_ID, path=tmp_path / "nothing-here")


def test_policy_slice_mirrors_the_real_chain_policy() -> None:
    policy = build_policy_slice()
    assert policy["maxSpendSol"] > 0
    assert policy["stakePerBetSol"] <= policy["maxPerFixtureSol"] <= policy["maxSpendSol"]
    instructions = {b["instruction"] for b in policy["allow"]}
    assert "stake" in instructions
    # every binding names a real program id, so the UI never prints an unbound instruction
    assert all(len(b["programId"]) == 44 for b in policy["allow"])


def test_write_artifacts_emits_both_files(capture: Path, tmp_path: Path) -> None:
    out = tmp_path / "out"
    written = write_artifacts(out, fixture_id=FIXTURE_ID, path=capture)
    assert set(written) == {"agent-replay.json", "agent-policy.json"}
    for path in written.values():
        json.loads(path.read_text(encoding="utf-8"))
