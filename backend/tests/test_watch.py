"""The signal-first ``watch`` CLI — the signal loop, exercised offline and deterministically.

No network: the scripted stream is pure synthesis and the live poller is exercised through an
injected fake feed + sleep (Pattern B). The signal is the hero; ``--act`` is the secondary
custody-gated layer. ``main`` routes ``demo`` (default) vs ``watch`` without breaking the demo.

NOTE the scripted stream and the ``SandboxExecutor`` used here are TEST fixtures, not the
operating mode: a live ``watch`` run reads the real TxLINE feed and signs with a real devnet
key. These tests pin that the offline simulation still falsifies the loop.
"""

from __future__ import annotations

import argparse
import io

import pytest

from gorilla.cli import main
from gorilla.detector import OddsSnapshot, PriceQuote, SharpMove
from gorilla.watch import (
    SandboxExecutor,
    WatchSummary,
    format_signal,
    live_stream,
    recorded_stream,
    run_watch,
)


def _run(**kwargs: object) -> tuple[str, WatchSummary]:
    """Run ``run_watch`` over the scripted stream into a buffer; return (output, summary)."""
    buf = io.StringIO()
    if kwargs.get("act") and "executor" not in kwargs:
        kwargs["executor"] = SandboxExecutor.build()
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


def test_main_offline_returns_zero_and_prints_header_and_signals():
    buf = io.StringIO()
    code = main(["watch", "--offline"], out=buf)
    text = buf.getvalue()
    assert code == 0
    assert "Gorilla" in text
    assert "SYNTHETIC" in text  # the scripted source is labelled as synthetic, never as market data
    assert "SHARP" in text
    assert "sharp move(s) flagged from" in text


def test_explicit_demo_runs_the_synthetic_smoke_and_says_so(capsys):
    """The offline smoke survives (Pattern B) but must announce that it is synthetic and point
    at the real path — it is no longer what a bare invocation gives you."""
    assert main(["demo"]) == 0
    out = capsys.readouterr().out
    assert "SYNTHETIC offline core" in out
    assert "NOT market data, NOT transactions" in out
    assert "python -m gorilla watch" in out


def test_bare_invocation_is_a_live_watch_not_the_synthetic_demo(monkeypatch):
    """THE fake-by-default regression: a bare ``python -m gorilla`` must take the live path.

    The live source is stubbed out (no network in a test) — what is asserted is the ROUTING:
    a bare invocation lands in ``watch``, never in the synthetic demo."""
    import gorilla.cli as cli

    seen: dict[str, object] = {}

    def fake_watch(args, *, out):
        seen["command"] = args.command
        seen["offline"] = args.offline
        return 0

    monkeypatch.setattr(cli, "run_watch_command", fake_watch)
    assert main([], out=io.StringIO()) == 0
    assert seen == {"command": "watch", "offline": False}


def test_main_offline_act_flag_shows_sandbox_custody_line():
    buf = io.StringIO()
    assert main(["watch", "--offline", "--act"], out=buf) == 0
    text = buf.getvalue()
    assert "custody: SANDBOX" in text
    assert "signed within policy" in text
    # A sandbox ref must be visibly NOT a transaction signature.
    assert "sandbox ref (NOT a transaction)" in text


def test_an_uncovered_fixture_refusal_prints_and_never_breaks_the_watch_loop():
    """The coverage gate must surface exactly like every other chain refusal: one honest
    'on-chain stake not placed' line naming the fixture and the WHY, with the stream running
    to completion — never an exception through the loop."""
    from gorilla.decision import BetIntent
    from gorilla.staking import UncoveredFixtureError
    from gorilla.wallet import SignResult

    class UncoveredExecutor:
        def place(self, bet: BetIntent) -> SignResult:
            raise UncoveredFixtureError(
                f"fixture {bet.fixture_id} is not in TxODDS coverage — "
                "a market for it could never settle"
            )

    buf = io.StringIO()
    summary = run_watch(recorded_stream(), act=True, executor=UncoveredExecutor(), out=buf)
    out = buf.getvalue()
    assert summary.readings == 24  # the loop completed
    assert summary.placed == 0 and summary.staked == 0.0
    assert "on-chain stake not placed: fixture 42 is not in TxODDS coverage" in out
    assert "could never settle" in out


def test_act_without_an_executor_is_refused_rather_than_silently_faked():
    """The regression this whole change exists to prevent: ``act`` must never fall back to a
    fake wallet by default. No executor -> a loud error, not a sandbox signature."""
    with pytest.raises(ValueError, match="requires an explicit executor"):
        run_watch(recorded_stream(), act=True, out=io.StringIO())


def test_watch_defaults_to_live_not_offline():
    """Live is the operating mode: the parser's default must be live, with offline opt-in."""
    parser = argparse.ArgumentParser()
    from gorilla.watch import add_watch_arguments

    add_watch_arguments(parser)
    args = parser.parse_args([])
    assert args.offline is False
    assert args.history is False
    assert args.fixture is None  # discovered from the live World Cup fixture list


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
