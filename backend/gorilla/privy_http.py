"""Shared low-level Privy REST primitives — one source of truth for the Privy seam.

Both the custody wallet (:mod:`gorilla.wallets`) and the policy control-plane
(:mod:`gorilla.privy_policy`) talk to ``api.privy.io`` through here, so the auth header
shape, the User-Agent, the credential loading, and the secret-redaction all live in ONE place.

Two hard rules this module enforces:

* **A real User-Agent.** Privy sits behind Cloudflare, which 403-bans the stdlib default
  ``Python-urllib/*``. Every request carries ``gorilla/<v>`` so the live call is not shadow-
  banned. This is exactly the "stubbed-but-shipped fails live" trap (Pattern B) — so
  :func:`rpc_headers` is a pure function a unit test falsifies offline.
* **The app secret never leaks.** It is Basic-auth-encoded into the ``Authorization`` header and
  otherwise confined here; it is never placed in an exception, log line, or ``repr``. Errors
  reference "Privy", never the secret.

DEVNET-ONLY in this repo: the only CAIP-2 exposed is Solana devnet.
"""

from __future__ import annotations

import base64
import json
import os
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Callable

# ── constants (Privy-wide; imported by wallets.py + privy_policy.py) ──────────────
PRIVY_BASE = "https://api.privy.io"
# Cloudflare 403-bans Python-urllib/*; send a real product UA. Bump with the package version.
PRIVY_USER_AGENT = "gorilla/1.0"
# Solana devnet genesis (CAIP-2). Devnet-only — mirrors SolanaRpc's mainnet refusal. Privy uses
# this to route signAndSendTransaction to devnet, so a mainnet caip2 is a bug, never a config.
PRIVY_SOLANA_DEVNET_CAIP2 = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"

# The provisioned devnet demo server-wallet (env-overridable — never hardcode a wallet as the
# only option; these are defaults for THIS devnet demo, not a lock-in).
DEFAULT_PRIVY_WALLET_ID = "vhjrgx9dao8x2nv725n0050o"
DEFAULT_PRIVY_WALLET_ADDRESS = "HNUE5KKTcaT4BuG5zmXxTViKjwNaQTtNt2svumE1WCoi"

# A Privy REST transport: (http_method, path, body|None) -> parsed JSON. Injectable so every
# create/attach/sign is unit-tested with zero network.
Transport = Callable[[str, str, "dict[str, Any] | None"], "dict[str, Any]"]


class PrivyError(Exception):
    """A Privy REST call failed. NEVER carries the app secret."""


def _env_file() -> Path:
    """The optional local ``.env`` fallback for creds not exported in the process env.
    Overridable with ``GORILLA_ENV_FILE``; defaults to a repo-local ``.env`` (gitignored).
    Never required — an exported env var always wins, so this is a dev convenience, not a dep."""
    override = os.environ.get("GORILLA_ENV_FILE")
    if override:
        return Path(override).expanduser()
    return Path(__file__).resolve().parent.parent / ".env"


def _env(name: str) -> str | None:
    """Read a var from the process env, falling back to a local ``.env`` on disk (see
    :func:`_env_file`). The exported value always wins."""
    val = os.environ.get(name)
    if val:
        return val
    env_file = _env_file()
    if env_file.exists():
        for line in env_file.read_text().splitlines():
            line = line.strip()
            if line.startswith(f"{name}=") and not line.startswith("#"):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    return None


def privy_creds() -> tuple[str | None, str | None]:
    """``(app_id, app_secret)`` from env or a local ``.env``. Values are never logged."""
    return _env("PRIVY_APP_ID"), _env("PRIVY_APP_SECRET")


def privy_wallet_config() -> tuple[str, str]:
    """``(wallet_id, address)`` for the demo wallet — env-overridable, else the provisioned pair."""
    return (
        _env("PRIVY_WALLET_ID") or DEFAULT_PRIVY_WALLET_ID,
        _env("PRIVY_WALLET_ADDRESS") or DEFAULT_PRIVY_WALLET_ADDRESS,
    )


def rpc_headers(app_id: str, app_secret: str) -> dict[str, str]:
    """Build the Privy request headers — Basic auth + app id + a REAL User-Agent (the Cloudflare
    fix). Pure so a unit test can assert the UA is set and is not the banned urllib default."""
    auth = base64.b64encode(f"{app_id}:{app_secret}".encode()).decode()
    return {
        "Authorization": f"Basic {auth}",
        "privy-app-id": app_id,
        "Content-Type": "application/json",
        "User-Agent": PRIVY_USER_AGENT,
        "Accept": "application/json",
    }


def privy_request(
    http_method: str,
    path: str,
    *,
    app_id: str,
    app_secret: str,
    body: dict[str, Any] | None = None,
    idempotency_key: str | None = None,
    timeout: int = 40,
) -> dict[str, Any]:
    """The real urllib transport to ``api.privy.io``. Raises :class:`PrivyError` with Privy's
    error body (secret-free) on a non-2xx, so a policy denial surfaces cleanly.

    ``idempotency_key`` (24h window) makes a founder re-run of a mutating create safe — Privy
    returns the same object instead of a duplicate."""
    data = json.dumps(body).encode() if body is not None else None
    headers = rpc_headers(app_id, app_secret)
    if idempotency_key is not None:
        headers["privy-idempotency-key"] = idempotency_key
    req = urllib.request.Request(
        f"{PRIVY_BASE}{path}",
        data=data,
        headers=headers,
        method=http_method,
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            payload: dict[str, Any] = json.load(r)
        return payload
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode(errors="replace")[:600]
        # Privy's error body does not echo our secret; still, never include request headers.
        raise PrivyError(f"Privy {http_method} {path} -> {exc.code}: {detail}") from None
    except urllib.error.URLError as exc:
        raise PrivyError(f"Privy {http_method} {path} failed: {exc.reason}") from None
