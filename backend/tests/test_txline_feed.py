"""Gorilla feed — typed odds, recorded/$0, the live transport edge, and the replay.

Offline by default: ``odds`` runs in recorded mode (a schema-shaped placeholder) and ``replay``
is pure scripting. The live path is exercised through an injected transport, so no test touches
the network. Also guards the hard rule that the feed stays fully self-contained — stdlib +
``solders`` only, no external integration framework.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

import gorilla
from gorilla.detector import OddsSnapshot, SharpDetector
from gorilla.txline_feed import (
    _ODDS_SNAPSHOT_OP,
    _SPEC,
    FeedError,
    TxlineFeed,
    _assert_safe_url,
    _endpoint_from_spec,
    _quote_from_payload,
    _snapshot_from_payloads,
    replay,
)


def test_odds_call_is_first_call_correct_recorded():
    """A recorded read, offline: well-formed, typed, no key, no network."""
    snap = TxlineFeed().odds(42)
    assert isinstance(snap, OddsSnapshot)
    assert snap.fixture_id == 42


def test_recorded_odds_carry_no_usable_market_data_offline():
    """The seam limit, pinned: recorded mode proves the CALL but synthesizes placeholder
    values (a schema-shaped ``Pct`` that is not a real probability), so there is no usable
    market to detect on — that is what ``replay`` (and, live, the real feed) is for."""
    snap = TxlineFeed().odds(42)
    assert sum(len(q.pct) for q in snap.quotes) == 0


def test_quote_parsing_drops_na_and_unparseable():
    payload = {
        "FixtureId": 42,
        "BookmakerId": 7,
        "Bookmaker": "Acme",
        "SuperOddsType": "1x2",
        "MarketParameters": "",
        "Ts": 1000,
        "PriceNames": ["Home", "Draw", "Away"],
        "Pct": ["52.632", "NA", "bogus"],
    }
    quote = _quote_from_payload(payload)
    assert quote is not None
    assert quote.pct == {"Home": 52.632}  # NA + unparseable dropped
    assert quote.market == "1x2" and quote.bookmaker == "Acme"


def test_market_label_appends_parameters_to_keep_lines_distinct():
    base = {"FixtureId": 1, "BookmakerId": 1, "Ts": 0, "PriceNames": [], "Pct": []}
    plain = _quote_from_payload({**base, "SuperOddsType": "AH", "MarketParameters": ""})
    handicap = _quote_from_payload({**base, "SuperOddsType": "AH", "MarketParameters": "-0.5"})
    assert plain is not None and handicap is not None
    assert plain.market == "AH" and handicap.market == "AH|-0.5"


def test_snapshot_from_payloads_types_a_real_1x2_offer():
    snap = _snapshot_from_payloads(
        42,
        [
            {
                "FixtureId": 42,
                "BookmakerId": 3,
                "Bookmaker": "Pinnacle",
                "SuperOddsType": "1x2",
                "Ts": 1700,
                "PriceNames": ["Home", "Away"],
                "Pct": ["55.000", "45.000"],
            }
        ],
    )
    assert snap.fixture_id == 42 and snap.ts == 1700
    assert len(snap.quotes) == 1
    assert snap.quotes[0].pct == {"Home": 55.0, "Away": 45.0}


def test_replay_produces_exactly_one_detectable_sharp_move():
    """The offline market: sub-threshold drift, then one sharp move the detector catches."""
    det = SharpDetector(threshold_pct=3.0)
    flagged = [m for snap in replay(fixture_id=42, move_at=3) if (m := det.observe(snap))]
    assert len(flagged) == 1
    move = flagged[0]
    assert move.fixture_id == 42 and move.direction == "up"
    assert move.delta >= 9.0  # the scripted +9pp jump (plus a tick of drift)


def test_replay_is_deterministic():
    assert replay(fixture_id=42) == replay(fixture_id=42)


# --- the live transport edge (Pattern B: falsifiable offline via an injected transport) ----


def test_live_read_types_the_real_wire_via_injected_transport():
    """Live mode derives the URL from the spec, GETs through the injected transport, and parses
    the real wire shape into usable probabilities (the recorded placeholder cannot)."""
    captured: dict[str, object] = {}

    def fake_transport(url: str, headers):
        captured["url"] = url
        captured["headers"] = dict(headers)
        body = json.dumps(
            [
                {
                    "FixtureId": 42,
                    "BookmakerId": 3,
                    "Bookmaker": "Pinnacle",
                    "SuperOddsType": "1x2",
                    "Ts": 1700,
                    "PriceNames": ["Home", "Away"],
                    "Pct": ["55.000", "45.000"],
                }
            ]
        )
        return 200, body

    snap = TxlineFeed(mode="live", transport=fake_transport).odds(42)
    assert snap.fixture_id == 42 and snap.ts == 1700
    assert snap.quotes[0].pct == {"Home": 55.0, "Away": 45.0}
    assert captured["url"] == "https://txline.txodds.com/api/odds/snapshot/42"
    assert captured["headers"]["User-Agent"] == "gorilla/1.0"  # not the banned urllib default


def test_live_read_injects_session_auth_headers():
    """The auth/session seam: injected ``auth_headers()`` reach the transport (bearer +
    X-Api-Token), alongside the real User-Agent."""
    seen: dict[str, str] = {}

    def fake_transport(url: str, headers):
        seen.update(headers)
        return 200, "[]"

    class FakeSession:
        def auth_headers(self):
            return {"Authorization": "Bearer jwt", "X-Api-Token": "tok"}

    TxlineFeed(mode="live", transport=fake_transport, session=FakeSession()).odds(42)
    assert seen["Authorization"] == "Bearer jwt"
    assert seen["X-Api-Token"] == "tok"
    assert seen["User-Agent"] == "gorilla/1.0"


def test_live_non_200_raises_without_leaking_auth():
    """A non-200 surfaces as a FeedError carrying only the status — never the token/header."""
    feed = TxlineFeed(
        mode="live",
        transport=lambda url, headers: (403, "Access denied"),
        session=type("S", (), {"auth_headers": lambda self: {"X-Api-Token": "secret-tok"}})(),
    )
    with pytest.raises(FeedError) as excinfo:
        feed.odds(42)
    message = str(excinfo.value)
    assert "403" in message
    assert "secret-tok" not in message and "X-Api-Token" not in message


def test_ssrf_guard_blocks_private_loopback_and_non_http():
    """The SSRF guard refuses private/loopback IP literals, loopback names, and non-http(s)."""
    for bad in (
        "http://127.0.0.1/x",
        "http://169.254.169.254/latest/meta-data",  # cloud metadata
        "http://10.0.0.1/x",
        "http://[::1]/x",
        "http://localhost/x",
        "file:///etc/passwd",
        "gopher://internal/x",
    ):
        with pytest.raises(FeedError):
            _assert_safe_url(bad)
    # A public DNS host (the trusted spec host) passes without a DNS round-trip.
    _assert_safe_url("https://txline.txodds.com/api/odds/snapshot/42")


def test_live_endpoint_is_derived_from_the_checked_in_spec():
    """The base URL + path come from the spec's servers/paths, not a hardcoded constant."""
    base_url, path = _endpoint_from_spec(_SPEC.read_text(encoding="utf-8"), _ODDS_SNAPSHOT_OP)
    assert base_url == "https://txline.txodds.com"
    assert path == "/api/odds/snapshot/{fixtureId}"


# --- self-containment guard --------------------------------------------------------------


def test_feed_package_is_fully_self_contained():
    """The public package depends ONLY on the standard library and ``solders`` — a whitelist,
    so it stays green as the package grows but fails the moment any foreign integration
    dependency is re-introduced (a stray absolute ``import`` of an external framework)."""
    import ast
    import sys

    package_dir = Path(gorilla.__file__).resolve().parent
    allowed = set(sys.stdlib_module_names) | {"gorilla", "solders", "__future__"}
    offenders: list[str] = []
    for source in sorted(package_dir.rglob("*.py")):
        tree = ast.parse(source.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            mods: list[str] = []
            if isinstance(node, ast.Import):
                mods = [alias.name.split(".")[0] for alias in node.names]
            elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
                mods = [node.module.split(".")[0]]
            for mod in mods:
                if mod not in allowed:
                    offenders.append(
                        f"{source.relative_to(package_dir)}:{node.lineno}: imports {mod!r}"
                    )
    assert not offenders, "package must stay self-contained (stdlib + solders only):\n" + "\n".join(
        offenders
    )
