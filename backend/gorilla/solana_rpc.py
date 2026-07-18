"""Minimal Solana JSON-RPC transport — DEVNET-ONLY, key-redacting.

The on-chain wallet + settlement client talk to devnet through this thin client (stdlib
``urllib`` — the bottleneck is the network, not CPU). Two hard rules it enforces so the rest
of the package cannot violate them:

* **Devnet only.** The constructor refuses any URL that looks like mainnet. The whole
  Gorilla on-chain surface is devnet; a mainnet RPC is a bug, not a config.
* **The API key never leaks.** The Helius URL carries the key as a query param. It is held
  privately and NEVER placed in an exception, log line, or ``repr`` — errors reference
  "devnet RPC", never the URL. Redact before raising (project security rule).
"""

from __future__ import annotations

import base64
import json
import os
import time
import urllib.request
from pathlib import Path
from typing import Any


class RpcError(Exception):
    """A devnet RPC call failed. Never carries the RPC URL or the API key."""


def _redact(text: str) -> str:
    """Strip anything that looks like an ``api-key=...`` value from a string."""
    out = []
    for chunk in text.split():
        if "api-key" in chunk.lower():
            out.append("api-key=<redacted>")
        else:
            out.append(chunk)
    return " ".join(out)


def _env_file() -> Path:
    """The optional local ``.env`` fallback for creds not exported in the process env.
    Overridable with ``GORILLA_ENV_FILE``; defaults to a repo-local ``.env`` (gitignored)."""
    override = os.environ.get("GORILLA_ENV_FILE")
    if override:
        return Path(override).expanduser()
    return Path(__file__).resolve().parent.parent / ".env"


def helius_devnet_url() -> str:
    """Build the Helius devnet URL from ``HELIUS_API_KEY`` (env, or a local ``.env``).

    The key is read here and confined to the returned string, which only ever flows into a
    ``SolanaRpc`` (which keeps it private). Raises if no key is available."""
    key = os.environ.get("HELIUS_API_KEY")
    if not key:
        env = _env_file()
        if env.exists():
            for line in env.read_text().splitlines():
                line = line.strip()
                if line.startswith("HELIUS_API_KEY=") and not line.startswith("#"):
                    key = line.split("=", 1)[1].strip().strip('"').strip("'")
                    break
    if not key:
        raise RpcError("no HELIUS_API_KEY in env or local .env — cannot reach devnet")
    return f"https://devnet.helius-rpc.com/?api-key={key}"


# The public devnet endpoint — rate-limited but keyless, so the real on-chain path works with
# no credential at all. Still devnet, so the DEVNET-ONLY guard below is unaffected.
PUBLIC_DEVNET_URL = "https://api.devnet.solana.com"


def devnet_rpc_url() -> str:
    """The devnet RPC to use: Helius when a key is configured, else the public devnet endpoint.

    Falling back keyless matters because the on-chain path is now the DEFAULT operating mode —
    a missing Helius key must not be the thing that stops a real transaction from landing. Both
    branches are devnet; there is no configuration that yields a mainnet URL."""
    try:
        return helius_devnet_url()
    except RpcError:
        return PUBLIC_DEVNET_URL


class SolanaRpc:
    """A devnet JSON-RPC client. Simulate/send/read; devnet-guarded; key never leaks."""

    def __init__(self, url: str | None = None, *, timeout: int = 30) -> None:
        url = url or devnet_rpc_url()
        low = url.lower()
        if not low.startswith("https://"):
            raise RpcError("devnet RPC must be https")
        if "mainnet" in low or "api.mainnet" in low:
            raise RpcError("REFUSING: Gorilla is DEVNET-ONLY (RPC looks like mainnet)")
        self._url = url  # PRIVATE — never surfaced in errors/logs/repr.
        self._timeout = timeout

    def __repr__(self) -> str:  # never leak the url/key
        return "SolanaRpc(devnet)"

    def _call(self, method: str, params: list[Any]) -> Any:
        body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
        req = urllib.request.Request(
            self._url, data=body, headers={"Content-Type": "application/json"}
        )
        try:
            with urllib.request.urlopen(req, timeout=self._timeout) as r:
                payload = json.load(r)
        except Exception as exc:  # redact: the url (with key) can appear in urllib errors
            raise RpcError(f"{method} failed: {_redact(str(exc))}") from None
        if "error" in payload:
            raise RpcError(f"{method} rpc error: {_redact(json.dumps(payload['error']))}")
        return payload.get("result")

    # ── reads ────────────────────────────────────────────────────────────────
    def get_account_info(self, pubkey: str, *, data_slice: tuple[int, int] | None = None) -> Any:
        cfg: dict[str, Any] = {"encoding": "base64", "commitment": "confirmed"}
        if data_slice is not None:
            cfg["dataSlice"] = {"offset": data_slice[0], "length": data_slice[1]}
        return self._call("getAccountInfo", [pubkey, cfg])["value"]

    def get_account_data(self, pubkey: str) -> bytes | None:
        """Decoded account bytes, or ``None`` if the account does not exist."""
        val = self.get_account_info(pubkey)
        if not val or not val.get("data"):
            return None
        return base64.b64decode(val["data"][0])

    def get_balance(self, pubkey: str) -> int:
        # "confirmed" matches confirm(): a just-confirmed transfer must be visible immediately
        # (the finalized default lags and would read a stale pre-funding balance).
        return int(self._call("getBalance", [pubkey, {"commitment": "confirmed"}])["value"])

    def latest_blockhash(self) -> str:
        return self._call("getLatestBlockhash", [{"commitment": "finalized"}])["value"]["blockhash"]

    # ── simulate / send ────────────────────────────────────────────────────────
    def simulate(self, tx_b64: str) -> dict[str, Any]:
        """Simulate a signed tx (sigVerify off, blockhash replaced — no spend, no signer
        needed). Returns the ``value`` dict: ``err`` / ``logs`` / ``returnData``."""
        return self._call(
            "simulateTransaction",
            [
                tx_b64,
                {
                    "encoding": "base64",
                    "sigVerify": False,
                    "replaceRecentBlockhash": True,
                    "commitment": "confirmed",
                },
            ],
        )["value"]

    def send(self, tx_b64: str) -> str:
        # preflightCommitment "confirmed" so a tx depending on a just-confirmed account (a
        # freshly created market/position) isn't preflight-rejected against stale finalized
        # state (the default). The account is already confirmed by the time we send.
        return str(
            self._call(
                "sendTransaction",
                [tx_b64, {"encoding": "base64", "preflightCommitment": "confirmed"}],
            )
        )

    def confirm(
        self, signature: str, *, timeout_s: int = 45, commitment: str = "confirmed"
    ) -> dict[str, Any]:
        """Poll until the signature reaches ``commitment``. Returns the status dict; raises
        ``RpcError`` (with the on-chain error, e.g. a ``Custom`` code) if the tx failed.

        ``commitment="finalized"`` waits for the tx to be rooted cluster-wide — needed when a
        DIFFERENT RPC node must observe the result next (e.g. Privy preflight-simulates the next
        tx on its own node, which can lag a merely 'confirmed' account and revert 'not
        initialized')."""
        reached = ("finalized",) if commitment == "finalized" else ("confirmed", "finalized")
        deadline = time.time() + timeout_s
        while time.time() < deadline:
            st = self._call("getSignatureStatuses", [[signature]])["value"][0]
            if st is None:
                time.sleep(1)
                continue
            if st.get("err") is not None:
                raise RpcError(f"tx {signature} failed on-chain: {json.dumps(st['err'])}")
            if st.get("confirmationStatus") in reached:
                return st
            time.sleep(1)
        raise RpcError(f"tx {signature} not {commitment} within {timeout_s}s")
