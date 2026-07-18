"""Live fixture discovery — and the competition filter that keeps a friendly out of the demo.

``/api/fixtures/snapshot`` returns EVERY fixture TxLINE currently carries, and that set MIXES
competitions: at the time of writing it is 8 fixtures — 6 ``Friendlies`` and 2 ``World Cup``.
Taking "the first fixture" is exactly how a friendly (Vietnam v Myanmar) once got presented as
a World Cup match. So the filter is not a display concern, it is a CORRECTNESS concern and it
lives here, in one function, with a test pinning it.

:func:`world_cup_fixtures` is the only supported way to choose a fixture to watch.
"""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from .txline_feed import (
    AuthProvider,
    FeedError,
    Transport,
    _assert_safe_url,
    _endpoint_from_spec,
    _urllib_transport,
    read_spec_text,
)

# The competition every fixture in this demo MUST belong to. Compared exactly (the feed's
# ``Competition`` is a stable string), so a rename surfaces as "no fixtures" rather than as a
# friendly quietly relabelled as a World Cup match.
WORLD_CUP = "World Cup"

_FIXTURES_SNAPSHOT_OP = "getApiFixturesSnapshot"
_USER_AGENT = "gorilla/1.0"


@dataclass(frozen=True)
class Fixture:
    """One fixture, as much of it as the demo needs to name what it is watching."""

    fixture_id: int
    competition: str
    home: str
    away: str
    start_time_ms: int

    def label(self) -> str:
        return f"{self.home} v {self.away}"

    def describe(self) -> str:
        return f"{self.label()} ({self.competition}, fixture {self.fixture_id})"


def _fixture_from_payload(payload: Mapping[str, Any]) -> Fixture | None:
    """One raw fixture record -> a typed ``Fixture``; ``None`` if it has no id."""
    fixture_id = payload.get("FixtureId")
    if fixture_id is None:
        return None
    # Participant1IsHome tells us which side is at home; default to participant 1.
    p1 = str(payload.get("Participant1", ""))
    p2 = str(payload.get("Participant2", ""))
    p1_home = bool(payload.get("Participant1IsHome", True))
    home, away = (p1, p2) if p1_home else (p2, p1)
    return Fixture(
        fixture_id=int(fixture_id),
        competition=str(payload.get("Competition", "")),
        home=home,
        away=away,
        start_time_ms=int(payload.get("StartTime") or 0),
    )


def filter_world_cup(fixtures: Sequence[Fixture]) -> tuple[Fixture, ...]:
    """Keep ONLY World Cup fixtures. The guard against showing a friendly as a World Cup match.

    Kept a separate pure function (not folded into the fetch) so it is testable with zero
    network and so every caller goes through the same one rule."""
    return tuple(f for f in fixtures if f.competition == WORLD_CUP)


def parse_fixtures(body: str) -> tuple[Fixture, ...]:
    """Parse a ``/api/fixtures/snapshot`` body into typed fixtures (unfiltered)."""
    parsed = json.loads(body) if body.strip() else []
    if not isinstance(parsed, list):
        return ()
    return tuple(f for f in (_fixture_from_payload(p) for p in parsed) if f is not None)


def fetch_fixtures(
    *,
    session: AuthProvider | None = None,
    transport: Transport | None = None,
    spec_path: str | None = None,
) -> tuple[Fixture, ...]:
    """Live-read every fixture TxLINE currently carries (UNFILTERED — see
    :func:`world_cup_fixtures`). Transport + session are injectable so this is
    offline-falsifiable (Pattern B)."""
    base_url, path = _endpoint_from_spec(read_spec_text(spec_path), _FIXTURES_SNAPSHOT_OP)
    url = base_url.rstrip("/") + path
    _assert_safe_url(url)
    headers: dict[str, str] = {"User-Agent": _USER_AGENT, "Accept": "application/json"}
    if session is not None:
        headers.update(session.auth_headers())  # never logged
    status, body = (transport or _urllib_transport)(url, headers)
    if status != 200:
        # Redact-before-raise: status only, never a header/token.
        raise FeedError(f"TxLINE fixtures snapshot failed: HTTP {status}")
    return parse_fixtures(body)


def world_cup_fixtures(
    *,
    session: AuthProvider | None = None,
    transport: Transport | None = None,
    spec_path: str | None = None,
) -> tuple[Fixture, ...]:
    """Every LIVE World Cup fixture, competition-filtered. The only supported picker."""
    return filter_world_cup(
        fetch_fixtures(session=session, transport=transport, spec_path=spec_path)
    )


def history_world_cup_fixtures(path: str | None = None) -> tuple[Fixture, ...]:
    """The World Cup fixtures present in the REAL captured history — the fallback picker.

    Runs the SAME competition filter as the live path, because the capture mixes competitions
    too (its own manifest records 152 Friendlies vs 106 World Cup records). Offline is not an
    excuse to skip the filter."""
    from .txline_feed import FeedError as _FeedError
    from .txline_feed import history_dir

    manifest = history_dir(path) / "raw" / "fixtures.jsonl"
    if not manifest.is_file():
        raise _FeedError(f"no captured fixture list at {manifest}")
    seen: dict[int, Fixture] = {}
    with manifest.open("r", encoding="utf-8") as handle:
        for line in handle:
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                continue  # the capture is untrusted input; skip a corrupt line
            if not isinstance(record, dict):
                continue
            fixture = _fixture_from_payload(record)
            if fixture is not None:
                seen[fixture.fixture_id] = fixture
    return filter_world_cup(tuple(seen.values()))


def pick_from_candidates(candidates: Sequence[Fixture], fixture_id: int | None = None) -> Fixture:
    """Pure pick over an already-fetched candidate set (earliest-starting, or the asked-for id).

    Split from :func:`pick_world_cup_fixture` so a caller that needs the WHOLE candidate set
    too — the watch keeps it as its oracle-coverage evidence — fetches it exactly once."""
    if not candidates:
        raise FeedError("no World Cup fixtures are live on TxLINE right now")
    if fixture_id is None:
        return sorted(candidates, key=lambda f: (f.start_time_ms, f.fixture_id))[0]
    for fixture in candidates:
        if fixture.fixture_id == fixture_id:
            return fixture
    ids = ", ".join(str(f.fixture_id) for f in candidates)
    raise FeedError(
        f"fixture {fixture_id} is not a live {WORLD_CUP} fixture (live World Cup ids: {ids})"
    )


def pick_world_cup_fixture(
    fixture_id: int | None = None,
    *,
    session: AuthProvider | None = None,
    transport: Transport | None = None,
) -> Fixture:
    """Resolve the fixture to watch, ALWAYS through the competition filter.

    With ``fixture_id`` it must be a World Cup fixture or this raises — asking for a friendly
    by id is refused rather than silently watched. Without one it takes the earliest-starting
    World Cup fixture."""
    return pick_from_candidates(
        world_cup_fixtures(session=session, transport=transport), fixture_id
    )
