"""The live staking path — the seam where a real signal becomes a real devnet transaction.

Light fakes only (an injected RPC + an ephemeral keypair); no network. The point of every test:
the custody bound holds BEFORE anything is signed, and a doomed stake is caught and named
rather than broadcast.
"""

from __future__ import annotations

import pytest
from solders.keypair import Keypair

from gorilla.agent import BET_PURPOSE
from gorilla.decision import BetIntent
from gorilla.forge_client import FORGE_PROGRAM_ID, market_pda, position_pda
from gorilla.settlement import CREATE_PURPOSE
from gorilla.staking import (
    LiveMarket,
    StakingError,
    chain_policy,
    ensure_market,
    stake_on_bet,
)
from gorilla.wallet import PolicyViolation
from gorilla.wallets import ChainPolicy, LocalDevnetWallet, describe_tx_error

FIXTURE_ID = 18257865
STAT_KEY = 1


class FakeRpc:
    """No-network stand-in for SolanaRpc. ``accounts`` maps pubkey -> account bytes."""

    def __init__(self, *, accounts: dict[str, bytes] | None = None, balance_sol: float = 9.0):
        self.accounts = accounts or {}
        self.balance = int(balance_sol * 1_000_000_000)
        self.sent: list[str] = []

    def get_account_data(self, pubkey: str) -> bytes | None:
        return self.accounts.get(pubkey)

    def get_balance(self, _pk: str) -> int:
        return self.balance

    def simulate(self, _tx: str) -> dict:
        return {"err": None, "logs": []}

    def latest_blockhash(self) -> str:
        return "11111111111111111111111111111111"

    def send(self, tx: str) -> str:
        self.sent.append(tx)
        return f"sig{len(self.sent)}"

    def confirm(self, sig: str, **_kw) -> dict:
        return {"confirmationStatus": "confirmed", "err": None}


def _wallet(rpc, *, cap_sol=0.05, purposes=frozenset({BET_PURPOSE, CREATE_PURPOSE})):
    wallet = LocalDevnetWallet(keypair=Keypair(), rpc=rpc)  # type: ignore[arg-type]
    wallet.authorize(chain_policy(cap_sol=cap_sol, purposes=purposes))
    return wallet


def _bet(amount=0.01, side="Yes"):
    return BetIntent(FIXTURE_ID, "OVERUNDER|line=2:over", side, amount, "a real sharp move")


# ── the policy the user authorizes ────────────────────────────────────────────────
def test_chain_policy_binds_each_purpose_to_a_program_and_instruction():
    policy = chain_policy(cap_sol=0.05, purposes=frozenset({BET_PURPOSE, CREATE_PURPOSE}))
    assert isinstance(policy, ChainPolicy)
    assert policy.max_spend == 0.05
    assert policy.bindings[BET_PURPOSE] == (str(FORGE_PROGRAM_ID), "stake")
    assert policy.bindings[CREATE_PURPOSE] == (str(FORGE_PROGRAM_ID), "create_market")


# ── market lifecycle ──────────────────────────────────────────────────────────────
def test_ensure_market_opens_an_absent_market():
    rpc = FakeRpc()
    wallet = _wallet(rpc)
    market = ensure_market(rpc=rpc, wallet=wallet, fixture_id=FIXTURE_ID, stat_key=STAT_KEY)
    expected, _ = market_pda(FIXTURE_ID, STAT_KEY)
    assert market.address == str(expected)
    assert market.create_sig is not None  # a real create transaction was sent
    assert len(rpc.sent) == 1


def test_ensure_market_is_idempotent_for_an_existing_open_market():
    """Watching the same fixture twice must reuse the market, not fail or double-create."""
    market_key, _ = market_pda(FIXTURE_ID, STAT_KEY)
    open_market = _market_bytes(state=0)
    rpc = FakeRpc(accounts={str(market_key): open_market})
    market = ensure_market(rpc=rpc, wallet=_wallet(rpc), fixture_id=FIXTURE_ID, stat_key=STAT_KEY)
    assert market.create_sig is None
    assert rpc.sent == []  # nothing broadcast


def test_ensure_market_refuses_a_settled_market():
    market_key, _ = market_pda(FIXTURE_ID, STAT_KEY)
    rpc = FakeRpc(accounts={str(market_key): _market_bytes(state=1)})
    with pytest.raises(StakingError, match="Settled"):
        ensure_market(rpc=rpc, wallet=_wallet(rpc), fixture_id=FIXTURE_ID, stat_key=STAT_KEY)


# ── staking ───────────────────────────────────────────────────────────────────────
def test_stake_on_bet_sends_a_real_stake_transaction():
    rpc = FakeRpc()
    wallet = _wallet(rpc)
    market = LiveMarket(FIXTURE_ID, STAT_KEY, "M", None)
    result = stake_on_bet(wallet=wallet, market=market, bet=_bet(), rpc=rpc)
    assert result.ref == "sig1"
    assert len(rpc.sent) == 1


def test_stake_over_the_cap_is_refused_before_anything_is_sent():
    """The custody bound: an over-cap stake never produces a signature and never broadcasts."""
    rpc = FakeRpc()
    wallet = _wallet(rpc, cap_sol=0.005)
    market = LiveMarket(FIXTURE_ID, STAT_KEY, "M", None)
    with pytest.raises(PolicyViolation, match="spend cap"):
        stake_on_bet(wallet=wallet, market=market, bet=_bet(amount=0.01), rpc=rpc)
    assert rpc.sent == []


def test_stake_off_the_allow_list_is_refused():
    """A wallet authorized only to create markets must not be able to stake."""
    rpc = FakeRpc()
    wallet = _wallet(rpc, purposes=frozenset({CREATE_PURPOSE}))
    market = LiveMarket(FIXTURE_ID, STAT_KEY, "M", None)
    with pytest.raises(PolicyViolation, match="not in the authorized policy"):
        stake_on_bet(wallet=wallet, market=market, bet=_bet(), rpc=rpc)
    assert rpc.sent == []


def test_existing_position_is_caught_before_broadcasting_a_doomed_stake():
    """forge_markets v1 uses ``init`` — one position per staker per market. A second stake is
    reported by its real reason instead of being broadcast to fail as ``AccountAlreadyInUse``."""
    rpc = FakeRpc()
    wallet = _wallet(rpc)
    market_key, _ = market_pda(FIXTURE_ID, STAT_KEY)
    position, _ = position_pda(market_key, wallet.pubkey)
    rpc.accounts[str(position)] = b"existing position"
    market = LiveMarket(FIXTURE_ID, STAT_KEY, str(market_key), None)
    with pytest.raises(StakingError, match="ONE stake per staker per market"):
        stake_on_bet(wallet=wallet, market=market, bet=_bet(), rpc=rpc)
    assert rpc.sent == []


def test_a_stake_rounding_to_zero_lamports_is_refused():
    rpc = FakeRpc()
    market = LiveMarket(FIXTURE_ID, STAT_KEY, "M", None)
    with pytest.raises(StakingError, match="zero lamports"):
        stake_on_bet(wallet=_wallet(rpc), market=market, bet=_bet(amount=0.0000000001), rpc=rpc)


# ── error naming (what turned a bare "custom 0" into the real reason) ─────────────
def test_low_custom_codes_are_named_as_system_program_errors():
    err = {"InstructionError": [0, {"Custom": 0}]}
    assert "AccountAlreadyInUse" in describe_tx_error(err)


def test_anchor_range_codes_still_name_the_program_error():
    err = {"InstructionError": [0, {"Custom": 6000}]}
    assert "MarketNotOpen" in describe_tx_error(err)


def _market_bytes(*, state: int) -> bytes:
    """A minimally valid ``Market`` account body for ``decode_market`` (8-byte disc + fields)."""
    from solders.pubkey import Pubkey

    body = (
        FIXTURE_ID.to_bytes(8, "little", signed=True)
        + STAT_KEY.to_bytes(4, "little")
        + (0).to_bytes(4, "little", signed=True)  # predicate threshold
        + bytes([0])  # comparison
        + bytes(Pubkey.default())  # vault
        + (0).to_bytes(8, "little")  # stake_yes
        + (0).to_bytes(8, "little")  # stake_no
        + bytes([state])  # 0 = Open, 1 = Settled
        + bytes([0])  # winner
    )
    return bytes(8) + body + bytes(16)
