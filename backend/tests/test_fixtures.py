"""Fixture discovery + THE competition filter.

The live fixture list mixes competitions (observed live: 6 Friendlies, 2 World Cup). Taking
"the first fixture" is how a friendly once got presented as a World Cup match. These tests pin
that the filter is applied on every path into a fixture choice.
"""

from __future__ import annotations

import json

import pytest

from gorilla.fixtures import (
    Fixture,
    filter_world_cup,
    parse_fixtures,
    pick_world_cup_fixture,
    world_cup_fixtures,
)
from gorilla.txline_feed import FeedError

# The exact shape the live endpoint returns, including the friendly that must be excluded.
_LIVE_BODY = json.dumps(
    [
        {
            "FixtureId": 111,
            "Competition": "Friendlies",
            "Participant1": "Vietnam",
            "Participant2": "Myanmar",
            "Participant1IsHome": True,
            "StartTime": 1000,
        },
        {
            "FixtureId": 18257865,
            "Competition": "World Cup",
            "Participant1": "France",
            "Participant2": "England",
            "Participant1IsHome": True,
            "StartTime": 3000,
        },
        {
            "FixtureId": 18257739,
            "Competition": "World Cup",
            "Participant1": "Spain",
            "Participant2": "Argentina",
            "Participant1IsHome": True,
            "StartTime": 5000,
        },
    ]
)


def _transport(status=200, body=_LIVE_BODY):
    def call(url, headers):
        assert "/api/fixtures/snapshot" in url
        return status, body

    return call


def test_parse_fixtures_reads_the_wire_shape():
    fixtures = parse_fixtures(_LIVE_BODY)
    assert len(fixtures) == 3
    assert fixtures[1] == Fixture(18257865, "World Cup", "France", "England", 3000)


def test_participant1_is_home_flag_orders_the_label():
    away_first = json.dumps(
        [
            {
                "FixtureId": 7,
                "Competition": "World Cup",
                "Participant1": "Brazil",
                "Participant2": "Peru",
                "Participant1IsHome": False,
                "StartTime": 1,
            }
        ]
    )
    fixture = parse_fixtures(away_first)[0]
    assert fixture.home == "Peru" and fixture.away == "Brazil"


def test_filter_world_cup_drops_the_friendly():
    """The core guard: a friendly never survives the filter."""
    kept = filter_world_cup(parse_fixtures(_LIVE_BODY))
    assert [f.fixture_id for f in kept] == [18257865, 18257739]
    assert all(f.competition == "World Cup" for f in kept)
    assert "Vietnam" not in {f.home for f in kept}


def test_world_cup_fixtures_filters_the_live_read():
    kept = world_cup_fixtures(transport=_transport())
    assert len(kept) == 2
    assert all(f.competition == "World Cup" for f in kept)


def test_pick_defaults_to_the_earliest_world_cup_fixture_not_the_first_listed():
    picked = pick_world_cup_fixture(transport=_transport())
    assert picked.fixture_id == 18257865  # earliest WC start, and NOT the friendly at index 0


def test_pick_by_id_refuses_a_non_world_cup_fixture():
    """Asking for the friendly BY ID is refused, not silently honoured."""
    with pytest.raises(FeedError, match="not a live World Cup fixture"):
        pick_world_cup_fixture(111, transport=_transport())


def test_pick_by_id_returns_the_requested_world_cup_fixture():
    picked = pick_world_cup_fixture(18257739, transport=_transport())
    assert picked.label() == "Spain v Argentina"


def test_non_200_raises_without_leaking_headers():
    with pytest.raises(FeedError) as exc:
        world_cup_fixtures(transport=_transport(status=403, body="denied"))
    assert "403" in str(exc.value)
    assert "Bearer" not in str(exc.value) and "Token" not in str(exc.value)


def test_no_world_cup_fixtures_raises_rather_than_falling_back_to_a_friendly():
    only_friendly = json.dumps(
        [{"FixtureId": 1, "Competition": "Friendlies", "Participant1": "A", "Participant2": "B"}]
    )
    with pytest.raises(FeedError, match="no World Cup fixtures"):
        pick_world_cup_fixture(transport=_transport(body=only_friendly))
