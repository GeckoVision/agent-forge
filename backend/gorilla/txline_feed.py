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
import re
import urllib.error
import urllib.request
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import Any, Protocol
from urllib.parse import urlsplit

from .detector import OddsSnapshot, PriceQuote

_SPEC = Path(__file__).resolve().parent / "spec" / "txline_openapi.yaml"
_ODDS_SNAPSHOT_OP = "getApiOddsSnapshotFixtureid"
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
    """A stable market label so the same line matches across snapshots. Parameters (e.g. a
    handicap value) are appended so distinct lines of the same type stay distinct."""
    super_type = str(payload.get("SuperOddsType", ""))
    params = str(payload.get("MarketParameters", ""))
    return f"{super_type}|{params}" if params else super_type


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
        self._endpoint: tuple[str, str] | None = None  # (base_url, path) derived lazily, once

    def odds(self, fixture_id: int) -> OddsSnapshot:
        """One odds read for ``fixture_id`` as a typed ``OddsSnapshot``. Recorded / $0 (default,
        offline) carries schema-shaped PLACEHOLDER values — it proves the CALL is well-formed, not
        the market; use ``replay`` for a moving offline market. ``mode="live"`` returns the real
        book."""
        payloads = self._read(int(fixture_id))
        return _snapshot_from_payloads(int(fixture_id), payloads)

    def _read(self, fixture_id: int) -> list[Mapping[str, Any]]:
        """The one place the two modes diverge — the transport edge (invariant #3/rule #5)."""
        if self._mode == "live":
            return self._read_live(fixture_id)
        return _placeholder_payloads(fixture_id)

    def _read_live(self, fixture_id: int) -> list[Mapping[str, Any]]:
        base_url, path = self._endpoint_for(_ODDS_SNAPSHOT_OP)
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
        if self._endpoint is None:
            self._endpoint = _endpoint_from_spec(self._read_spec_text(), operation_id)
        return self._endpoint

    def _read_spec_text(self) -> str:
        try:
            return self._spec_path.read_text(encoding="utf-8")
        except OSError as exc:
            raise FeedError(f"could not read the TxLINE spec at {self._spec_path}") from exc


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
