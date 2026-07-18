"""``gorilla watch`` — stream the odds feed and flag sharp-money line moves live.

The signal-first view of the Gorilla agent: a *signal* tool. It reads the odds feed tick by
tick, runs the pure :class:`~gorilla.detector.SharpDetector`, and prints each flagged **sharp
move** — a professional-money shift in a line's implied probability — as a live signal line.
Sharp money moves a betting line early; catching that move before the rest of the market is the
edge.

By default it runs a **recorded**, deterministic market ($0, no key, no network) so the tool is
falsifiable offline. ``--live`` polls the real TxLINE feed instead (network + credentials).

The optional ``--act`` flag layers Gorilla's "& agents" angle on top of the signal: for each
move it also shows the policy-gated bet a hands-off agent *would* place, sized within a risk
policy and signed only within a sandbox custody cap — so the agent can act on the edge without
ever holding keys or exceeding what the user authorized. The signal stays the hero; ``--act`` is
secondary. It runs over Gorilla's own ``detector`` / ``txline_feed`` / ``decision`` / ``wallet``
— the same offline core the ``demo`` and the on-chain chunk share, just presented as a live stream.
"""

from __future__ import annotations

import argparse
import sys
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass
from typing import TextIO

from .agent import BET_PURPOSE, to_tx_intent
from .decision import RiskPolicy, decide
from .detector import OddsSnapshot, SharpDetector, SharpMove
from .txline_feed import FeedError, TxlineFeed, replay
from .wallet import Policy, PolicyViolation, SandboxWallet

# The custody + risk bounds the ``--act`` agent operates within. Fixed for the demo and shown in
# the header so the "acts safely" story is explicit: the agent may stake within the risk policy,
# but the wallet refuses anything past the total spend cap.
_DEFAULT_RISK = RiskPolicy(max_stake=10.0, max_per_fixture=25.0)
_WALLET_FUNDED = 100.0
_WALLET_CAP = 35.0
_RULE = "─" * 74


@dataclass(frozen=True)
class WatchSummary:
    """What a ``watch`` run produced — the counts the summary line reports (and tests assert)."""

    readings: int
    signals: int
    acted: bool
    placed: int
    refused: int
    exposure: Mapping[int, float]
    staked: float  # total signed within policy (sum of exposure)


def recorded_stream() -> list[OddsSnapshot]:
    """A deterministic offline market with several sharp moves across books and fixtures.

    Built by chaining the feed's tested ``replay`` timelines — each drifts sub-threshold, then
    takes one sharp move — so ``watch`` streams a handful of distinct signals with no network.
    Live mode replaces this with repeated polls of the real, moving feed.
    """
    return [
        *replay(
            fixture_id=42,
            bookmaker="Pinnacle",
            bookmaker_id=3,
            base={"Home": 45.0, "Draw": 27.0, "Away": 28.0},
            move={"Home": 9.0, "Away": -9.0},  # sharp money onto the favorite
            move_at=2,
        ),
        *replay(
            fixture_id=77,
            bookmaker="Betfair",
            bookmaker_id=5,
            base={"Home": 38.0, "Draw": 33.0, "Away": 29.0},
            move={"Home": -8.0, "Away": 5.0},  # steam off the home side
            move_at=3,
        ),
        *replay(
            fixture_id=88,
            bookmaker="Circa",
            bookmaker_id=8,
            base={"Home": 52.0, "Draw": 24.0, "Away": 24.0},
            move={"Draw": 6.5, "Home": -6.5},  # money into the draw
            move_at=2,
        ),
        *replay(
            fixture_id=91,
            bookmaker="Pinnacle",
            bookmaker_id=3,
            base={"Home": 30.0, "Draw": 30.0, "Away": 40.0},
            move={"Away": 11.0, "Home": -11.0},  # a big late move onto the away side
            move_at=3,
        ),
    ]


def live_stream(
    fixture_id: int,
    polls: int,
    interval: float,
    *,
    feed: TxlineFeed | None = None,
    sleep: Callable[[float], object] | None = None,
) -> Iterable[OddsSnapshot]:
    """Poll the real TxLINE feed ``polls`` times, ``interval`` seconds apart, yielding each read.

    Needs network and (for a non-empty book) TxLINE credentials wired into the feed's session. A
    failed read raises ``FeedError`` (redacted — never a token); the caller surfaces it. The
    ``sleep`` seam is injectable so this stays offline-testable (Pattern B).
    """
    import time

    feed = feed or TxlineFeed(mode="live")
    do_sleep = sleep if sleep is not None else time.sleep
    for i in range(polls):
        if i:
            do_sleep(interval)
        yield feed.odds(fixture_id)


def format_signal(move: SharpMove) -> str:
    """The hero line: one flagged sharp move — book · market · outcome · old%→new% · Δpp · dir."""
    arrow = "↑" if move.direction == "up" else "↓"
    return f"  SHARP {arrow}  {move.summary()}"


def _act_line(text: str) -> str:
    return f"         └─ act · {text}"


def _default_wallet() -> SandboxWallet:
    """The sandbox custody wallet the ``--act`` agent signs through — auto-funded, no real keys,
    authorized for exactly one purpose and capped. It refuses anything over the cap."""
    wallet = SandboxWallet(funded_amount=_WALLET_FUNDED)
    wallet.authorize(Policy(max_spend=_WALLET_CAP, allowed_purposes=frozenset({BET_PURPOSE})))
    return wallet


def run_watch(
    stream: Iterable[OddsSnapshot],
    *,
    threshold_pct: float = 3.0,
    act: bool = False,
    wallet: SandboxWallet | None = None,
    risk: RiskPolicy | None = None,
    out: TextIO = sys.stdout,
) -> WatchSummary:
    """Stream ``stream`` through the detector, printing each sharp move as it fires.

    With ``act`` set, each move is also sized into a bet within ``risk`` and handed to ``wallet``
    to sign within its custody policy; a wallet refusal is printed (never raised) so the stream
    always completes. Returns the run's counts. Deterministic given a deterministic ``stream``.
    """
    detector = SharpDetector(threshold_pct=threshold_pct)
    active_wallet = wallet if wallet is not None else _default_wallet()
    active_risk = risk if risk is not None else _DEFAULT_RISK
    exposure: dict[int, float] = {}
    readings = signals = placed = refused = 0

    for snapshot in stream:
        readings += 1
        move = detector.observe(snapshot)
        if move is None:
            continue
        signals += 1
        print(format_signal(move), file=out)
        if not act:
            continue
        bet = decide(move, active_risk, staked_on_fixture=exposure.get(move.fixture_id, 0.0))
        if bet is None:
            print(
                _act_line(f"no room left on fixture {move.fixture_id} under the risk policy"),
                file=out,
            )
            continue
        try:
            result = active_wallet.sign_within_policy(to_tx_intent(bet))
        except PolicyViolation as exc:
            refused += 1
            print(_act_line(f"refused {bet.side} {bet.amount:g} — {exc} (custody held)"), file=out)
            continue
        exposure[move.fixture_id] = exposure.get(move.fixture_id, 0.0) + bet.amount
        placed += 1
        print(
            _act_line(
                f"{bet.side} {bet.amount:g} on {bet.market} · signed within policy [{result.ref}]"
            ),
            file=out,
        )

    staked = round(sum(exposure.values()), 6)
    return WatchSummary(readings, signals, act, placed, refused, dict(exposure), staked)


def _print_header(out: TextIO, *, threshold: float, act: bool, live: bool) -> None:
    mode = "live TxLINE feed" if live else "recorded market · $0 · no key · no network"
    print(_RULE, file=out)
    print("  Gorilla · sharp-money line-move detector", file=out)
    print(f"  {mode} · threshold {threshold:g}pp", file=out)
    if act:
        print(
            f"  custody: agent stakes ≤ {_DEFAULT_RISK.max_stake:g}/bet, "
            f"≤ {_DEFAULT_RISK.max_per_fixture:g}/fixture, ≤ {_WALLET_CAP:g} total (sandbox)",
            file=out,
        )
    print(_RULE, file=out)


def _print_summary(out: TextIO, summary: WatchSummary) -> None:
    print(_RULE, file=out)
    print(f"  {summary.signals} sharp move(s) flagged from {summary.readings} reading(s)", file=out)
    if summary.acted:
        print(
            f"  {summary.placed} bet(s) signed within policy · {summary.refused} refused "
            f"(custody held) · staked {summary.staked:g} of the {_WALLET_CAP:g} cap · "
            f"exposure {dict(summary.exposure)}",
            file=out,
        )
    print(file=out)


def add_watch_arguments(parser: argparse.ArgumentParser) -> None:
    """Register the ``watch`` flags on ``parser`` (the top-level CLI's ``watch`` subparser)."""
    parser.add_argument(
        "--act",
        action="store_true",
        help="also show the policy-gated bet the agent would place within a custody cap",
    )
    parser.add_argument(
        "--threshold",
        type=float,
        default=3.0,
        metavar="PP",
        help="sharp-move threshold in percentage points (default: 3.0)",
    )
    parser.add_argument(
        "--live",
        action="store_true",
        help="poll the real TxLINE feed instead of the recorded market (needs network + creds)",
    )
    parser.add_argument(
        "--fixture", type=int, default=42, metavar="ID", help="fixture id to poll in --live mode"
    )
    parser.add_argument(
        "--polls", type=int, default=6, metavar="N", help="number of live polls (default: 6)"
    )
    parser.add_argument(
        "--interval",
        type=float,
        default=3.0,
        metavar="SEC",
        help="seconds between live polls (default: 3.0)",
    )


def run_watch_command(args: argparse.Namespace, *, out: TextIO = sys.stdout) -> int:
    """Run the ``watch`` command from parsed ``args`` — the thin transport for the streamed view.

    Recorded / $0 by default; ``--live`` polls the real feed. Returns a process exit code (``2``
    if a live read fails, with a redacted message — the feed never puts a token in a ``FeedError``).
    """
    _print_header(out, threshold=args.threshold, act=args.act, live=args.live)
    stream: Iterable[OddsSnapshot]
    if args.live:
        stream = live_stream(args.fixture, args.polls, args.interval)
    else:
        stream = recorded_stream()
    try:
        summary = run_watch(stream, threshold_pct=args.threshold, act=args.act, out=out)
    except FeedError as exc:
        # Redacted by construction — the feed never puts a token in a FeedError.
        print(f"  live feed unavailable: {exc}", file=out)
        return 2
    _print_summary(out, summary)
    return 0
