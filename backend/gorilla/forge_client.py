"""forge_markets on-chain client — build the four instructions, first-call-correct.

Turns an intent (open a market, stake a side, settle with a proof, claim) into the EXACT
``forge_markets`` instruction the deployed devnet program expects: right 8-byte Anchor
discriminator, right account metas (order + signer/writable flags), right Borsh args, right
PDA derivations. The program (``program/programs/forge-markets``) is frozen; this module
mirrors its wire format as DATA, the same duplication pattern the Rust test crate uses.

Nothing here signs or sends — it only *builds*. The policy-gated wallet
(:mod:`gorilla.wallets`) signs an :class:`UnsignedTx`; :mod:`gorilla.solana_rpc` moves
bytes. Keeping build/sign/send separate is what lets the whole thing be falsified offline.

The settle path carries the probe's hard-won fixes:
  * ``ts`` is ``summary.updateStats.minTimestamp`` (the oracle's daily-root seed), NOT the
    proof's top-level ``ts`` (else error 6010 TimestampMismatch inside the oracle);
  * the ``daily_scores_roots`` PDA is derived from that same ``minTimestamp``;
  * a ComputeBudget ``SetComputeUnitLimit`` prelude (~350k) — the ``validate_stat`` CPI
    burns ~205k;
  * settle carries NO predicate (the program injects the market's stored predicate into the
    CPI — the caller cannot override the condition being proven).
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from enum import IntEnum
from pathlib import Path
from typing import Any

from solders.instruction import AccountMeta, Instruction
from solders.pubkey import Pubkey

from .decision import Side

# ── program identities (frozen; verified deployed + executable on devnet) ────────
FORGE_PROGRAM_ID = Pubkey.from_string("7Pvo6SEh1zBa1Euvj5QQ4td9GpfsQosTpxhqwWtWUFt6")
# txoracle CPI target — devnet by default. A mainnet settle build sets
# GORILLA_TXORACLE_ID to the TxODDS mainnet oracle
# (9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA — verified live + fed, its validate_stat
# confirmed byte-compatible via a Surfpool mainnet-fork profile), which flips BOTH the CPI
# target AND the daily_scores_roots PDA derivation so the SAME builder produces a
# mainnet-correct settle. Devnet default keeps every existing test + the demo unchanged.
DEVNET_TXORACLE_ID = "6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J"
MAINNET_TXORACLE_ID = "9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA"
TXORACLE_PROGRAM_ID = Pubkey.from_string(os.environ.get("GORILLA_TXORACLE_ID", DEVNET_TXORACLE_ID))
# settlement-core ENGINE program — settle now CPIs its `resolve` (settle.rs pins this by
# address = settlement_core::ID, so a caller can't redirect the CPI to a look-alike). Single
# deployment (one declare_id! for devnet + mainnet), unlike the oracle; env-overridable to
# mirror TXORACLE_PROGRAM_ID and keep a mainnet build a pure-config change.
SETTLEMENT_ENGINE_ID = "Et7X2jeZY6iNVDjz3jUUydm3ni3vWi8sPB4t59okNdxT"
SETTLEMENT_ENGINE_PROGRAM_ID = Pubkey.from_string(
    os.environ.get("GORILLA_SETTLEMENT_ENGINE_ID", SETTLEMENT_ENGINE_ID)
)
SYSTEM_PROGRAM_ID = Pubkey.from_string("11111111111111111111111111111111")
COMPUTE_BUDGET_ID = Pubkey.from_string("ComputeBudget111111111111111111111111111111")

# ── PDA seeds (mirror forge-markets/src/interface.rs) ────────────────────────────
MARKET_SEED = b"market"
VAULT_SEED = b"vault"
POSITION_SEED = b"position"
ROOTS_SEED = b"daily_scores_roots"  # txoracle-owned daily Merkle roots

# ── Anchor discriminators = sha256("global:<ix>")[..8] (verified against the IDL) ─
DISCRIMINATORS: dict[str, bytes] = {
    "create_market": bytes([103, 226, 97, 235, 200, 188, 251, 254]),
    "stake": bytes([206, 176, 202, 18, 200, 209, 179, 108]),
    "settle": bytes([175, 42, 185, 87, 144, 131, 102, 212]),
    "claim": bytes([62, 198, 214, 193, 213, 159, 108, 210]),
}

# validate_stat burns ~205k CU inside the CPI; give settle head-room.
SETTLE_COMPUTE_UNITS = 350_000

# Programs an on-chain wallet tolerates as a non-spending prelude to a whitelisted call.
PRELUDE_PROGRAM_IDS = frozenset({COMPUTE_BUDGET_ID})

_EPOCH_DAY_MS = 86_400_000


class ForgeError(Exception):
    """Building a forge_markets instruction failed (bad proof shape, out-of-range value)."""


class Comparison(IntEnum):
    """txoracle ``Comparison`` — Borsh variant index (single source of truth)."""

    GREATER_THAN = 0
    LESS_THAN = 1
    EQUAL_TO = 2


# Borsh variant index for the program's ``Side`` enum (Yes = 0, No = 1).
_SIDE_INDEX: dict[Side, int] = {"Yes": 0, "No": 1}


def side_index(side: Side) -> int:
    return _SIDE_INDEX[side]


def to_lamports(sol: float) -> int:
    """SOL (the WalletSeam's float unit) → lamports (the wire unit)."""
    return int(round(sol * 1_000_000_000))


@dataclass(frozen=True)
class TraderPredicate:
    """The YES condition a market stores and txoracle later evaluates. Borsh: i32 + u8."""

    threshold: int
    comparison: Comparison


@dataclass(frozen=True)
class UnsignedTx:
    """A built-but-unsigned transaction the policy-gated wallet signs. ``instruction_name`` +
    ``program_id`` are exactly what a wallet allow-list checks before it will sign; the
    ``instructions`` tuple may carry a non-spending ComputeBudget prelude."""

    instructions: tuple[Instruction, ...]
    program_id: Pubkey
    instruction_name: str


@dataclass(frozen=True)
class MarketAccount:
    """Decoded ``Market`` state — enough to route ``claim`` to the winning side and print the
    settled outcome. The program never lets us store payloads; this is public on-chain state."""

    fixture_id: int
    stat_key: int
    predicate: TraderPredicate
    vault: str
    stake_yes: int
    stake_no: int
    state: str  # "Open" | "Settled"
    winner: Side  # meaningful only once state == "Settled"


# ── minimal Borsh writer (little-endian, matches Anchor/Borsh exactly) ───────────
class _Borsh:
    def __init__(self) -> None:
        self.buf = bytearray()

    def u8(self, v: int) -> "_Borsh":
        self.buf.append(v & 0xFF)
        return self

    def u32(self, v: int) -> "_Borsh":
        self.buf += int(v).to_bytes(4, "little", signed=False)
        return self

    def i32(self, v: int) -> "_Borsh":
        self.buf += int(v).to_bytes(4, "little", signed=True)
        return self

    def u64(self, v: int) -> "_Borsh":
        self.buf += int(v).to_bytes(8, "little", signed=False)
        return self

    def i64(self, v: int) -> "_Borsh":
        self.buf += int(v).to_bytes(8, "little", signed=True)
        return self

    def arr32(self, v: list[int]) -> "_Borsh":
        if len(v) != 32:
            raise ForgeError(f"expected 32 bytes, got {len(v)}")
        self.buf += bytes(v)
        return self

    def bytes(self) -> bytes:
        return bytes(self.buf)


def _proof_vec(b: _Borsh, nodes: list[dict[str, Any]]) -> None:
    b.u32(len(nodes))
    for n in nodes:
        b.arr32(list(n["hash"])).u8(1 if n["isRightSibling"] else 0)


# ── PDA derivations ──────────────────────────────────────────────────────────────
def market_pda(fixture_id: int, stat_key: int) -> tuple[Pubkey, int]:
    return Pubkey.find_program_address(
        [
            MARKET_SEED,
            fixture_id.to_bytes(8, "little", signed=True),
            stat_key.to_bytes(4, "little"),
        ],
        FORGE_PROGRAM_ID,
    )


def vault_pda(market: Pubkey) -> tuple[Pubkey, int]:
    return Pubkey.find_program_address([VAULT_SEED, bytes(market)], FORGE_PROGRAM_ID)


def position_pda(market: Pubkey, staker: Pubkey) -> tuple[Pubkey, int]:
    return Pubkey.find_program_address(
        [POSITION_SEED, bytes(market), bytes(staker)], FORGE_PROGRAM_ID
    )


def daily_scores_roots_pda(min_timestamp_ms: int) -> tuple[Pubkey, int, int]:
    """The txoracle-owned root account settle passes through. Seed = the epoch-day of the
    snapshot's ``minTimestamp`` (NOT the proof's top-level ``ts``)."""
    epoch_day = min_timestamp_ms // _EPOCH_DAY_MS
    if not 0 <= epoch_day <= 0xFFFF:
        raise ForgeError("epoch day outside u16 range")
    pda, bump = Pubkey.find_program_address(
        [ROOTS_SEED, epoch_day.to_bytes(2, "little")], TXORACLE_PROGRAM_ID
    )
    return pda, bump, epoch_day


def compute_unit_limit_ix(units: int = SETTLE_COMPUTE_UNITS) -> Instruction:
    """ComputeBudget ``SetComputeUnitLimit`` (variant 2) — u32 LE units, no accounts."""
    return Instruction(COMPUTE_BUDGET_ID, bytes([2]) + int(units).to_bytes(4, "little"), [])


def compute_unit_price_ix(micro_lamports: int) -> Instruction:
    """ComputeBudget ``SetComputeUnitPrice`` (variant 3) — u64 LE micro-lamports per CU, no
    accounts. The priority fee it adds is ``ceil(cu_limit * micro_lamports / 1e6)`` lamports on
    top of the 5000-per-signature base fee. Zero/omitted on devnet; a mainnet build sets a
    non-zero price so a settle lands under fee-market load (a fork rehearsal has no mempool, so
    the price is a builder concern the founder tunes at broadcast, not a simulation input)."""
    if micro_lamports < 0:
        raise ForgeError("priority-fee price must be non-negative")
    return Instruction(
        COMPUTE_BUDGET_ID, bytes([3]) + int(micro_lamports).to_bytes(8, "little"), []
    )


def with_priority_fee(tx: UnsignedTx, micro_lamports: int) -> UnsignedTx:
    """Return ``tx`` with a ``SetComputeUnitPrice`` prelude prepended (priority fee), or ``tx``
    unchanged when ``micro_lamports <= 0``. The price ix is a ComputeBudget prelude — already
    inside the policy-gated wallet's allow-list tolerance (:data:`PRELUDE_PROGRAM_IDS`), so it
    never widens what the wallet will sign. Program id + ``instruction_name`` (the allow-list
    identity) are preserved. This is the ONE mainnet-param a devnet build omits; keeping it
    opt-in leaves every devnet path byte-identical."""
    if micro_lamports <= 0:
        return tx
    return UnsignedTx(
        (compute_unit_price_ix(micro_lamports), *tx.instructions),
        tx.program_id,
        tx.instruction_name,
    )


# ── instruction builders (account order MUST match each #[derive(Accounts)]) ─────
def build_create_market_ix(
    fixture_id: int,
    stat_key: int,
    predicate: TraderPredicate,
    period: int,
    lock_ts: int,
    authority: Pubkey,
) -> Instruction:
    market, _ = market_pda(fixture_id, stat_key)
    vault, _ = vault_pda(market)
    # arg order MUST match the program: fixture_id, stat_key, predicate, period, lock_ts.
    # `period` binds the stat phase the settle proof must match (F1) — see settle.rs.
    # `lock_ts` is the betting cutoff (Unix seconds); 0 = no cutoff — see stake.rs.
    data = (
        DISCRIMINATORS["create_market"]
        + _Borsh()
        .i64(fixture_id)
        .u32(stat_key)
        .i32(predicate.threshold)
        .u8(int(predicate.comparison))
        .i32(period)
        .i64(lock_ts)
        .bytes()
    )
    metas = [
        AccountMeta(market, is_signer=False, is_writable=True),
        AccountMeta(vault, is_signer=False, is_writable=False),
        AccountMeta(authority, is_signer=True, is_writable=True),
        AccountMeta(SYSTEM_PROGRAM_ID, is_signer=False, is_writable=False),
    ]
    return Instruction(FORGE_PROGRAM_ID, data, metas)


def build_stake_ix(
    fixture_id: int, stat_key: int, staker: Pubkey, side: Side, amount_lamports: int
) -> Instruction:
    if amount_lamports <= 0:
        raise ForgeError("stake amount must be positive")
    market, _ = market_pda(fixture_id, stat_key)
    vault, _ = vault_pda(market)
    position, _ = position_pda(market, staker)
    data = DISCRIMINATORS["stake"] + _Borsh().u8(side_index(side)).u64(amount_lamports).bytes()
    metas = [
        AccountMeta(market, is_signer=False, is_writable=True),
        AccountMeta(position, is_signer=False, is_writable=True),
        AccountMeta(vault, is_signer=False, is_writable=True),
        AccountMeta(staker, is_signer=True, is_writable=True),
        AccountMeta(SYSTEM_PROGRAM_ID, is_signer=False, is_writable=False),
    ]
    return Instruction(FORGE_PROGRAM_ID, data, metas)


def encode_settle_args(proof: dict[str, Any]) -> bytes:
    """Borsh-encode the ``settle`` args from a recorded txoracle proof. Mirrors the Rust
    ``data_settle`` order — and OMITS the predicate (the program injects the market's own).

    ``ts`` <- ``summary.updateStats.minTimestamp``. stat_b / op are ``None``."""
    summary = proof["summary"]
    us = summary["updateStats"]
    b = _Borsh()
    b.buf += DISCRIMINATORS["settle"]
    b.i64(us["minTimestamp"])  # ts — the FIX (not proof["ts"])
    # fixture_summary: ScoresBatchSummary
    b.i64(summary["fixtureId"])
    b.i32(us["updateCount"]).i64(us["minTimestamp"]).i64(us["maxTimestamp"])
    b.arr32(list(summary["eventStatsSubTreeRoot"]))
    # fixture_proof <- subTreeProof ; main_tree_proof <- mainTreeProof
    _proof_vec(b, proof["subTreeProof"])
    _proof_vec(b, proof["mainTreeProof"])
    # stat_a: StatTerm = statToProve + eventStatRoot + statProof
    stat = proof["statToProve"]
    b.u32(stat["key"]).i32(stat["value"]).i32(stat["period"])
    b.arr32(list(proof["eventStatRoot"]))
    _proof_vec(b, proof["statProof"])
    # stat_b: Option<StatTerm> = None ; op: Option<BinaryExpression> = None
    b.u8(0).u8(0)
    return b.bytes()


def build_settle_ixs(fixture_id: int, stat_key: int, proof: dict[str, Any]) -> list[Instruction]:
    """[ComputeBudget prelude, settle]. The settle account order mirrors ``Settle`` after the
    engine split (settle.rs ``Settle<'info>``, top-to-bottom):
    market (w), settlement_engine (r), daily_scores_merkle_roots (r), txoracle_program (r).

    ``settlement_engine`` (inserted after ``market``) is what makes settle's ``resolve`` CPI
    callable; the last two are the engine's own ``Resolve`` accounts, threaded through settle →
    engine → txoracle. Omitting the engine account = an account-mismatch revert on devnet."""
    market, _ = market_pda(fixture_id, stat_key)
    roots, _, _ = daily_scores_roots_pda(proof["summary"]["updateStats"]["minTimestamp"])
    settle = Instruction(
        FORGE_PROGRAM_ID,
        encode_settle_args(proof),
        [
            AccountMeta(market, is_signer=False, is_writable=True),
            AccountMeta(SETTLEMENT_ENGINE_PROGRAM_ID, is_signer=False, is_writable=False),
            AccountMeta(roots, is_signer=False, is_writable=False),
            AccountMeta(TXORACLE_PROGRAM_ID, is_signer=False, is_writable=False),
        ],
    )
    return [compute_unit_limit_ix(), settle]


def build_claim_ix(fixture_id: int, stat_key: int, staker: Pubkey) -> Instruction:
    market, _ = market_pda(fixture_id, stat_key)
    vault, _ = vault_pda(market)
    position, _ = position_pda(market, staker)
    metas = [
        AccountMeta(market, is_signer=False, is_writable=False),
        AccountMeta(position, is_signer=False, is_writable=True),
        AccountMeta(vault, is_signer=False, is_writable=True),
        AccountMeta(staker, is_signer=True, is_writable=True),
        AccountMeta(SYSTEM_PROGRAM_ID, is_signer=False, is_writable=False),
    ]
    return Instruction(FORGE_PROGRAM_ID, DISCRIMINATORS["claim"], metas)


# ── UnsignedTx wrappers (what the wallet signs; carry the allow-list identity) ────
def create_market_tx(
    fixture_id: int,
    stat_key: int,
    predicate: TraderPredicate,
    period: int,
    lock_ts: int,
    authority: Pubkey,
) -> UnsignedTx:
    ix = build_create_market_ix(fixture_id, stat_key, predicate, period, lock_ts, authority)
    return UnsignedTx((ix,), FORGE_PROGRAM_ID, "create_market")


def stake_tx(
    fixture_id: int, stat_key: int, staker: Pubkey, side: Side, amount_lamports: int
) -> UnsignedTx:
    ix = build_stake_ix(fixture_id, stat_key, staker, side, amount_lamports)
    return UnsignedTx((ix,), FORGE_PROGRAM_ID, "stake")


def settle_tx(fixture_id: int, stat_key: int, proof: dict[str, Any]) -> UnsignedTx:
    ixs = build_settle_ixs(fixture_id, stat_key, proof)
    return UnsignedTx(tuple(ixs), FORGE_PROGRAM_ID, "settle")


def claim_tx(fixture_id: int, stat_key: int, staker: Pubkey) -> UnsignedTx:
    ix = build_claim_ix(fixture_id, stat_key, staker)
    return UnsignedTx((ix,), FORGE_PROGRAM_ID, "claim")


# ── Market decode (public on-chain state → routing + display) ─────────────────────
def decode_market(data: bytes) -> MarketAccount:
    """Decode a ``Market`` account (8-byte Anchor disc + Borsh body). Field order mirrors
    ``state.rs`` exactly."""
    if len(data) < 8 + 75:
        raise ForgeError("market account too small to decode")
    o = 8  # skip the Anchor discriminator
    fixture_id = int.from_bytes(data[o : o + 8], "little", signed=True)
    stat_key = int.from_bytes(data[o + 8 : o + 12], "little")
    threshold = int.from_bytes(data[o + 12 : o + 16], "little", signed=True)
    comparison = Comparison(data[o + 16])
    vault = str(Pubkey.from_bytes(data[o + 17 : o + 49]))
    stake_yes = int.from_bytes(data[o + 49 : o + 57], "little")
    stake_no = int.from_bytes(data[o + 57 : o + 65], "little")
    state = "Open" if data[o + 65] == 0 else "Settled"
    winner: Side = "Yes" if data[o + 66] == 0 else "No"
    return MarketAccount(
        fixture_id=fixture_id,
        stat_key=stat_key,
        predicate=TraderPredicate(threshold, comparison),
        vault=vault,
        stake_yes=stake_yes,
        stake_no=stake_no,
        state=state,
        winner=winner,
    )


# ── recorded proof helpers ────────────────────────────────────────────────────────
def load_recorded_proof(path: str | Path) -> dict[str, Any]:
    """Load the recorded settled-fixture proof (the free World-Cup tier). Returns the inner
    ``proof`` object."""
    doc = json.loads(Path(path).read_text())
    proof: dict[str, Any] = doc.get("proof", doc)
    return proof


def winning_predicate(proof: dict[str, Any]) -> TraderPredicate:
    """A predicate that HOLDS for this proof: ``stat.value > (value - 1)`` — always true —
    so a valid settle records ``winner = Yes`` (the demo's YES-wins path)."""
    value = int(proof["statToProve"]["value"])
    return TraderPredicate(threshold=value - 1, comparison=Comparison.GREATER_THAN)


def proof_period(proof: dict[str, Any]) -> int:
    """The stat PERIOD a market must bind so this proof settles it (F1). ``settle`` requires
    ``stat_a.period == market.period``, so a market opened for this proof MUST store this
    period — otherwise the honest settle reverts with ``PeriodMismatch``."""
    return int(proof["statToProve"]["period"])


# Human names for the program's custom errors (code = 6000 + variant index), so a live
# failure reports the exact fail-closed reason instead of a bare number.
SETTLEMENT_ERRORS: dict[int, str] = {
    6000: "MarketNotOpen",
    6001: "MarketNotSettled",
    6002: "ZeroStake",
    6003: "NotWinningSide",
    6004: "AlreadyClaimed",
    6005: "NoWinningStake",
    6006: "WrongOracleProgram",
    6007: "Overflow",
    6008: "OracleNoReturnData",
    6009: "OracleReturnWrongProgram",
    6010: "OracleBadReturnData",
    6011: "FixtureMismatch",
    6012: "StatMismatch",
    6013: "MultiStatNotAllowed",
    6014: "PeriodMismatch",
    6015: "WrongEngineProgram",
    6016: "MarketLocked",
    6017: "ReclaimTooEarly",
    6018: "ReclaimUnavailable",
}
