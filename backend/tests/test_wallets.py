"""On-chain wallets — the custody bound holds offline, with a fake transport.

Light fakes only (an injected RPC / Privy transport + an ephemeral keypair); no network, no
mocks. The point of every test: a refused intent NEVER produces a signature and NEVER reaches
the wire. The simulate-then-send gate and the allow-list are exercised without devnet.
"""

from __future__ import annotations

import base64

import pytest
from solders.hash import Hash
from solders.instruction import Instruction
from solders.keypair import Keypair
from solders.pubkey import Pubkey
from solders.transaction import Transaction

from gorilla.forge_client import (
    COMPUTE_BUDGET_ID,
    FORGE_PROGRAM_ID,
    SYSTEM_PROGRAM_ID,
    UnsignedTx,
    claim_tx,
    stake_tx,
    to_lamports,
    with_priority_fee,
)
from gorilla.privy_http import (
    DEFAULT_PRIVY_WALLET_ADDRESS,
    DEFAULT_PRIVY_WALLET_ID,
    PRIVY_USER_AGENT,
    rpc_headers,
)
from gorilla.wallet import Policy, PolicyViolation, SignResult, TxIntent, WalletSeam
from gorilla.wallets import (
    ChainPolicy,
    LocalDevnetWallet,
    OnChainError,
    PrivyNotConfigured,
    PrivyWallet,
)

FIXTURE_ID = 18179549
STAT_KEY = 1
_FORGE = str(FORGE_PROGRAM_ID)


class FakeRpc:
    """A no-network stand-in for SolanaRpc. Records what it was asked to simulate/send so a
    test can assert a refusal never broadcast."""

    def __init__(self, *, balance_lamports: int = 1_000_000_000, sim_err: object = None) -> None:
        self.balance = balance_lamports
        self.sim_err = sim_err
        self.simulated: list[str] = []
        self.sent: list[str] = []
        self.confirmed: list[tuple[str, str]] = []

    def get_balance(self, _pk: str) -> int:
        return self.balance

    def simulate(self, tx_b64: str) -> dict:
        self.simulated.append(tx_b64)
        return {"err": self.sim_err, "logs": [], "returnData": None}

    def latest_blockhash(self) -> str:
        return str(Hash.default())

    def send(self, tx_b64: str) -> str:
        self.sent.append(tx_b64)
        return "FAKESIG1111111111111111111111111111111111111"

    def confirm(self, _sig: str, *, timeout_s: int = 45, commitment: str = "confirmed") -> dict:
        self.confirmed.append((_sig, commitment))
        return {"confirmationStatus": commitment}


def _chain_policy(*, cap: float = 1.0) -> ChainPolicy:
    return ChainPolicy(
        max_spend=cap,
        allowed_purposes=frozenset({"place-bet", "claim"}),
        bindings={
            "place-bet": (_FORGE, "stake"),
            "claim": (_FORGE, "claim"),
        },
    )


def _stake_intent(wallet_pubkey: Pubkey, *, sol: float = 0.01) -> TxIntent:
    tx = stake_tx(FIXTURE_ID, STAT_KEY, wallet_pubkey, "Yes", to_lamports(sol))
    return TxIntent("place-bet", sol, "stake YES", unsigned_tx=tx)


# ── seam conformance ────────────────────────────────────────────────────────────────
def test_local_wallet_satisfies_the_seam():
    w = LocalDevnetWallet(keypair=Keypair(), rpc=FakeRpc())  # type: ignore[arg-type]
    assert isinstance(w, WalletSeam)


def test_privy_wallet_satisfies_the_seam():
    w = PrivyWallet(wallet_id="w", address=Pubkey.default(), rpc=FakeRpc())  # type: ignore[arg-type]
    assert isinstance(w, WalletSeam)


# ── LocalDevnetWallet: in-policy signs + sends ──────────────────────────────────────
def test_in_policy_stake_simulates_then_sends():
    rpc = FakeRpc()
    w = LocalDevnetWallet(keypair=Keypair(), rpc=rpc)  # type: ignore[arg-type]
    w.authorize(_chain_policy())
    res = w.sign_within_policy(_stake_intent(w.pubkey))
    assert isinstance(res, SignResult)
    assert res.ref.startswith("FAKESIG")
    assert len(rpc.simulated) == 1  # simulated before broadcast
    assert len(rpc.sent) == 1
    assert w._spent == 0.01


def test_second_bet_accumulates_against_the_cap():
    rpc = FakeRpc()
    w = LocalDevnetWallet(keypair=Keypair(), rpc=rpc)  # type: ignore[arg-type]
    w.authorize(_chain_policy(cap=0.015))
    w.sign_within_policy(_stake_intent(w.pubkey, sol=0.01))
    with pytest.raises(PolicyViolation, match="cap"):
        w.sign_within_policy(_stake_intent(w.pubkey, sol=0.01))  # 0.02 > 0.015
    assert len(rpc.sent) == 1  # the refused second bet never broadcast


# ── LocalDevnetWallet: every refusal path never reaches the wire ────────────────────
def test_no_policy_refuses():
    rpc = FakeRpc()
    w = LocalDevnetWallet(keypair=Keypair(), rpc=rpc)  # type: ignore[arg-type]
    with pytest.raises(PolicyViolation, match="no policy"):
        w.sign_within_policy(_stake_intent(w.pubkey))
    assert not rpc.sent and not rpc.simulated


def test_missing_unsigned_tx_refuses():
    rpc = FakeRpc()
    w = LocalDevnetWallet(keypair=Keypair(), rpc=rpc)  # type: ignore[arg-type]
    w.authorize(_chain_policy())
    with pytest.raises(PolicyViolation, match="built transaction"):
        w.sign_within_policy(TxIntent("place-bet", 0.01, "no tx"))
    assert not rpc.sent


def test_off_allowlist_purpose_refuses():
    rpc = FakeRpc()
    w = LocalDevnetWallet(keypair=Keypair(), rpc=rpc)  # type: ignore[arg-type]
    w.authorize(_chain_policy())
    tx = stake_tx(FIXTURE_ID, STAT_KEY, w.pubkey, "Yes", to_lamports(0.01))
    with pytest.raises(PolicyViolation, match="not in the authorized policy"):
        w.sign_within_policy(TxIntent("drain-wallet", 0.01, "off-purpose", unsigned_tx=tx))
    assert not rpc.sent


def test_over_cap_refuses_before_signing():
    rpc = FakeRpc()
    w = LocalDevnetWallet(keypair=Keypair(), rpc=rpc)  # type: ignore[arg-type]
    w.authorize(_chain_policy(cap=0.005))
    with pytest.raises(PolicyViolation, match="cap"):
        w.sign_within_policy(_stake_intent(w.pubkey, sol=0.01))
    assert not rpc.sent


def test_insufficient_funds_refuses():
    rpc = FakeRpc(balance_lamports=1_000)  # ~0 SOL
    w = LocalDevnetWallet(keypair=Keypair(), rpc=rpc)  # type: ignore[arg-type]
    w.authorize(_chain_policy())
    with pytest.raises(PolicyViolation, match="insufficient"):
        w.sign_within_policy(_stake_intent(w.pubkey, sol=0.01))
    assert not rpc.sent


def test_binding_mismatch_refuses_off_allowlist():
    """A whitelisted purpose bound to claim cannot be used to sign a stake tx."""
    rpc = FakeRpc()
    w = LocalDevnetWallet(keypair=Keypair(), rpc=rpc)  # type: ignore[arg-type]
    w.authorize(
        ChainPolicy(
            max_spend=1.0,
            allowed_purposes=frozenset({"place-bet"}),
            bindings={"place-bet": (_FORGE, "claim")},  # bound to claim, not stake
        )
    )
    with pytest.raises(PolicyViolation, match="off-allow-list"):
        w.sign_within_policy(_stake_intent(w.pubkey))
    assert not rpc.sent


def test_smuggled_discriminator_refuses():
    """An UnsignedTx tagged 'stake' whose bytes are not a stake call is refused."""
    rpc = FakeRpc()
    w = LocalDevnetWallet(keypair=Keypair(), rpc=rpc)  # type: ignore[arg-type]
    w.authorize(_chain_policy())
    bogus = UnsignedTx((Instruction(FORGE_PROGRAM_ID, b"\x00" * 8, []),), FORGE_PROGRAM_ID, "stake")
    with pytest.raises(PolicyViolation, match="discriminator"):
        w.sign_within_policy(TxIntent("place-bet", 0.01, "bogus", unsigned_tx=bogus))
    assert not rpc.sent


def test_tx_requiring_another_signer_refuses():
    """A stake tx built for a DIFFERENT staker needs a key this wallet does not hold."""
    rpc = FakeRpc()
    w = LocalDevnetWallet(keypair=Keypair(), rpc=rpc)  # type: ignore[arg-type]
    w.authorize(_chain_policy())
    other = Keypair().pubkey()
    tx = stake_tx(FIXTURE_ID, STAT_KEY, other, "Yes", to_lamports(0.01))
    with pytest.raises(PolicyViolation, match="does not hold"):
        w.sign_within_policy(TxIntent("place-bet", 0.01, "wrong signer", unsigned_tx=tx))
    assert not rpc.sent


def test_plain_policy_has_no_binding_and_fails_closed():
    rpc = FakeRpc()
    w = LocalDevnetWallet(keypair=Keypair(), rpc=rpc)  # type: ignore[arg-type]
    w.authorize(Policy(max_spend=1.0, allowed_purposes=frozenset({"place-bet"})))
    with pytest.raises(PolicyViolation, match="no program binding"):
        w.sign_within_policy(_stake_intent(w.pubkey))
    assert not rpc.sent


def test_failed_simulation_never_broadcasts():
    rpc = FakeRpc(sim_err={"InstructionError": [1, {"Custom": 6010}]})
    w = LocalDevnetWallet(keypair=Keypair(), rpc=rpc)  # type: ignore[arg-type]
    w.authorize(_chain_policy())
    with pytest.raises(OnChainError, match="OracleBadReturnData"):
        w.sign_within_policy(_stake_intent(w.pubkey))
    assert len(rpc.simulated) == 1
    assert not rpc.sent  # doomed tx never left the process


def test_claim_intent_binds_to_claim():
    rpc = FakeRpc()
    w = LocalDevnetWallet(keypair=Keypair(), rpc=rpc)  # type: ignore[arg-type]
    w.authorize(_chain_policy())
    tx = claim_tx(FIXTURE_ID, STAT_KEY, w.pubkey)
    res = w.sign_within_policy(TxIntent("claim", 0.0, "claim pot", unsigned_tx=tx))
    assert res.ref.startswith("FAKESIG")
    assert len(rpc.sent) == 1


# ── PrivyWallet: policy is enforced BEFORE Privy is ever called ─────────────────────
class FakePrivyTransport:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict]] = []

    def __call__(self, wallet_id: str, body: dict) -> dict:
        self.calls.append((wallet_id, body))
        return {"data": {"hash": "PRIVYSIG222222222222222222222222222222222222"}}


def test_privy_in_policy_signs_via_transport():
    rpc = FakeRpc()
    transport = FakePrivyTransport()
    w = PrivyWallet(
        wallet_id="wallet-1",
        address=Keypair().pubkey(),
        rpc=rpc,  # type: ignore[arg-type]
        app_id="app",
        app_secret="secret",
        transport=transport,
    )
    w.authorize(_chain_policy())
    res = w.sign_within_policy(_stake_intent(w.pubkey))
    assert res.ref.startswith("PRIVYSIG")
    assert len(transport.calls) == 1
    _wid, body = transport.calls[0]
    assert body["method"] == "signAndSendTransaction"
    assert body["caip2"].startswith("solana:")
    # confirmed to FINALIZED (cross-RPC race guard: Privy preflights the next tx on its own node).
    assert rpc.confirmed == [(res.ref, "finalized")]


def test_privy_over_cap_never_calls_privy():
    transport = FakePrivyTransport()
    w = PrivyWallet(
        wallet_id="wallet-1",
        address=Keypair().pubkey(),
        rpc=FakeRpc(),  # type: ignore[arg-type]
        app_id="app",
        app_secret="secret",
        transport=transport,
    )
    w.authorize(_chain_policy(cap=0.005))
    with pytest.raises(PolicyViolation, match="cap"):
        w.sign_within_policy(_stake_intent(w.pubkey, sol=0.01))
    assert transport.calls == []  # a refusal never reaches Privy


def test_privy_off_allowlist_never_calls_privy():
    transport = FakePrivyTransport()
    w = PrivyWallet(
        wallet_id="wallet-1",
        address=Keypair().pubkey(),
        rpc=FakeRpc(),  # type: ignore[arg-type]
        app_id="app",
        app_secret="secret",
        transport=transport,
    )
    w.authorize(_chain_policy())
    tx = stake_tx(FIXTURE_ID, STAT_KEY, w.pubkey, "Yes", to_lamports(0.01))
    with pytest.raises(PolicyViolation, match="not in the authorized policy"):
        w.sign_within_policy(TxIntent("drain-wallet", 0.01, "off", unsigned_tx=tx))
    assert transport.calls == []


def test_privy_not_configured_raises_with_founder_steps():
    w = PrivyWallet(wallet_id="", address=Keypair().pubkey(), rpc=FakeRpc())  # type: ignore[arg-type]
    w.authorize(_chain_policy())
    with pytest.raises(PrivyNotConfigured, match="forge_markets"):
        w.sign_within_policy(_stake_intent(w.pubkey))


# ── the Cloudflare fix is offline-falsifiable (Pattern B) ──────────────────────────
def test_rpc_headers_carry_a_real_user_agent_not_the_banned_urllib_default():
    """Privy is behind Cloudflare, which 403-bans ``Python-urllib/*``. Guard the header so the
    live sign path is never shadow-banned (the 'stubbed-but-shipped fails live' trap)."""
    h = rpc_headers("app", "secret")
    assert h["User-Agent"] == PRIVY_USER_AGENT
    assert not h["User-Agent"].lower().startswith("python-urllib")
    assert h["privy-app-id"] == "app"
    assert h["Authorization"].startswith("Basic ")
    # the secret is Basic-encoded, never in the clear.
    assert "secret" not in h["Authorization"]


# ── from_env wiring: the provisioned devnet wallet behind the seam ─────────────────
def test_from_env_wires_the_provisioned_wallet(monkeypatch):
    monkeypatch.setattr("gorilla.wallets.privy_creds", lambda: ("app-id", "app-secret"))
    monkeypatch.setattr(
        "gorilla.wallets.privy_wallet_config",
        lambda: (DEFAULT_PRIVY_WALLET_ID, DEFAULT_PRIVY_WALLET_ADDRESS),
    )
    w = PrivyWallet.from_env(FakeRpc())  # type: ignore[arg-type]
    assert isinstance(w, WalletSeam)
    assert w.wallet_id == DEFAULT_PRIVY_WALLET_ID
    assert str(w.address) == DEFAULT_PRIVY_WALLET_ADDRESS
    assert w.app_id == "app-id" and w.app_secret == "app-secret"


def test_from_env_without_creds_raises_founder_steps(monkeypatch):
    monkeypatch.setattr("gorilla.wallets.privy_creds", lambda: (None, None))
    with pytest.raises(PrivyNotConfigured, match="forge_markets"):
        PrivyWallet.from_env(FakeRpc())  # type: ignore[arg-type]


# ── test-sign (enclave-path smoke) builds a 0-lamport System self-transfer ─────────
def test_test_sign_self_transfer_builds_zero_lamport_self_transfer():
    rpc = FakeRpc()
    transport = FakePrivyTransport()
    addr = Keypair().pubkey()
    w = PrivyWallet(
        wallet_id="wallet-1",
        address=addr,
        rpc=rpc,  # type: ignore[arg-type]
        app_id="app",
        app_secret="secret",
        transport=transport,
    )
    sig = w.test_sign_self_transfer()  # default 0 lamports
    assert sig.startswith("PRIVYSIG")
    assert len(transport.calls) == 1
    _wid, body = transport.calls[0]
    assert body["method"] == "signAndSendTransaction"
    assert body["caip2"] == "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"  # devnet
    assert body["params"]["encoding"] == "base64"

    # decode the UNSIGNED tx: one System-Program transfer, self->self, 0 lamports.
    tx = Transaction.from_bytes(base64.b64decode(body["params"]["transaction"]))
    msg = tx.message
    assert len(msg.instructions) == 1
    ci = msg.instructions[0]
    assert msg.account_keys[ci.program_id_index] == SYSTEM_PROGRAM_ID
    assert bytes(ci.data) == bytes([2, 0, 0, 0]) + (0).to_bytes(8, "little")
    assert msg.account_keys[0] == addr  # fee payer is the Privy wallet


def test_test_sign_self_transfer_encodes_nonzero_lamports():
    transport = FakePrivyTransport()
    w = PrivyWallet(
        wallet_id="w",
        address=Keypair().pubkey(),
        rpc=FakeRpc(),  # type: ignore[arg-type]
        app_id="app",
        app_secret="secret",
        transport=transport,
    )
    w.test_sign_self_transfer(lamports=1234)
    _wid, body = transport.calls[0]
    tx = Transaction.from_bytes(base64.b64decode(body["params"]["transaction"]))
    ci = tx.message.instructions[0]
    assert int.from_bytes(bytes(ci.data)[4:12], "little") == 1234


# ── mainnet params: fresh blockhash on broadcast + a priority-fee prelude signs cleanly ──
def test_broadcast_uses_a_fresh_blockhash_not_the_simulation_default():
    """The pre-send SIMULATION runs on Hash.default() (the RPC replaces the blockhash), but the
    BROADCAST must carry the freshly fetched blockhash — else a mainnet send is 'blockhash not
    found'. Assert the sent tx uses the RPC's latest and the sim used the default."""
    fresh = Hash.from_string(str(Keypair().pubkey()))  # any valid, non-default 32-byte hash

    class FreshRpc(FakeRpc):
        def latest_blockhash(self) -> str:
            return str(fresh)

    rpc = FreshRpc()
    w = LocalDevnetWallet(keypair=Keypair(), rpc=rpc)  # type: ignore[arg-type]
    w.authorize(_chain_policy())
    w.sign_within_policy(_stake_intent(w.pubkey))
    sent = Transaction.from_bytes(base64.b64decode(rpc.sent[0]))
    assert sent.message.recent_blockhash == fresh
    assert sent.message.recent_blockhash != Hash.default()
    simulated = Transaction.from_bytes(base64.b64decode(rpc.simulated[0]))
    assert simulated.message.recent_blockhash == Hash.default()


def test_priority_fee_prelude_still_signs_within_policy():
    """A mainnet ComputeBudget priority-fee prelude must not trip the allow-list — the wallet
    still signs a stake that carries it, and only the stake reaches forge_markets."""
    rpc = FakeRpc()
    w = LocalDevnetWallet(keypair=Keypair(), rpc=rpc)  # type: ignore[arg-type]
    w.authorize(_chain_policy())
    tx = with_priority_fee(
        stake_tx(FIXTURE_ID, STAT_KEY, w.pubkey, "Yes", to_lamports(0.01)), 50_000
    )
    res = w.sign_within_policy(TxIntent("place-bet", 0.01, "stake + priority fee", unsigned_tx=tx))
    assert res.ref.startswith("FAKESIG")
    sent = Transaction.from_bytes(base64.b64decode(rpc.sent[0]))
    assert len(sent.message.instructions) == 2  # [SetComputeUnitPrice, stake]
    programs = {sent.message.account_keys[ci.program_id_index] for ci in sent.message.instructions}
    assert programs == {COMPUTE_BUDGET_ID, FORGE_PROGRAM_ID}
