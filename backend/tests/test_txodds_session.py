"""The TxODDS auth seam — headers correct, tokens never leaked.

The whole engine/adapter boundary is ``auth_headers()``. These tests pin the header shape and,
more importantly, that no token value can escape through a repr, a traceback, or an error.
"""

from __future__ import annotations

import base64
import json
import time

import pytest

from gorilla.txodds_session import (
    SESSION_PATH_ENV,
    SessionError,
    TxoddsSession,
    session_path,
)

_SECRET_JWT = "header.payload.signature"
_SECRET_TOKEN = "txoracle_api_supersecret"


def _write_session(tmp_path, jwt=_SECRET_JWT, api_token=_SECRET_TOKEN):
    path = tmp_path / "txodds-session.json"
    path.write_text(json.dumps({"jwt": jwt, "api_token": api_token}))
    return path


def _jwt_with_exp(exp: int) -> str:
    claims = base64.urlsafe_b64encode(json.dumps({"exp": exp}).encode()).decode().rstrip("=")
    return f"header.{claims}.signature"


def test_auth_headers_are_the_two_tokens_txline_requires():
    session = TxoddsSession(jwt="jay", api_token="tok")
    assert session.auth_headers() == {"Authorization": "Bearer jay", "X-Api-Token": "tok"}


def test_repr_never_contains_a_token():
    """A stray print or traceback must not spill credentials."""
    session = TxoddsSession(jwt=_SECRET_JWT, api_token=_SECRET_TOKEN)
    assert _SECRET_JWT not in repr(session)
    assert _SECRET_TOKEN not in repr(session)
    assert "redacted" in repr(session)


def test_from_file_loads_the_established_session(tmp_path):
    session = TxoddsSession.from_file(_write_session(tmp_path))
    assert session.auth_headers()["X-Api-Token"] == _SECRET_TOKEN


def test_missing_file_raises_with_the_path_but_no_token(tmp_path):
    with pytest.raises(SessionError) as exc:
        TxoddsSession.from_file(tmp_path / "absent.json")
    assert "absent.json" in str(exc.value)
    assert _SECRET_TOKEN not in str(exc.value)


def test_malformed_session_is_rejected(tmp_path):
    path = tmp_path / "bad.json"
    path.write_text(json.dumps({"jwt": "only-one"}))
    with pytest.raises(SessionError, match="missing"):
        TxoddsSession.from_file(path)


def test_load_returns_none_instead_of_raising(tmp_path):
    assert TxoddsSession.load(tmp_path / "absent.json") is None


def test_session_path_honours_the_env_override(tmp_path, monkeypatch):
    monkeypatch.setenv(SESSION_PATH_ENV, str(tmp_path / "custom.json"))
    assert session_path() == tmp_path / "custom.json"


def test_expiry_is_read_from_the_jwt_claims():
    past = TxoddsSession(jwt=_jwt_with_exp(int(time.time()) - 60), api_token="t")
    future = TxoddsSession(jwt=_jwt_with_exp(int(time.time()) + 3600), api_token="t")
    assert past.is_expired() is True
    assert future.is_expired() is False


def test_unparseable_jwt_is_not_treated_as_expired():
    """Fail open on the CHECK (the live call is the real authority), never fail loud on a
    cosmetic decode problem."""
    session = TxoddsSession(jwt="not-a-jwt", api_token="t")
    assert session.expires_at() is None
    assert session.is_expired() is False
