"""``gorilla watch`` — stream the REAL odds feed and flag sharp-money line moves live.

The signal-first view of the Gorilla agent. It reads a real World Cup fixture's odds tick by
tick, runs the pure :class:`~gorilla.detector.SharpDetector`, and prints each flagged **sharp
move** — a professional-money shift in a line's implied probability — as a live signal line.

**Live is the operating mode.** The agent watches the real TxLINE feed for a real World Cup
fixture (competition-filtered — see :mod:`gorilla.fixtures`), and with ``--act`` it stakes the
bet its own signal produced as a REAL devnet transaction through a policy-gated
:class:`~gorilla.wallets.LocalDevnetWallet`. Every signature it prints is verifiable on-chain.

Three sources, in order of preference — and NONE of them invents a price:

* **live** (default): the fixture's real update series from TxLINE's in-memory cache.
* **real captured history** (``--history``, and the automatic fallback): the exact wire records
  that came off the live API, on disk, replayed in order. The World Cup API closes ~Jul 19; when
  it does, the agent replays real recorded data rather than fabricating a market.
* **offline scripted** (``--offline``): the deterministic ``replay`` timeline and a keyless
  sandbox wallet. This is the Pattern-B falsifiable simulation for TESTS AND DEV ONLY — it is
  synthetic, it is clearly labelled as such, and it is never the operating mode.

DEVNET-ONLY. The wallet is a devnet keypair, the RPC refuses a mainnet URL, and every
transaction is simulated before it is sent. Mainnet is founder-gated.
"""

from __future__ import annotations

import argparse
import sys
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Protocol, TextIO

from .agent import BET_PURPOSE, to_tx_intent
from .decision import BetIntent, RiskPolicy, decide
from .detector import OddsSnapshot, SharpDetector, SharpMove
from .fixtures import Fixture, history_world_cup_fixtures, pick_world_cup_fixture
from .settlement import CREATE_PURPOSE
from .solana_rpc import RpcError
from .staking import StakingError
from .txline_feed import FeedError, TxlineFeed, history_replay, replay
from .txodds_session import SessionError, TxoddsSession
from .wallet import Policy, PolicyViolation, SandboxWallet, SignResult
from .wallets import OnChainError

if TYPE_CHECKING:
    # Only for annotations — importing these eagerly would pull solders into the offline path.
    from .staking import LiveMarket
    from .wallets import LocalDevnetWallet

# ── live defaults, scaled to DEVNET SOL ──────────────────────────────────────────
# The offline demo used notional units (10 per bet); a real signer moves real devnet lamports,
# so the live defaults are small and the caps are tight. Two independent bounds still hold: the
# risk policy sizes the bet, the wallet refuses anything past its cap or off its allow-list.
DEFAULT_STAKE_SOL = 0.01
DEFAULT_PER_FIXTURE_SOL = 0.02
DEFAULT_CAP_SOL = 0.05

# The scripted-offline bounds (notional units, no real value) — unchanged, tests pin them.
_OFFLINE_RISK = RiskPolicy(max_stake=10.0, max_per_fixture=25.0)
_OFFLINE_WALLET_FUNDED = 100.0
_OFFLINE_WALLET_CAP = 35.0

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
    signatures: tuple[str, ...] = ()  # real devnet tx signatures, in the order they landed


# ── the execution seam: how a decided bet becomes a signed transaction ────────────
class BetExecutor(Protocol):
    """How the agent places a bet it has decided on. The seam between the signal loop and
    custody, so ``run_watch`` never learns whether it is signing a real transaction or a
    sandbox reference."""

    def place(self, bet: BetIntent) -> SignResult: ...


@dataclass
class SandboxExecutor:
    """Signs into a keyless sandbox wallet — no keys, no chain, no value.

    TESTS AND DEV ONLY. It exists so the whole signal loop stays falsifiable offline
    (Pattern B); it is never what a live run uses, and its refs are prefixed ``sandbox:`` so a
    sandbox result can never be mistaken for a transaction signature."""

    wallet: SandboxWallet

    @classmethod
    def build(cls) -> "SandboxExecutor":
        wallet = SandboxWallet(funded_amount=_OFFLINE_WALLET_FUNDED)
        wallet.authorize(
            Policy(max_spend=_OFFLINE_WALLET_CAP, allowed_purposes=frozenset({BET_PURPOSE}))
        )
        return cls(wallet)

    def place(self, bet: BetIntent) -> SignResult:
        return self.wallet.sign_within_policy(to_tx_intent(bet))


@dataclass
class ChainExecutor:
    """Stakes on devnet through the policy-gated :class:`LocalDevnetWallet` — the REAL path.

    The market is opened lazily, on the first bet that actually passes the risk policy, so a
    run that never fires a signal sends no transaction at all."""

    fixture_id: int
    stat_key: int
    cap_sol: float
    log: Callable[[str], None] | None = None
    _wallet: "LocalDevnetWallet | None" = field(default=None, init=False)
    _market: "LiveMarket | None" = field(default=None, init=False)

    def _ensure(self) -> "tuple[LocalDevnetWallet, LiveMarket]":
        from .solana_rpc import SolanaRpc
        from .staking import devnet_wallet, ensure_market

        wallet = self._wallet
        if wallet is None:
            rpc = SolanaRpc()
            wallet = devnet_wallet(
                rpc=rpc,
                cap_sol=self.cap_sol,
                purposes=frozenset({BET_PURPOSE, CREATE_PURPOSE}),
            )
            self._wallet = wallet
            if self.log:
                self.log(f"signer {wallet.pubkey} · {wallet.funded():.4f} devnet SOL")
        market = self._market
        if market is None:
            market = ensure_market(
                rpc=wallet.rpc,
                wallet=wallet,
                fixture_id=self.fixture_id,
                stat_key=self.stat_key,
                log=self.log,
            )
            self._market = market
        return wallet, market

    def place(self, bet: BetIntent) -> SignResult:
        from .staking import stake_on_bet

        wallet, market = self._ensure()
        return stake_on_bet(wallet=wallet, market=market, bet=bet, rpc=wallet.rpc)


# ── stream sources (every one of them real, except the clearly-labelled scripted one) ──
def recorded_stream() -> list[OddsSnapshot]:
    """A deterministic SYNTHETIC market with several sharp moves. TESTS AND DEV ONLY.

    Built by chaining the feed's tested ``replay`` timelines — no network, no key, fully
    reproducible — so the signal loop can be falsified offline. These prices were never quoted
    by a bookmaker; this is not, and must never be presented as, market data."""
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
    """Poll the real TxLINE odds SNAPSHOT ``polls`` times, ``interval`` seconds apart.

    Note the snapshot endpoint serves one reading per 5-minute interval, so a short poll loop
    returns the same reading repeatedly and shows no movement — that is a property of the API,
    not a bug. ``TxlineFeed.updates`` is the read the detector actually wants; this remains for
    a genuinely long watch. The ``sleep`` seam is injectable so this stays offline-testable."""
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


def run_watch(
    stream: Iterable[OddsSnapshot],
    *,
    threshold_pct: float = 3.0,
    act: bool = False,
    executor: BetExecutor | None = None,
    risk: RiskPolicy | None = None,
    out: TextIO = sys.stdout,
) -> WatchSummary:
    """Stream ``stream`` through the detector, printing each sharp move as it fires.

    With ``act`` set, each move is sized into a bet within ``risk`` and handed to ``executor``
    to sign within its custody policy; a refusal or an on-chain failure is printed (never
    raised) so the stream always completes. Deterministic given a deterministic ``stream``.

    ``executor`` is REQUIRED when ``act`` is set — there is deliberately no default. A default
    would have to pick between a real signer and a fake one, and silently defaulting to a fake
    is exactly the failure mode this module is meant to prevent."""
    if act and executor is None:
        raise ValueError("run_watch(act=True) requires an explicit executor (real or sandbox)")
    detector = SharpDetector(threshold_pct=threshold_pct)
    active_risk = risk if risk is not None else _OFFLINE_RISK
    exposure: dict[int, float] = {}
    signatures: list[str] = []
    readings = signals = placed = refused = 0

    for snapshot in stream:
        readings += 1
        move = detector.observe(snapshot)
        if move is None:
            continue
        signals += 1
        print(format_signal(move), file=out)
        if not act or executor is None:
            continue
        bet = decide(move, active_risk, staked_on_fixture=exposure.get(move.fixture_id, 0.0))
        if bet is None:
            print(
                _act_line(f"no room left on fixture {move.fixture_id} under the risk policy"),
                file=out,
            )
            continue
        try:
            result = executor.place(bet)
        except PolicyViolation as exc:
            refused += 1
            print(_act_line(f"refused {bet.side} {bet.amount:g} — {exc} (custody held)"), file=out)
            continue
        except (OnChainError, RpcError, StakingError) as exc:
            # A real chain failure is reported as a real failure — never silently downgraded
            # to a sandbox signature or a fabricated "success".
            print(_act_line(f"on-chain stake not placed: {exc}"), file=out)
            continue
        exposure[move.fixture_id] = round(exposure.get(move.fixture_id, 0.0) + bet.amount, 9)
        placed += 1
        signatures.append(result.ref)
        print(
            _act_line(
                f"{bet.side} {bet.amount:g} on {bet.market} · signed within policy [{result.ref}]"
            ),
            file=out,
        )

    staked = round(sum(exposure.values()), 9)
    return WatchSummary(
        readings, signals, act, placed, refused, dict(exposure), staked, tuple(signatures)
    )


# ── source resolution: live first, REAL captured history as the fallback ──────────
@dataclass(frozen=True)
class WatchSource:
    """The resolved stream plus an honest description of where it came from."""

    snapshots: list[OddsSnapshot]
    fixture: Fixture | None
    origin: str  # human label printed in the header — must never overstate the source
    synthetic: bool


def resolve_source(args: argparse.Namespace, *, out: TextIO) -> WatchSource:
    """Pick the stream: scripted-offline if asked, else live, else REAL captured history.

    The fallback is deliberately to recorded REAL data, never to the synthetic placeholder or
    the scripted replay — if the live API is gone, the agent replays what the API actually
    said, or it fails."""
    if args.offline:
        return WatchSource(recorded_stream(), None, "scripted offline market (SYNTHETIC)", True)

    session = TxoddsSession.load()
    if session is not None and session.is_expired():
        print("  note: the TxODDS session has expired — falling back to captured history", file=out)
        session = None

    if not args.history and session is not None:
        try:
            fixture = pick_world_cup_fixture(args.fixture, session=session)
            feed = TxlineFeed(mode="live", session=session)
            snapshots = feed.updates(fixture.fixture_id)
            if args.max_readings:
                snapshots = snapshots[: args.max_readings]
            if snapshots:
                return WatchSource(snapshots, fixture, "LIVE TxLINE feed", False)
            print("  note: the live feed returned no odds for this fixture", file=out)
        except (FeedError, SessionError) as exc:
            print(f"  note: live feed unavailable ({exc})", file=out)

    # Fallback: the real captured history (real wire records, replayed in order).
    fixture = _history_fixture(args.fixture)
    snapshots = history_replay(fixture.fixture_id, limit=args.max_readings)
    return WatchSource(snapshots, fixture, "REAL captured TxODDS history (replay)", False)


def _history_fixture(fixture_id: int | None) -> Fixture:
    """Resolve the fixture from the capture, through the SAME competition filter."""
    candidates = history_world_cup_fixtures()
    if not candidates:
        raise FeedError("the captured history holds no World Cup fixtures")
    if fixture_id is None:
        return sorted(candidates, key=lambda f: (-f.start_time_ms, f.fixture_id))[0]
    for fixture in candidates:
        if fixture.fixture_id == fixture_id:
            return fixture
    raise FeedError(f"fixture {fixture_id} is not a World Cup fixture in the captured history")


# ── presentation ─────────────────────────────────────────────────────────────────
def _print_header(
    out: TextIO, *, threshold: float, act: bool, source: WatchSource, args: argparse.Namespace
) -> None:
    print(_RULE, file=out)
    print("  Gorilla · sharp-money line-move detector", file=out)
    print(f"  source: {source.origin} · threshold {threshold:g}pp", file=out)
    if source.fixture is not None:
        print(f"  fixture: {source.fixture.describe()}", file=out)
    print(f"  readings: {len(source.snapshots)}", file=out)
    if act and source.synthetic:
        print(
            f"  custody: SANDBOX (no keys, no chain) ≤ {_OFFLINE_RISK.max_stake:g}/bet, "
            f"≤ {_OFFLINE_WALLET_CAP:g} total",
            file=out,
        )
    elif act:
        print(
            f"  custody: DEVNET signer · ≤ {args.stake:g} SOL/bet, "
            f"≤ {args.max_fixture:g}/fixture, ≤ {args.cap:g} SOL total · "
            "program+instruction allow-listed",
            file=out,
        )
    print(_RULE, file=out)


def _print_quote(out: TextIO, source: WatchSource) -> None:
    """Print one real quote so the run evidences the data it actually read."""
    first = next((s for s in source.snapshots if s.quotes), None)
    if first is None:
        return
    quote = first.quotes[0]
    prices = " · ".join(f"{name} {pct:.3f}%" for name, pct in sorted(quote.pct.items()))
    print(f"  first quote · {quote.bookmaker} [{quote.market}] {prices}", file=out)
    print(f"  ts {quote.ts}", file=out)
    print(file=out)


def _print_summary(out: TextIO, summary: WatchSummary, source: WatchSource) -> None:
    print(_RULE, file=out)
    print(f"  {summary.signals} sharp move(s) flagged from {summary.readings} reading(s)", file=out)
    if summary.signals == 0:
        print(
            "  no sharp move crossed the threshold in this window — a real result, not a", file=out
        )
        print("  failure. The market simply did not move that far.", file=out)
    if summary.acted:
        unit = "units" if source.synthetic else "SOL"
        print(
            f"  {summary.placed} bet(s) signed within policy · {summary.refused} refused "
            f"(custody held) · staked {summary.staked:g} {unit} · exposure {dict(summary.exposure)}",
            file=out,
        )
        for sig in summary.signatures:
            if sig.startswith("sandbox:"):
                print(f"  sandbox ref (NOT a transaction): {sig}", file=out)
            else:
                print(f"  devnet tx: https://explorer.solana.com/tx/{sig}?cluster=devnet", file=out)
    print(file=out)


def add_watch_arguments(parser: argparse.ArgumentParser) -> None:
    """Register the ``watch`` flags on ``parser`` (the top-level CLI's ``watch`` subparser)."""
    parser.add_argument(
        "--act",
        action="store_true",
        help="stake the bet each signal produces as a REAL devnet transaction (policy-gated)",
    )
    parser.add_argument(
        "--threshold",
        type=float,
        default=3.0,
        metavar="PP",
        help="sharp-move threshold in percentage points (default: 3.0)",
    )
    parser.add_argument(
        "--offline",
        action="store_true",
        help="SYNTHETIC scripted market + keyless sandbox wallet (tests/dev only, not real data)",
    )
    parser.add_argument(
        "--history",
        action="store_true",
        help="replay the REAL captured TxODDS history instead of calling the live API",
    )
    parser.add_argument(
        "--fixture",
        type=int,
        default=None,
        metavar="ID",
        help="World Cup fixture id to watch (default: the next live World Cup fixture)",
    )
    parser.add_argument(
        "--max-readings",
        type=int,
        default=None,
        metavar="N",
        help="cap the number of readings streamed (default: the whole series)",
    )
    parser.add_argument(
        "--stat-key", type=int, default=1, metavar="K", help="on-chain market stat key"
    )
    parser.add_argument(
        "--stake",
        type=float,
        default=DEFAULT_STAKE_SOL,
        metavar="SOL",
        help=f"devnet SOL staked per bet (default: {DEFAULT_STAKE_SOL})",
    )
    parser.add_argument(
        "--max-fixture",
        type=float,
        default=DEFAULT_PER_FIXTURE_SOL,
        metavar="SOL",
        help=f"devnet SOL cap per fixture (default: {DEFAULT_PER_FIXTURE_SOL})",
    )
    parser.add_argument(
        "--cap",
        type=float,
        default=DEFAULT_CAP_SOL,
        metavar="SOL",
        help=f"total wallet spend cap in devnet SOL (default: {DEFAULT_CAP_SOL})",
    )


def run_watch_command(args: argparse.Namespace, *, out: TextIO = sys.stdout) -> int:
    """Run the ``watch`` command from parsed ``args`` — the thin transport for the streamed view.

    Live by default; ``--history`` replays real captured data; ``--offline`` is the synthetic
    test simulation. Returns a process exit code (``2`` if no real source could be reached)."""
    try:
        source = resolve_source(args, out=out)
    except (FeedError, SessionError) as exc:
        # Redacted by construction — neither error type ever carries a token.
        print(f"  no real odds source available: {exc}", file=out)
        return 2

    _print_header(out, threshold=args.threshold, act=args.act, source=source, args=args)
    _print_quote(out, source)

    executor: BetExecutor | None = None
    risk: RiskPolicy | None = None
    if args.act:
        if source.synthetic:
            executor = SandboxExecutor.build()
            risk = _OFFLINE_RISK
        else:
            fixture_id = source.fixture.fixture_id if source.fixture else 0
            executor = ChainExecutor(
                fixture_id,
                args.stat_key,
                args.cap,
                log=lambda line: print(_act_line(line), file=out),
            )
            risk = RiskPolicy(max_stake=args.stake, max_per_fixture=args.max_fixture)

    summary = run_watch(
        source.snapshots,
        threshold_pct=args.threshold,
        act=args.act,
        executor=executor,
        risk=risk,
        out=out,
    )
    _print_summary(out, summary, source)
    return 0
