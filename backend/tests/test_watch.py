"""The signal-first ``watch`` CLI — streams sharp-move signals, offline and deterministic.

No network: the recorded stream is pure scripting and the live poller is exercised through an
injected fake feed + sleep (Pattern B). The signal is the hero; ``--act`` is the secondary
custody-gated layer. ``main`` routes ``demo`` (default) vs ``watch`` without breaking the demo.
"""

from __future__ import annotations

import io

from gorilla.cli import main
from gorilla.detector import OddsSnapshot, PriceQuote, SharpMove
from gorilla.watch import (
    WatchSummary,
    format_signal,
    live_stream,
    recorded_stream,
    run_watch,
)


def _run(**kwargs: object) -> tuple[str, WatchSummary]:
    """Run ``run_watch`` over the recorded stream into a buffer; return (output, summary)."""
    buf = io.StringIO()
    summary = run_watch(recorded_stream(), out=buf, **kwargs)  # type: ignore[arg-type]
    return buf.getvalue(), summary


def test_recorded_stream_is_deterministic_and_has_readings():
    assert recorded_stream() == recorded_stream()
    assert len(recorded_stream()) == 24  # four 6-tick replay timelines


def test_watch_streams_a_signal_line_per_flagged_move():
    out, summary = _run()
    assert isinstance(summary, WatchSummary)
    # Four scripted sharp moves across four fixtures -> four SHARP signal lines.
    assert summary.signals == 4
    assert summary.readings == 24
    assert out.count("SHARP") == 4
    # Each signal carries the required fields: book · market · outcome · old→new · Δpp · dir.
    assert "Pinnacle" in out and "1x2" in out and "→" in out and "pp" in out


def test_signal_line_direction_and_fields():
    up = SharpMove(42, "Pinnacle", "1x2", "Home", 45.0, 54.0, 9.0, 1000)
    down = SharpMove(42, "Pinnacle", "1x2", "Away", 40.0, 31.0, -9.0, 1000)
    assert "SHARP ↑" in format_signal(up)
    assert "SHARP ↓" in format_signal(down)
    assert "Home" in format_signal(up) and "+9.000 pp" in format_signal(up)


def test_default_run_flags_signals_but_places_no_bets():
    out, summary = _run()  # act defaults to False
    assert summary.acted is False
    assert summary.placed == 0 and summary.refused == 0
    assert "act ·" not in out  # no bet layer without --act
    assert summary.exposure == {}


def test_act_places_policy_gated_bets_and_custody_refuses_over_cap():
    """The '& agents' layer: the agent sizes and signs bets within the sandbox custody cap, and
    the wallet REFUSES the bet that would breach the cap (the 'acts safely' story)."""
    out, summary = _run(act=True)
    assert summary.acted is True
    # 35 cap, 10/bet: three bets sign (30), the fourth is refused before it can breach the cap.
    assert summary.placed == 3
    assert summary.refused == 1
    assert summary.staked == 30.0
    assert summary.exposure == {42: 10.0, 77: 10.0, 88: 10.0}
    assert "signed within policy" in out
    assert "custody held" in out
    assert "sandbox:" in out  # the sandbox sign ref, not a real signature


def test_high_threshold_flags_nothing():
    _, summary = _run(threshold_pct=50.0)
    assert summary.signals == 0 and summary.readings == 24


def test_main_recorded_returns_zero_and_prints_header_and_signals():
    buf = io.StringIO()
    code = main(["watch"], out=buf)
    text = buf.getvalue()
    assert code == 0
    assert "Gorilla" in text
    assert "$0 · no key · no network" in text
    assert "SHARP" in text
    assert "sharp move(s) flagged from" in text


def test_main_bare_invocation_runs_the_demo_not_watch(capsys):
    """A bare ``python -m gorilla`` (no subcommand) still runs the offline demo — the original
    behavior is preserved, and ``watch`` is purely additive."""
    assert main([]) == 0
    out = capsys.readouterr().out
    assert "Gorilla Markets — offline agent core" in out  # the demo banner
    assert "SHARP" not in out  # not the watch stream


def test_main_act_flag_shows_custody_line():
    buf = io.StringIO()
    assert main(["watch", "--act"], out=buf) == 0
    text = buf.getvalue()
    assert "custody:" in text
    assert "signed within policy" in text


def test_live_stream_polls_via_injected_feed_without_network():
    """Pattern B: the live poller is falsifiable offline through an injected feed + sleep — it
    polls the requested number of times and never touches the real network."""
    calls: list[int] = []
    sleeps: list[float] = []

    class FakeFeed:
        def odds(self, fixture_id: int) -> OddsSnapshot:
            calls.append(fixture_id)
            quote = PriceQuote(fixture_id, "Pinnacle", 3, "1x2", len(calls), {"Home": 50.0})
            return OddsSnapshot(fixture_id=fixture_id, ts=len(calls), quotes=(quote,))

    snaps = list(
        live_stream(42, polls=3, interval=1.5, feed=FakeFeed(), sleep=sleeps.append)  # type: ignore[arg-type]
    )
    assert len(snaps) == 3
    assert calls == [42, 42, 42]
    assert sleeps == [1.5, 1.5]  # slept between polls, not before the first
