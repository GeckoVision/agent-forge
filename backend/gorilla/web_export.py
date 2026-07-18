"""Export the agent's REAL run inputs as small JSON artifacts the web surface can render.

The ``/agent`` page must show real data or nothing. Two things it needs cannot be read from
the browser:

* the odds series + the sharp move — they come from the captured TxLINE wire records, which
  are gigabytes on disk and live outside the repo;
* the custody policy — it is a Python :class:`~gorilla.wallets.ChainPolicy`, not a UI constant.

So this module derives both HERE, from the real sources, and emits a compact JSON slice. The
frontend renders that slice; it never re-types a number. Everything else the page shows (the
market, the stake, the transaction) is read live from devnet by the browser.

Two honesty rules are load-bearing:

1. The odds slice is a **recorded replay of real captured data**, never "live". Every artifact
   carries ``kind="recorded-replay"`` plus the capture's real timestamps so the UI can say so.
2. Nothing here synthesizes a price. A missing capture raises — it never degrades into
   invented numbers (same contract as :func:`gorilla.txline_feed.history_replay`).
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .agent import BET_PURPOSE
from .detector import SharpDetector, SharpMove
from .settlement import CREATE_PURPOSE, FORGE_BINDINGS
from .staking import chain_policy
from .txline_feed import FeedError, history_dir, history_replay
from .watch import DEFAULT_CAP_SOL, DEFAULT_PER_FIXTURE_SOL, DEFAULT_STAKE_SOL

# How many consecutive real readings of the focus line to ship, and how many of them land
# AFTER the sharp move. A window (not the whole 3800-reading book) keeps the artifact small;
# it is contiguous and its offsets are exported, so the UI can state exactly what it is.
DEFAULT_WINDOW = 40
READINGS_AFTER_MOVE = 6


class ExportError(Exception):
    """The real inputs for the web artifact could not be assembled."""


@dataclass(frozen=True)
class Reading:
    """One real reading of one price line: capture timestamp + implied probability (pp)."""

    ts: int
    pct: float


@dataclass(frozen=True)
class ExportedMove:
    """A sharp move the REAL detector flagged on the REAL captured series."""

    ts: int
    bookmaker: str
    market: str
    outcome: str
    old_pct: float
    new_pct: float
    delta_pct: float
    direction: str


@dataclass(frozen=True)
class FixtureMeta:
    """Who played, in what competition, when — read from the capture's fixture records."""

    id: int
    participant1: str
    participant2: str
    competition: str
    competition_id: int
    kickoff_ms: int


def fixture_meta(fixture_id: int, *, path: str | Path | None = None) -> FixtureMeta:
    """The captured fixture record for ``fixture_id``.

    Raises :class:`ExportError` when the capture has no such fixture — the UI would otherwise
    have to invent a name for it."""
    fixtures = history_dir(path) / "raw" / "fixtures.jsonl"
    if not fixtures.is_file():
        raise ExportError(f"no captured fixture records at {fixtures}")
    with fixtures.open("r", encoding="utf-8") as handle:
        for line in handle:
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                continue  # the capture is untrusted input; a bad line is not fatal
            if isinstance(record, dict) and record.get("FixtureId") == fixture_id:
                return FixtureMeta(
                    id=fixture_id,
                    participant1=str(record.get("Participant1", "")),
                    participant2=str(record.get("Participant2", "")),
                    competition=str(record.get("Competition", "")),
                    competition_id=int(record.get("CompetitionId", 0)),
                    kickoff_ms=int(record.get("StartTime", 0)),
                )
    raise ExportError(f"the capture holds no fixture record for {fixture_id}")


def _line_series(
    snapshots: list[Any], bookmaker_id: int, market: str, outcome: str
) -> list[Reading]:
    """Every real reading of ONE price line, in capture order."""
    out: list[Reading] = []
    for snapshot in snapshots:
        for quote in snapshot.quotes:
            if quote.bookmaker_id != bookmaker_id or quote.market != market:
                continue
            pct = quote.pct.get(outcome)
            if pct is not None:
                out.append(Reading(ts=quote.ts, pct=round(float(pct), 3)))
    return out


def _window(series: list[Reading], move_ts: int, size: int) -> tuple[int, int]:
    """Bounds of a contiguous ``size``-reading window ending shortly after the move."""
    move_index = next((i for i, r in enumerate(series) if r.ts == move_ts), len(series) - 1)
    end = min(len(series), move_index + 1 + READINGS_AFTER_MOVE)
    start = max(0, end - size)
    return start, end


def build_replay_slice(
    fixture_id: int,
    *,
    threshold_pct: float = 3.0,
    window: int = DEFAULT_WINDOW,
    path: str | Path | None = None,
) -> dict[str, Any]:
    """Replay the REAL capture for ``fixture_id`` through the REAL detector and return the
    compact slice the web surface renders.

    The exported series is the price line the first sharp move fired on — so the chart and the
    signal describe the same real book, not two unrelated things."""
    try:
        snapshots = history_replay(fixture_id, path=path)
    except FeedError as exc:
        raise ExportError(str(exc)) from exc

    detector = SharpDetector(threshold_pct=threshold_pct)
    moves: list[SharpMove] = []
    for snapshot in snapshots:
        move = detector.observe(snapshot)
        if move is not None:
            moves.append(move)
    if not moves:
        raise ExportError(
            f"the real detector flags no move on fixture {fixture_id} at "
            f"{threshold_pct}pp — nothing real to show, so nothing is exported"
        )

    focus = moves[0]
    book_id = next(
        q.bookmaker_id
        for s in snapshots
        for q in s.quotes
        if q.market == focus.market and q.bookmaker == focus.bookmaker
    )
    series = _line_series(snapshots, book_id, focus.market, focus.outcome)
    start, end = _window(series, focus.ts, window)
    meta = fixture_meta(fixture_id, path=path)

    return {
        "provenance": {
            "kind": "recorded-replay",
            "source": "TxODDS TxLINE",
            "note": (
                "Real captured wire records replayed through the real detector. Recorded, not live."
            ),
            "captureFromMs": snapshots[0].ts,
            "captureToMs": snapshots[-1].ts,
            "generatedAt": datetime.now(UTC).isoformat(timespec="seconds"),
        },
        "fixture": {
            "id": meta.id,
            "participant1": meta.participant1,
            "participant2": meta.participant2,
            "competition": meta.competition,
            "competitionId": meta.competition_id,
            "kickoffMs": meta.kickoff_ms,
        },
        "detector": {
            "thresholdPct": threshold_pct,
            "readingsObserved": len(snapshots),
            "movesFlagged": len(moves),
        },
        "line": {
            "bookmaker": focus.bookmaker,
            "market": focus.market,
            "outcome": focus.outcome,
            "readingsOnLine": len(series),
            "windowStart": start,
            "windowEnd": end,
        },
        "series": [asdict(r) for r in series[start:end]],
        "moves": [
            asdict(
                ExportedMove(
                    ts=m.ts,
                    bookmaker=m.bookmaker,
                    market=m.market,
                    outcome=m.outcome,
                    old_pct=round(m.old_pct, 3),
                    new_pct=round(m.new_pct, 3),
                    delta_pct=round(m.delta, 3),
                    direction=m.direction,
                )
            )
            for m in moves
        ],
    }


def build_policy_slice() -> dict[str, Any]:
    """The REAL custody policy the signing wallet is authorized with, as data.

    Reads :func:`gorilla.staking.chain_policy` and the ``watch`` defaults so the numbers the UI
    prints are the numbers the signer enforces — change one and the page changes with it."""
    purposes = frozenset({BET_PURPOSE, CREATE_PURPOSE})
    policy = chain_policy(cap_sol=DEFAULT_CAP_SOL, purposes=purposes)
    return {
        "source": "gorilla.staking.chain_policy + gorilla.watch defaults",
        "generatedAt": datetime.now(UTC).isoformat(timespec="seconds"),
        "maxSpendSol": policy.max_spend,
        "stakePerBetSol": DEFAULT_STAKE_SOL,
        "maxPerFixtureSol": DEFAULT_PER_FIXTURE_SOL,
        "allow": [
            {
                "purpose": purpose,
                "programId": FORGE_BINDINGS[purpose][0],
                "instruction": FORGE_BINDINGS[purpose][1],
            }
            for purpose in sorted(policy.allowed_purposes)
        ],
    }


def write_artifacts(
    out_dir: str | Path, *, fixture_id: int, path: str | Path | None = None
) -> Mapping[str, Path]:
    """Write both artifacts into ``out_dir``. Returns the paths written."""
    target = Path(out_dir).expanduser()
    target.mkdir(parents=True, exist_ok=True)
    written: dict[str, Path] = {}
    for name, payload in (
        ("agent-replay.json", build_replay_slice(fixture_id, path=path)),
        ("agent-policy.json", build_policy_slice()),
    ):
        file = target / name
        file.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
        written[name] = file
    return written
