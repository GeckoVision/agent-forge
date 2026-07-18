"""The DEVNET-ONLY guard — the hard boundary, pinned.

Gorilla must never be able to sign or broadcast a mainnet transaction. The guard that makes
that structural lives in :class:`SolanaRpc`'s constructor, so it is tested here directly: no
configuration, env var, or fallback may yield a mainnet RPC. Mainnet is founder-gated and is
not reachable from this codebase.
"""

from __future__ import annotations

import pytest

from gorilla.solana_rpc import (
    PUBLIC_DEVNET_URL,
    RpcError,
    SolanaRpc,
    devnet_rpc_url,
    helius_devnet_url,
)


@pytest.mark.parametrize(
    "url",
    [
        "https://api.mainnet-beta.solana.com",
        "https://mainnet.helius-rpc.com/?api-key=abc",
        "https://MAINNET.example.com",
        "https://api.mainnet.solana.com",
    ],
)
def test_mainnet_urls_are_refused(url):
    with pytest.raises(RpcError, match="DEVNET-ONLY"):
        SolanaRpc(url)


def test_non_https_is_refused():
    with pytest.raises(RpcError, match="https"):
        SolanaRpc("http://api.devnet.solana.com")


def test_devnet_urls_are_accepted():
    assert repr(SolanaRpc(PUBLIC_DEVNET_URL)) == "SolanaRpc(devnet)"
    assert repr(SolanaRpc("https://devnet.helius-rpc.com/?api-key=k")) == "SolanaRpc(devnet)"


def test_repr_never_leaks_the_url_or_key():
    """The Helius key rides in the URL — it must not reach a log line or traceback."""
    rpc = SolanaRpc("https://devnet.helius-rpc.com/?api-key=supersecret")
    assert "supersecret" not in repr(rpc)


def test_devnet_url_falls_back_to_the_public_endpoint_without_a_key(monkeypatch, tmp_path):
    """The real on-chain path is the DEFAULT mode now, so a missing Helius key must not be what
    stops a transaction landing. The fallback is still devnet."""
    monkeypatch.delenv("HELIUS_API_KEY", raising=False)
    monkeypatch.setenv("GORILLA_ENV_FILE", str(tmp_path / "absent.env"))
    assert devnet_rpc_url() == PUBLIC_DEVNET_URL
    # And the guard still holds on the fallback.
    assert repr(SolanaRpc(devnet_rpc_url())) == "SolanaRpc(devnet)"


def test_devnet_url_prefers_helius_when_a_key_is_present(monkeypatch):
    monkeypatch.setenv("HELIUS_API_KEY", "k123")
    assert devnet_rpc_url() == helius_devnet_url()
    assert "devnet.helius-rpc.com" in devnet_rpc_url()


def test_helius_url_raises_without_a_key(monkeypatch, tmp_path):
    monkeypatch.delenv("HELIUS_API_KEY", raising=False)
    monkeypatch.setenv("GORILLA_ENV_FILE", str(tmp_path / "absent.env"))
    with pytest.raises(RpcError, match="no HELIUS_API_KEY"):
        helius_devnet_url()
