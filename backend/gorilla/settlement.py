"""The on-chain settlement loop — the trustless-settlement demo, end to end on devnet.

One integration path, wired to the deployed ``forge_markets`` program: open a market whose
YES predicate HOLDS for a REAL recorded TxODDS proof, have the agent detect a sharp move and
stake YES through a policy-gated wallet, let a counterparty stake NO (funding the pot), settle
by submitting the recorded proof (a CPI into the real devnet oracle), then route the winner's
claim from the on-chain ``Market.winner`` the oracle certified.

The settle step is the whole thesis: this program never decides the outcome — the oracle does,
and a tampered proof reverts. Settle is pre-SIMULATED (no signature, no spend) so a doomed
settle never broadcasts and the oracle's on-wire return bytes are captured; a live settle that
lands with ``winner = Yes`` CONFIRMS the one open assumption (the oracle returns ``Ok(bool)``
as Anchor return-data that the program's 1-byte decoder reads). If the encoding ever differed,
settle fails CLOSED (funds safe) and the captured bytes are reported for reconciliation.

Logic lives here (the package); ``scripts/e2e_settlement.py`` is a thin CLI over it.
DEVNET-ONLY.
"""

from __future__ import annotations

import base64
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from solders.hash import Hash
from solders.message import Message
from solders.pubkey import Pubkey
from solders.transaction import Transaction

from .agent import BET_PURPOSE, to_tx_intent
from .decision import BetIntent, RiskPolicy, Side, decide
from .detector import SharpDetector
from .forge_client import (
    FORGE_PROGRAM_ID,
    claim_tx,
    create_market_tx,
    decode_market,
    market_pda,
    proof_period,
    settle_tx,
    stake_tx,
    to_lamports,
    vault_pda,
    winning_predicate,
)
from .solana_rpc import SolanaRpc
from .txline_feed import replay
from .wallet import TxIntent
from .wallets import ChainWallet, describe_tx_error

# Purpose vocabulary (allow-list keys). BET_PURPOSE ("place-bet") is reused from the agent.
CREATE_PURPOSE = "create-market"
SETTLE_PURPOSE = "settle"
CLAIM_PURPOSE = "claim"

# purpose -> (program_id, instruction) the on-chain wallets bind. A ChainPolicy authorizes a
# SUBSET of these (a staker never gets "settle"; the funder never needs "place-bet").
FORGE_BINDINGS: dict[str, tuple[str, str]] = {
    CREATE_PURPOSE: (str(FORGE_PROGRAM_ID), "create_market"),
    BET_PURPOSE: (str(FORGE_PROGRAM_ID), "stake"),
    SETTLE_PURPOSE: (str(FORGE_PROGRAM_ID), "settle"),
    CLAIM_PURPOSE: (str(FORGE_PROGRAM_ID), "claim"),
}


class SettlementError(Exception):
    """The on-chain settlement loop could not complete (settle would revert, no winner, ...)."""


def _explorer(sig: str) -> str:
    return f"https://explorer.solana.com/tx/{sig}?cluster=devnet"


@dataclass(frozen=True)
class SettlementResult:
    """Every signature the loop produced + the settled outcome — the demo's proof object."""

    market: str
    vault: str
    fixture_id: int
    stat_key: int
    create_sig: str
    stake_yes_sig: str
    stake_no_sig: str
    settle_sig: str
    claim_sig: str
    winner: Side
    state: str
    stake_yes: int
    stake_no: int
    settle_return_data: str | None  # base64 the oracle returned in the settle simulation

    def explorer_links(self) -> dict[str, str]:
        return {
            "create_market": _explorer(self.create_sig),
            "stake_yes": _explorer(self.stake_yes_sig),
            "stake_no": _explorer(self.stake_no_sig),
            "settle": _explorer(self.settle_sig),
            "claim": _explorer(self.claim_sig),
        }


def detect_yes_bet(fixture_id: int, stake_sol: float) -> tuple[BetIntent, str]:
    """The agent's role: replay a moving market, detect THE sharp move, size a bet within a
    (devnet-SOL-scaled) risk policy. The scripted move is an up-move -> side ``Yes``. Returns
    the bet + a human rationale. Deterministic, offline."""
    detector = SharpDetector(threshold_pct=3.0)
    risk = RiskPolicy(max_stake=stake_sol, max_per_fixture=stake_sol)
    for snap in replay(fixture_id=fixture_id, move_at=3):
        move = detector.observe(snap)
        if move is None:
            continue
        bet = decide(move, risk)
        if bet is not None:
            return bet, move.summary()
    raise SettlementError("no sharp move detected in the replay — cannot place a bet")


def _simulate_settle(rpc: SolanaRpc, payer: Pubkey, instructions: list[Any]) -> dict[str, Any]:
    """Simulate the settle tx UNSIGNED (sigVerify off, blockhash replaced) — no key, no spend.
    Surfaces the oracle's return-data + logs before we ever broadcast."""
    msg = Message.new_with_blockhash(instructions, payer, Hash.default())
    tx = Transaction.new_unsigned(msg)
    return rpc.simulate(base64.b64encode(bytes(tx)).decode())


def _return_data_b64(sim: dict[str, Any]) -> str | None:
    rd = sim.get("returnData")
    if rd and rd.get("data"):
        return str(rd["data"][0])
    return None


def run_settlement(
    *,
    rpc: SolanaRpc,
    funder: ChainWallet,
    staker_yes: ChainWallet,
    staker_no: ChainWallet,
    fixture_id: int,
    stat_key: int,
    proof: dict[str, Any],
    yes_sol: float,
    no_sol: float,
    log: Callable[[str], None] = print,
) -> SettlementResult:
    """Run the full loop. The three wallets must already be authorized with a ``ChainPolicy``
    granting exactly the purposes each performs (funder: create-market + settle; stakers:
    place-bet + claim). Raises :class:`SettlementError` if settle would revert (funds safe)."""
    market, _ = market_pda(fixture_id, stat_key)
    vault, _ = vault_pda(market)
    predicate = winning_predicate(proof)
    # Bind the market to the proof's period so the honest settle passes the F1 check.
    period = proof_period(proof)

    if rpc.get_account_data(str(market)) is not None:
        raise SettlementError(
            f"market {market} already exists (fixture {fixture_id}, stat {stat_key}); "
            "use a fresh nonce for a repeatable demo"
        )

    # 1 · open the market (the funder is the authority) with a predicate that HOLDS
    #     and the proof's period (so settle's F1 period-binding matches).
    # lock_ts = 0 (no betting cutoff): this is the recorded-proof demo loop over a
    # synthetic nonce'd fixture, so a kickoff cutoff is not meaningful here. A real
    # upcoming-fixture market sets a non-zero lock_ts (see stake.rs / create_market).
    create = create_market_tx(fixture_id, stat_key, predicate, period, 0, funder.pubkey)
    create_sig = funder.sign_within_policy(
        TxIntent(CREATE_PURPOSE, 0.0, f"open market {fixture_id}/{stat_key}", unsigned_tx=create)
    ).ref
    log(
        f"1 · create_market  {market}  (predicate: stat > {predicate.threshold})  {_explorer(create_sig)}"
    )

    # 2 · the agent detects a sharp move and stakes YES through its policy-gated wallet.
    bet, rationale = detect_yes_bet(fixture_id, yes_sol)
    st_yes = stake_tx(fixture_id, stat_key, staker_yes.pubkey, bet.side, to_lamports(yes_sol))
    stake_yes_sig = staker_yes.sign_within_policy(to_tx_intent(bet, unsigned_tx=st_yes)).ref
    log(f"2 · agent bets {bet.side} {yes_sol:g} SOL  ({rationale})  {_explorer(stake_yes_sig)}")

    # 3 · a counterparty stakes NO — funding the two-sided pot.
    st_no = stake_tx(fixture_id, stat_key, staker_no.pubkey, "No", to_lamports(no_sol))
    stake_no_sig = staker_no.sign_within_policy(
        TxIntent(BET_PURPOSE, no_sol, "counterparty stakes No", unsigned_tx=st_no)
    ).ref
    log(f"3 · counterparty bets No {no_sol:g} SOL  {_explorer(stake_no_sig)}")

    # 4 · settle — CPI the REAL oracle with the recorded proof. Pre-simulate to capture the
    #     oracle's return bytes and to never broadcast a doomed settle.
    settle = settle_tx(fixture_id, stat_key, proof)
    sim = _simulate_settle(rpc, funder.pubkey, list(settle.instructions))
    return_data = _return_data_b64(sim)
    if sim.get("err") is not None:
        raise SettlementError(
            f"settle would revert (fail-closed, funds safe): {describe_tx_error(sim['err'])} · "
            f"oracle returnData(b64)={return_data} · logs={sim.get('logs')}"
        )
    settle_sig = funder.sign_within_policy(
        TxIntent(SETTLE_PURPOSE, 0.0, "settle via txoracle proof", unsigned_tx=settle)
    ).ref
    log(
        f"4 · settle via real txoracle proof  returnData(b64)={return_data}  {_explorer(settle_sig)}"
    )

    # 5 · read the outcome the oracle certified and route the claim to the winning side.
    data = rpc.get_account_data(str(market))
    if data is None:
        raise SettlementError("market vanished after settle")
    m = decode_market(data)
    if m.state != "Settled":
        raise SettlementError(f"market did not settle (state={m.state})")
    winner_wallet = staker_yes if m.winner == "Yes" else staker_no
    claim = claim_tx(fixture_id, stat_key, winner_wallet.pubkey)
    claim_sig = winner_wallet.sign_within_policy(
        TxIntent(CLAIM_PURPOSE, 0.0, f"{m.winner} winner claims the pot", unsigned_tx=claim)
    ).ref
    log(
        f"5 · winner={m.winner} claims pot ({(m.stake_yes + m.stake_no) / 1e9:g} SOL)  {_explorer(claim_sig)}"
    )

    return SettlementResult(
        market=str(market),
        vault=str(vault),
        fixture_id=fixture_id,
        stat_key=stat_key,
        create_sig=create_sig,
        stake_yes_sig=stake_yes_sig,
        stake_no_sig=stake_no_sig,
        settle_sig=settle_sig,
        claim_sig=claim_sig,
        winner=m.winner,
        state=m.state,
        stake_yes=m.stake_yes,
        stake_no=m.stake_no,
        settle_return_data=return_data,
    )
