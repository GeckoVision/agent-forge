"""Gorilla odds feed — verifiable real-time World Cup odds, first call correct.

A direct, self-contained TxLINE odds reader. It owns the whole path from the wire to a typed
``OddsSnapshot`` with no external integration layer: it reads the TxLINE OpenAPI spec that ships
in ``spec/`` to learn the endpoint, calls it, and parses the response itself. Everything here is
Gorilla-branded and stdlib-only (``urllib``).

Two modes, one code path — they diverge only at the transport edge:

* **recorded / $0 (default):** no key, no subscription, no network. Synthesizes a schema-shaped
  PLACEHOLDER snapshot so the call is proven well-formed (right endpoint, right params) and the
  result is a real, typed ``OddsSnapshot`` — but its prices are placeholders, so it proves the
  CALL, not the market. To exercise the detector/agent on a *moving* market offline, use
  ``replay`` — a deterministic scripted timeline.
* **live:** a direct ``urllib`` GET to the real TxLINE odds endpoint (URL + path derived from the
  spec), SSRF-guarded, carrying a real ``User-Agent`` (Cloudflare 403-bans the stdlib default).
  The HTTP transport and the auth session are injectable, so the live path is falsifiable offline
  (Pattern B) without ever touching the network in a test.
"""

from __future__ import annotations

import ipaddress
import json
import os
import re
import urllib.error
import urllib.request
from collections.abc import Callable, Iterable, Mapping
from pathlib import Path
from typing import Any, Protocol
from urllib.parse import urlsplit

from .detector import OddsSnapshot, PriceQuote

_SPEC = Path(__file__).resolve().parent / "spec" / "txline_openapi.yaml"
_ODDS_SNAPSHOT_OP = "getApiOddsSnapshotFixtureid"
# The fixture's live update series (every real price update in the current in-memory cache) —
# the read the detector actually needs; the snapshot is one static reading per 5-min interval.
_ODDS_UPDATES_OP = "getApiOddsUpdatesFixtureid"
# TxLINE sits behind Cloudflare, which 403-bans the stdlib default ``Python-urllib/*``; send a
# real product UA (learned the hard way). Mirrors privy_http's PRIVY_USER_AGENT rule.
_USER_AGENT = "gorilla/1.0"
_TIMEOUT = 30
# Loopback host NAMES an IP-literal check can't catch (a private IP literal is caught directly).
_BLOCKED_HOSTNAMES = frozenset({"localhost"})
# An OpenAPI ``paths`` key: two-space indent, starts with '/', ends in ':'. Used by the targeted
# spec scan below (not a general YAML parse — see ``_endpoint_from_spec``).
_PATH_KEY = re.compile(r"^  (/[^\s:]+):\s*$")


class FeedError(Exception):
    """A TxLINE feed read failed — a blocked/malformed URL, a transport error, or a non-200.

    Never carries an auth header or token: errors reference only the host and status."""


# --- wire -> typed translation (the feed owns parsing; the detector stays pure) ----------


def _parse_pct(raw: Any) -> float | None:
    """A feed ``Pct`` is a 3-dp string, ``NA`` (quarter-handicap), or — offline — a schema
    placeholder. Return a float or ``None`` so the detector never sees an unparseable line."""
    if raw is None or raw == "NA":
        return None
    try:
        return float(raw)
    except (TypeError, ValueError):
        return None


def _market_label(payload: Mapping[str, Any]) -> str:
    """A stable market label so the same line matches across snapshots — and so two DIFFERENT
    lines never collide.

    The label must carry every field that distinguishes one tradeable line from another,
    because the detector keys a price history on ``(fixture, bookmaker, market, outcome)``. Two
    components matter:

    * ``MarketParameters`` — the handicap / total (``line=2`` vs ``line=2.5``).
    * ``MarketPeriod`` — the phase (full match, ``half=1``, ...). **Omitting this was a real
      bug.** TxLINE publishes the full-match and first-half ``1X2`` lines interleaved at the
      same timestamp; without the period they share one key and the detector reads the
      alternation as movement. On the real France v England book that manufactured 1623
      "sharp moves" out of 4172 readings — every one an artifact. With the period included the
      same real data yields 2 genuine moves. A phantom signal is worse than no signal: it is
      what a policy-gated wallet would have staked on.
    """
    parts = [
        str(payload.get("SuperOddsType") or ""),
        str(payload.get("MarketParameters") or ""),
        str(payload.get("MarketPeriod") or ""),
    ]
    return "|".join(part for part in parts if part)


def _quote_from_payload(payload: Mapping[str, Any]) -> PriceQuote | None:
    """One raw ``OddsPayload`` -> a typed ``PriceQuote`` (unparseable lines dropped). Returns
    ``None`` for a payload missing the identity fields a price line needs."""
    fixture_id = payload.get("FixtureId")
    book_id = payload.get("BookmakerId")
    if fixture_id is None or book_id is None:
        return None
    names = payload.get("PriceNames") or []
    pcts = payload.get("Pct") or []
    pct: dict[str, float] = {}
    for name, raw in zip(names, pcts):
        value = _parse_pct(raw)
        if value is not None:
            pct[str(name)] = value
    return PriceQuote(
        fixture_id=int(fixture_id),
        bookmaker=str(payload.get("Bookmaker", "")),
        bookmaker_id=int(book_id),
        market=_market_label(payload),
        ts=int(payload.get("Ts", 0)),
        pct=pct,
    )


def _snapshot_from_payloads(fixture_id: int, payloads: list[Mapping[str, Any]]) -> OddsSnapshot:
    quotes = tuple(q for q in (_quote_from_payload(p) for p in payloads) if q is not None)
    ts = max((q.ts for q in quotes), default=0)
    return OddsSnapshot(fixture_id=fixture_id, ts=ts, quotes=quotes)


def group_into_snapshots(
    fixture_id: int, payloads: Iterable[Mapping[str, Any]]
) -> list[OddsSnapshot]:
    """A flat stream of raw odds payloads -> ordered snapshots, one per distinct timestamp.

    The wire format is a flat list of per-line updates; the detector consumes *readings*. All
    lines published at the same ``Ts`` are one reading, and readings are ordered by ``Ts`` so
    the detector sees the market in the order the book moved it. Payloads with no usable
    probability (an ``NA`` quarter-handicap, an empty ``Pct``) are dropped rather than faked."""
    by_ts: dict[int, list[PriceQuote]] = {}
    for payload in payloads:
        quote = _quote_from_payload(payload)
        if quote is None or not quote.pct:
            continue
        by_ts.setdefault(quote.ts, []).append(quote)
    return [
        OddsSnapshot(fixture_id=fixture_id, ts=ts, quotes=tuple(by_ts[ts])) for ts in sorted(by_ts)
    ]


# --- the live transport edge (injectable, SSRF-guarded) ----------------------------------
#
# A live HTTP transport: (url, headers) -> (status_code, response_body_text). The default hits
# the real network via stdlib ``urllib``; a light fake is injected in tests so the live path is
# offline-falsifiable (Pattern B) — the two modes diverge ONLY here.
Transport = Callable[[str, Mapping[str, str]], "tuple[int, str]"]


class AuthProvider(Protocol):
    """The optional live-auth seam. ``auth_headers()`` returns the headers TxLINE requires
    (the session JWT bearer + the long-lived ``X-Api-Token``). Kept a Protocol so a real session
    or a test fake both satisfy it without the feed importing any concrete auth type — the whole
    engine/adapter seam is this one method."""

    def auth_headers(self) -> Mapping[str, str]: ...


def _urllib_transport(url: str, headers: Mapping[str, str]) -> tuple[int, str]:
    """The default live transport: a real stdlib ``urllib`` GET. A non-2xx is returned as a
    ``(status, body)`` outcome (not raised) so the caller sees the real API's answer; only a
    genuine connection failure raises. Never logs headers (they carry the auth token)."""
    req = urllib.request.Request(url, headers=dict(headers), method="GET")
    try:
        with urllib.request.urlopen(req, timeout=_TIMEOUT) as resp:
            return int(resp.status), resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        return int(exc.code), exc.read().decode("utf-8", "replace")
    except urllib.error.URLError as exc:
        # Redact-before-raise: the reason is a network message, never a header/token.
        raise FeedError(f"TxLINE odds request failed: {exc.reason}") from None


def _assert_safe_url(url: str) -> None:
    """SSRF guard for the live path: block non-http(s) schemes and any request whose host is a
    loopback name or a private / loopback / link-local / reserved IP literal.

    The TxLINE host is a trusted, checked-in spec constant and only the integer ``fixtureId``
    varies at call time, so a literal check covers the realistic vectors (metadata IPs,
    ``file://``, private ranges) without a DNS round-trip — which keeps the live path
    offline-falsifiable through the injected transport."""
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https"):
        raise FeedError(f"refusing non-http(s) URL (scheme {parts.scheme!r})")
    host = parts.hostname
    if not host:
        raise FeedError("refusing URL with no host")
    lowered = host.lower()
    if lowered in _BLOCKED_HOSTNAMES or lowered.endswith(".localhost"):
        raise FeedError(f"refusing loopback host {host!r}")
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return  # a DNS name, not an IP literal — the trusted spec host lands here
    if (
        ip.is_private
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_reserved
        or ip.is_multicast
        or ip.is_unspecified
    ):
        raise FeedError(f"refusing request to non-public address {host!r}")


def _endpoint_from_spec(spec_text: str, operation_id: str) -> tuple[str, str]:
    """Derive ``(base_url, path_template)`` for ``operation_id`` from the OpenAPI YAML.

    A TARGETED line scan, not a general YAML parser — it reads only the two facts the live GET
    needs (the first ``servers[].url`` and the ``paths`` key whose block declares this
    ``operationId``), so the module stays stdlib-only with no YAML dependency. A unit test pins it
    to the checked-in spec, so a structural drift fails a test rather than a live call."""
    lines = spec_text.splitlines()

    base_url = ""
    in_servers = False
    for line in lines:
        if line.rstrip() == "servers:":
            in_servers = True
            continue
        if in_servers:
            stripped = line.strip()
            if stripped.startswith("- url:"):
                base_url = stripped[len("- url:") :].strip().strip("'\"")
                break
            # A new top-level key (column 0, ends in ':') closes the servers block.
            if line[:1].strip() and line.rstrip().endswith(":"):
                break

    path = ""
    target = f"operationId: {operation_id}"
    op_line = next((i for i, ln in enumerate(lines) if ln.strip() == target), None)
    if op_line is not None:
        # Walk up to the nearest two-space ``/...:`` path key above the operationId.
        for i in range(op_line, -1, -1):
            match = _PATH_KEY.match(lines[i])
            if match:
                path = match.group(1)
                break

    if not base_url or not path:
        raise FeedError(f"could not derive a live endpoint for {operation_id!r} from the spec")
    return base_url, path


def read_spec_text(spec_path: str | Path | None = None) -> str:
    """The checked-in TxLINE OpenAPI text. Shared with :mod:`gorilla.fixtures` so both live
    endpoints are derived from the SAME spec rather than a hardcoded URL."""
    target = Path(spec_path) if spec_path else _SPEC
    try:
        return target.read_text(encoding="utf-8")
    except OSError as exc:
        raise FeedError(f"could not read the TxLINE spec at {target}") from exc


def _placeholder_payloads(fixture_id: int) -> list[Mapping[str, Any]]:
    """Recorded / $0 mode: ONE schema-shaped ``OddsPayload`` with PLACEHOLDER prices.

    It mirrors the wire shape the live feed returns — so the call is proven well-formed and the
    result is a real, typed ``OddsSnapshot`` — but every ``Pct`` is a non-numeric placeholder, so
    the feed drops them (:func:`_parse_pct`) and the snapshot carries a market LINE with NO usable
    probabilities. Offline you get the CALL, not the market; :func:`replay` is the moving offline
    market the detector/agent actually consumes."""
    payload: Mapping[str, Any] = {
        "FixtureId": fixture_id,
        "BookmakerId": 0,
        "Bookmaker": "",
        "SuperOddsType": "1x2",
        "MarketParameters": "",
        "Ts": 0,
        "PriceNames": ["Home", "Draw", "Away"],
        "Pct": ["placeholder", "placeholder", "placeholder"],
    }
    return [payload]


class TxlineFeed:
    """Gorilla's typed odds feed — a direct, self-contained TxLINE reader.

    Recorded / $0 (the default) synthesizes a schema-shaped placeholder offline; ``mode="live"``
    does a real ``urllib`` GET to the TxLINE odds endpoint. The HTTP ``transport`` and the auth
    ``session`` are injectable, so the live path is offline-falsifiable (Pattern B)."""

    def __init__(
        self,
        *,
        mode: str = "recorded",
        spec_path: str | Path | None = None,
        transport: Transport | None = None,
        session: AuthProvider | None = None,
    ) -> None:
        self._mode = mode
        self._spec_path = Path(spec_path) if spec_path else _SPEC
        self._transport = transport or _urllib_transport
        self._session = session
        # operation_id -> (base_url, path), each derived from the spec lazily and cached once.
        self._endpoints: dict[str, tuple[str, str]] = {}

    def odds(self, fixture_id: int) -> OddsSnapshot:
        """One odds read for ``fixture_id`` as a typed ``OddsSnapshot``. Recorded / $0 (default,
        offline) carries schema-shaped PLACEHOLDER values — it proves the CALL is well-formed, not
        the market; use ``replay`` for a moving offline market. ``mode="live"`` returns the real
        book."""
        payloads = self._read(int(fixture_id))
        return _snapshot_from_payloads(int(fixture_id), payloads)

    def updates(self, fixture_id: int) -> list[OddsSnapshot]:
        """The fixture's REAL update series from TxLINE's live in-memory cache, as an ordered
        list of typed snapshots (one per distinct timestamp).

        This — not repeated ``odds()`` polls — is the live stream the agent watches. The
        snapshot endpoint serves one reading per 5-minute interval, so polling it every few
        seconds returns the SAME reading and can never show a market moving. The updates
        endpoint returns every real price update the book has published for this fixture, which
        is what a sharp-money detector actually needs. Live only."""
        if self._mode != "live":
            raise FeedError("updates() is a live-only read (no offline synthesis of a market)")
        payloads = self._read_live(fixture_id, _ODDS_UPDATES_OP)
        return group_into_snapshots(fixture_id, payloads)

    def _read(self, fixture_id: int) -> list[Mapping[str, Any]]:
        """The one place the two modes diverge — the transport edge (invariant #3/rule #5)."""
        if self._mode == "live":
            return self._read_live(fixture_id, _ODDS_SNAPSHOT_OP)
        return _placeholder_payloads(fixture_id)

    def _read_live(
        self, fixture_id: int, operation_id: str = _ODDS_SNAPSHOT_OP
    ) -> list[Mapping[str, Any]]:
        base_url, path = self._endpoint_for(operation_id)
        # fixture_id is an int, so path interpolation cannot inject anything host-changing.
        url = base_url.rstrip("/") + path.replace("{fixtureId}", str(fixture_id))
        _assert_safe_url(url)  # SSRF: no private/loopback host, no non-http scheme
        headers: dict[str, str] = {"User-Agent": _USER_AGENT, "Accept": "application/json"}
        if self._session is not None:
            headers.update(self._session.auth_headers())  # bearer + X-Api-Token, never logged
        status, body = self._transport(url, headers)
        if status != 200:
            # Redact-before-raise: only the fixture + status, never a header/token.
            raise FeedError(f"TxLINE odds read for fixture {fixture_id} failed: HTTP {status}")
        parsed = json.loads(body) if body.strip() else []
        # The odds snapshot endpoint returns a top-level JSON array of OddsPayload objects.
        return parsed if isinstance(parsed, list) else []

    def _endpoint_for(self, operation_id: str) -> tuple[str, str]:
        cached = self._endpoints.get(operation_id)
        if cached is None:
            cached = _endpoint_from_spec(read_spec_text(self._spec_path), operation_id)
            self._endpoints[operation_id] = cached
        return cached


# --- the REAL captured history (the honest fallback when the live feed is unavailable) ----
#
# The TxODDS World Cup API closes ~Jul 19. When the live feed is gone, the agent must NOT fall
# back to the synthetic placeholder or the scripted ``replay`` and call it a market — that
# would be fabricating data. It falls back to REAL captured odds history: the exact wire
# records that came off the live API, on disk, replayed in order. Recorded real data is still
# real data; synthesized data is not.

HISTORY_PATH_ENV = "GORILLA_TXODDS_HISTORY"
DEFAULT_HISTORY_DIR = Path("~/PycharmProjects/Gecko/sharp-detector/data/txodds-history")


def history_dir(path: str | Path | None = None) -> Path:
    """The captured-history directory — explicit arg, ``$GORILLA_TXODDS_HISTORY``, or default.

    The capture is gigabytes of real wire records, so it lives OUTSIDE the repo and is located
    by configuration rather than checked in."""
    if path is not None:
        return Path(path).expanduser()
    override = os.environ.get(HISTORY_PATH_ENV)
    return Path(override).expanduser() if override else DEFAULT_HISTORY_DIR.expanduser()


def history_replay(
    fixture_id: int,
    *,
    path: str | Path | None = None,
    limit: int | None = None,
) -> list[OddsSnapshot]:
    """Replay this fixture's REAL captured odds history as ordered snapshots.

    Scans the captured per-day wire records for ``fixture_id`` and groups them exactly as the
    live path does — same parser, same grouping, same typed result — so the detector cannot
    tell the difference between this and the live read. ``limit`` caps the number of readings.

    Raises :class:`FeedError` if the capture is missing or holds nothing for this fixture: an
    absent fallback must FAIL, never quietly degrade into synthesized prices."""
    root = history_dir(path)
    odds_dir = root / "raw" / "odds"
    if not odds_dir.is_dir():
        raise FeedError(
            f"no captured TxODDS history at {odds_dir} — set ${HISTORY_PATH_ENV} to the capture"
        )
    payloads: list[Mapping[str, Any]] = []
    for day_file in sorted(odds_dir.glob("day-*.jsonl")):
        payloads.extend(_history_records(day_file, fixture_id))
    if not payloads:
        raise FeedError(
            f"the captured history at {odds_dir} holds no odds for fixture {fixture_id}"
        )
    snapshots = group_into_snapshots(fixture_id, payloads)
    return snapshots[:limit] if limit is not None else snapshots


def _history_records(day_file: Path, fixture_id: int) -> list[Mapping[str, Any]]:
    """Every captured record for ``fixture_id`` in one day file.

    Streams line by line (these files are ~60-200MB each) and pre-filters on the raw text before
    parsing JSON, so scanning the whole capture stays cheap. A corrupt line is skipped, not
    fatal — the capture is treated as untrusted input.

    The pre-filter deliberately matches only the BARE id, not ``"FixtureId": <id>``: the capture
    is written as compact JSON with no space after the colon, so a separator-sensitive needle
    silently matches nothing and the fallback reports "no odds" for a fixture that is right
    there. Correctness does not rest on the pre-filter — every surviving line is parsed and its
    ``FixtureId`` checked exactly."""
    needle = str(fixture_id)
    out: list[Mapping[str, Any]] = []
    try:
        with day_file.open("r", encoding="utf-8") as handle:
            for line in handle:
                if needle not in line:
                    continue
                try:
                    record = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(record, dict) and record.get("FixtureId") == fixture_id:
                    out.append(record)
    except OSError as exc:
        raise FeedError(f"could not read captured history file {day_file.name}") from exc
    return out


# --- offline moving-market simulation (the "recorded feed" the agent loop consumes) -------
#
# Recorded mode synthesizes ONE static, schema-shaped snapshot, so it can prove a call is
# well-formed but cannot show movement. To exercise the detector/agent offline we script a
# deterministic timeline: gentle sub-threshold drift, then one sharp move. Live mode replaces
# this with repeated ``TxlineFeed.odds`` polls of the real, moving feed.

_OUTCOMES = ("Home", "Draw", "Away")


def replay(
    *,
    fixture_id: int = 42,
    bookmaker: str = "Pinnacle",
    bookmaker_id: int = 3,
    base: Mapping[str, float] | None = None,
    drift: float = 0.2,
    move_at: int = 3,
    move: Mapping[str, float] | None = None,
    ticks: int = 6,
    start_ts: int = 1_700_000_000_000,
    step_ms: int = 60_000,
) -> list[OddsSnapshot]:
    """A deterministic offline market for ``fixture_id``: ``ticks`` typed snapshots that drift
    sub-threshold, then take one sharp move at ``move_at``. No RNG — reproducible, so the demo
    and its tests are stable. ``base`` is the opening 1x2 implied-prob split (defaults
    ~45/27/28); ``move`` is the pp jump applied at ``move_at`` (defaults Home +9 / Away -9)."""
    probs = dict(base or {"Home": 45.0, "Draw": 27.0, "Away": 28.0})
    jump = dict(move or {"Home": 9.0, "Away": -9.0})
    out: list[OddsSnapshot] = []
    for tick in range(ticks):
        # Sub-threshold drift each tick, keeping the book roughly balanced.
        probs["Home"] = round(probs["Home"] + drift, 3)
        probs["Away"] = round(probs["Away"] - drift, 3)
        if tick == move_at:
            for outcome, delta in jump.items():
                probs[outcome] = round(probs[outcome] + delta, 3)
        ts = start_ts + tick * step_ms
        quote = PriceQuote(
            fixture_id=fixture_id,
            bookmaker=bookmaker,
            bookmaker_id=bookmaker_id,
            market="1x2",
            ts=ts,
            pct={name: probs[name] for name in _OUTCOMES},
        )
        out.append(OddsSnapshot(fixture_id=fixture_id, ts=ts, quotes=(quote,)))
    return out
