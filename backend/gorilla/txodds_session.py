"""The TxODDS auth seam — the ONE place live credentials enter the process.

``TxlineFeed`` takes an :class:`~gorilla.txline_feed.AuthProvider` (a single
``auth_headers()`` method) and never learns what a credential is. This module is the real
implementation of that seam: it reads the session the founder established once
(``gecko login`` -> ``~/.gecko/txodds-session.json``) and renders the two headers TxLINE
requires.

    Authorization: Bearer <session JWT>
    X-Api-Token:   <long-lived API token>

Nothing here is ever logged, printed, or placed in an exception — a failure names only the
PATH, never a token value (project security rule: redact before raising). The session file is
outside the repo and read-only to the process; the agent's tool surface never sees it.
"""

from __future__ import annotations

import base64
import json
import os
import time
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

# Where ``gecko login`` writes the established two-token session. Overridable so a test (or a
# second environment) can point at its own file without touching the code.
DEFAULT_SESSION_PATH = Path("~/.gecko/txodds-session.json")
SESSION_PATH_ENV = "GORILLA_TXODDS_SESSION"

AUTH_JWT_HEADER = "Authorization"
AUTH_APITOKEN_HEADER = "X-Api-Token"


class SessionError(Exception):
    """The live TxODDS session could not be loaded. Names the path, NEVER a token value."""


def session_path() -> Path:
    """The session file to read — ``$GORILLA_TXODDS_SESSION`` or the default."""
    override = os.environ.get(SESSION_PATH_ENV)
    return Path(override).expanduser() if override else DEFAULT_SESSION_PATH.expanduser()


@dataclass(frozen=True)
class TxoddsSession:
    """A live two-token TxODDS session behind the ``AuthProvider`` seam.

    Constructed from the on-disk session; ``auth_headers()`` is the whole contract the feed
    depends on. ``repr`` is overridden so a stray print/traceback can never spill a token."""

    jwt: str
    api_token: str

    def __repr__(self) -> str:  # never let a token reach a log line or a traceback
        return "TxoddsSession(jwt=<redacted>, api_token=<redacted>)"

    def auth_headers(self) -> Mapping[str, str]:
        """The headers TxLINE requires. The only method the feed knows about."""
        return {
            AUTH_JWT_HEADER: f"Bearer {self.jwt}",
            AUTH_APITOKEN_HEADER: self.api_token,
        }

    def expires_at(self) -> int | None:
        """The session JWT's ``exp`` (unix seconds), or ``None`` if it carries no claim.

        Decodes ONLY the public claims segment to read the expiry — no signature check, no
        secret involved, and no claim value is ever returned to a caller except ``exp``."""
        parts = self.jwt.split(".")
        if len(parts) < 2:
            return None
        payload = parts[1] + "=" * (-len(parts[1]) % 4)
        try:
            claims = json.loads(base64.urlsafe_b64decode(payload))
        except (ValueError, json.JSONDecodeError):
            return None
        exp = claims.get("exp")
        return int(exp) if isinstance(exp, (int, float)) else None

    def is_expired(self, *, now: float | None = None) -> bool:
        """True when the session JWT's ``exp`` has passed (a live read would 401)."""
        exp = self.expires_at()
        if exp is None:
            return False
        return exp <= (time.time() if now is None else now)

    @classmethod
    def from_file(cls, path: str | Path | None = None) -> "TxoddsSession":
        """Load the established session. Raises :class:`SessionError` (path only, no token)."""
        target = Path(path).expanduser() if path is not None else session_path()
        try:
            raw = json.loads(target.read_text(encoding="utf-8"))
        except FileNotFoundError:
            raise SessionError(
                f"no TxODDS session at {target} — run `gecko login` to establish one"
            ) from None
        except (OSError, json.JSONDecodeError) as exc:
            raise SessionError(
                f"could not read the TxODDS session at {target}: {type(exc).__name__}"
            ) from None
        jwt = raw.get("jwt")
        api_token = raw.get("api_token")
        if not isinstance(jwt, str) or not isinstance(api_token, str) or not jwt or not api_token:
            raise SessionError(f"the TxODDS session at {target} is missing 'jwt' / 'api_token'")
        return cls(jwt=jwt, api_token=api_token)

    @classmethod
    def load(cls, path: str | Path | None = None) -> "TxoddsSession | None":
        """``from_file`` but ``None`` instead of raising — for a caller that has a fallback."""
        try:
            return cls.from_file(path)
        except SessionError:
            return None
