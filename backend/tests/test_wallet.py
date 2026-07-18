"""Policy-gated wallet seam — the custody bound holds, offline and deterministic."""

from __future__ import annotations

import pytest

from gorilla.wallet import (
    Policy,
    PolicyViolation,
    SandboxWallet,
    SignResult,
    TxIntent,
    WalletSeam,
)

_POLICY = Policy(max_spend=50.0, allowed_purposes=frozenset({"place-bet"}))


def test_sandbox_wallet_satisfies_the_seam():
    assert isinstance(SandboxWallet(), WalletSeam)


def test_signs_within_policy_and_tracks_spend():
    w = SandboxWallet(funded_amount=100.0)
    w.authorize(_POLICY)
    res = w.sign_within_policy(TxIntent("place-bet", 20.0, "bet"))
    assert isinstance(res, SignResult)
    assert res.ref.startswith("sandbox:")
    assert w.funded() == 80.0


def test_no_policy_means_no_authority():
    w = SandboxWallet()
    with pytest.raises(PolicyViolation, match="no policy"):
        w.sign_within_policy(TxIntent("place-bet", 1.0, "x"))


def test_off_allowlist_purpose_is_refused():
    w = SandboxWallet()
    w.authorize(_POLICY)
    with pytest.raises(PolicyViolation, match="not in the authorized policy"):
        w.sign_within_policy(TxIntent("drain-wallet", 1.0, "off-purpose"))


def test_over_cap_is_refused_before_signing_and_spend_unchanged():
    w = SandboxWallet(funded_amount=100.0)
    w.authorize(_POLICY)
    w.sign_within_policy(TxIntent("place-bet", 40.0, "ok"))
    with pytest.raises(PolicyViolation, match="policy cap"):
        w.sign_within_policy(TxIntent("place-bet", 20.0, "over"))  # 40+20 > 50
    assert w.funded() == 60.0  # the refused tx never spent


def test_insufficient_funds_is_refused():
    w = SandboxWallet(funded_amount=5.0)
    w.authorize(Policy(max_spend=100.0, allowed_purposes=frozenset({"place-bet"})))
    with pytest.raises(PolicyViolation, match="insufficient"):
        w.sign_within_policy(TxIntent("place-bet", 10.0, "too big"))


def test_deterministic_ref_offline():
    a, b = SandboxWallet(), SandboxWallet()
    a.authorize(_POLICY)
    b.authorize(_POLICY)
    intent = TxIntent("place-bet", 5.0, "same")
    assert a.sign_within_policy(intent).ref == b.sign_within_policy(intent).ref
