"""On-chain policy-gated wallets — the custody boundary, on devnet.

Two drop-ins behind the offline core's :class:`~gorilla.wallet.WalletSeam` (same
``funded`` / ``authorize`` / ``sign_within_policy``), so the agent loop is unchanged whether
it signs against a sandbox, a local devnet key, or a Privy TEE wallet:

* :class:`LocalDevnetWallet` — a real ed25519 devnet keypair that signs + sends a real
  ``forge_markets`` transaction. The guaranteed demo signer (the probe validated this exact
  path lands a tx).
* :class:`PrivyWallet` — a Privy server-wallet (custody key non-exportable, in a TEE) signing
  the SAME transaction. Ready as a drop-in; its live path needs the founder to attach a
  Solana policy to the app (see :meth:`PrivyWallet.founder_setup`), so the demo defaults to
  ``LocalDevnetWallet``.

Both enforce the user's authorized policy IN THE CLIENT, BEFORE signing: a spend cap AND a
``purpose -> (program_id, instruction)`` allow-list, plus a defence-in-depth check that the
built transaction really targets that program + instruction (right 8-byte discriminator, no
smuggled extra instruction, and every required signature is the wallet's own key). Over-cap,
off-allow-list, or a mismatched transaction is refused with :class:`PolicyViolation` — no
signature is ever produced. This is the trustless-custody half of the demo: the agent
describes intent, the wallet decides what it will sign.

DEVNET-ONLY (enforced by :class:`~gorilla.solana_rpc.SolanaRpc`).
"""

from __future__ import annotations

import base64
import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Protocol, runtime_checkable

from solders.hash import Hash
from solders.instruction import Instruction
from solders.keypair import Keypair
from solders.message import Message
from solders.pubkey import Pubkey
from solders.transaction import Transaction

from .forge_client import (
    DISCRIMINATORS,
    FORGE_PROGRAM_ID,
    PRELUDE_PROGRAM_IDS,
    SETTLEMENT_ERRORS,
    UnsignedTx,
)
from .privy_http import (
    PRIVY_SOLANA_DEVNET_CAIP2,
    PrivyError,
    privy_creds,
    privy_request,
    privy_wallet_config,
)
from .solana_rpc import RpcError, SolanaRpc
from .wallet import Policy, PolicyViolation, SignResult, TxIntent

# Re-exported for callers/tests that reference it via this module (single source: privy_http).
__all__ = [
    "ChainPolicy",
    "ChainWallet",
    "LocalDevnetWallet",
    "OnChainError",
    "PRIVY_SOLANA_DEVNET_CAIP2",
    "PrivyNotConfigured",
    "PrivyWallet",
    "describe_tx_error",
    "fund_if_low",
    "load_keypair",
    "load_or_create_keypair",
    "save_keypair",
]


@runtime_checkable
class ChainWallet(Protocol):
    """A WalletSeam that also exposes its on-chain address — what the settlement loop needs to
    build the transactions each wallet will sign. Both on-chain wallets satisfy it; the offline
    ``SandboxWallet`` (no key) does not."""

    @property
    def pubkey(self) -> Pubkey: ...
    def funded(self) -> float: ...
    def authorize(self, policy: Policy) -> None: ...
    def sign_within_policy(self, intent: TxIntent) -> SignResult: ...


class OnChainError(Exception):
    """A built transaction failed to simulate/send on devnet (not a policy refusal)."""


@dataclass(frozen=True)
class ChainPolicy(Policy):
    """The on-chain policy the user authorizes once. Extends the offline
    :class:`~gorilla.wallet.Policy` (spend cap + purpose allow-list) with the
    ``purpose -> (program_id, instruction)`` binding an on-chain wallet needs — so a
    whitelisted purpose can only ever drive the exact program + instruction it names.

    A plain ``Policy`` (no bindings) authorizes purposes + cap but binds no program, so every
    on-chain sign fails closed — an on-chain wallet needs a ``ChainPolicy``."""

    bindings: Mapping[str, tuple[str, str]] = field(default_factory=dict)


# Anchor allocates program errors from 6000 up, so a LOWER custom code on a forge_markets
# transaction came from a CPI into a built-in — in practice the System Program. Naming the
# common ones turns an opaque "custom 0" into the actual reason (that code is what a repeat
# stake returns, because ``stake`` uses ``init`` and allows one position per staker per market).
SYSTEM_PROGRAM_ERRORS: dict[int, str] = {
    0: "AccountAlreadyInUse (the PDA being init'd already exists)",
    1: "ResultWithNegativeLamports",
    2: "InvalidProgramId",
    3: "InvalidAccountDataLength",
    4: "MaxSeedLengthExceeded",
    5: "AddressWithSeedMismatch",
    6: "NonceNoRecentBlockhashes",
    7: "NonceBlockhashNotExpired",
    8: "NonceUnexpectedBlockhashValue",
}

# Anchor's first program-defined error code.
ANCHOR_ERROR_BASE = 6000


def describe_tx_error(err: object) -> str:
    """Render an RPC/simulation error, naming the custom code when present.

    Codes at or above :data:`ANCHOR_ERROR_BASE` are forge_markets' own (e.g. the fail-closed
    settle codes 6008/6009/6010); lower codes come from a CPI into the System Program and are
    named from :data:`SYSTEM_PROGRAM_ERRORS`, so a caller never has to decode a bare integer."""
    try:
        if isinstance(err, dict):
            ie = err.get("InstructionError")
            if isinstance(ie, list) and len(ie) == 2 and isinstance(ie[1], dict):
                code = ie[1].get("Custom")
                if isinstance(code, int):
                    if code >= ANCHOR_ERROR_BASE:
                        name = SETTLEMENT_ERRORS.get(code, f"custom {code}")
                    else:
                        name = SYSTEM_PROGRAM_ERRORS.get(code, f"system program error {code}")
                    return f"instruction {ie[0]}: {name} ({code})"
    except Exception:  # never let error-formatting mask the original failure
        pass
    return json.dumps(err)


# ── shared policy enforcement (identical for Local + Privy) ──────────────────────
def _enforce_policy(
    policy: Policy | None, intent: TxIntent, *, spent: float, funded: float
) -> tuple[str, str]:
    """Run every cap/allow-list check and return the bound ``(program_id, instruction)``.
    Raises :class:`PolicyViolation` on any failure — BEFORE any signing happens."""
    if policy is None:
        raise PolicyViolation("no policy authorized — the user hasn't delegated authority")
    if intent.unsigned_tx is None:
        raise PolicyViolation("on-chain wallet needs a built transaction to sign")
    if intent.purpose not in policy.allowed_purposes:
        raise PolicyViolation(f"purpose {intent.purpose!r} is not in the authorized policy")
    if spent + intent.amount > policy.max_spend:
        raise PolicyViolation(f"would exceed the {policy.max_spend:g} spend cap")
    if intent.amount > 0 and intent.amount > funded:
        raise PolicyViolation("insufficient devnet funds")
    bindings = policy.bindings if isinstance(policy, ChainPolicy) else {}
    binding = bindings.get(intent.purpose)
    if binding is None:
        raise PolicyViolation(f"purpose {intent.purpose!r} has no program binding (fail-closed)")
    return binding


def _verify_unsigned_tx(unsigned: UnsignedTx, binding: tuple[str, str], signer: Pubkey) -> None:
    """Defence in depth: the built tx must target exactly the bound program + instruction,
    carry the right discriminator, smuggle no extra program, and need only ``signer``'s key."""
    want_program, want_instruction = binding
    if str(unsigned.program_id) != want_program or unsigned.instruction_name != want_instruction:
        raise PolicyViolation(
            f"off-allow-list: intent binds {want_instruction}@{want_program} but tx is "
            f"{unsigned.instruction_name}@{unsigned.program_id}"
        )
    target = Pubkey.from_string(want_program)
    program_ixs = [ix for ix in unsigned.instructions if ix.program_id == target]
    if len(program_ixs) != 1:
        raise PolicyViolation("tx must carry exactly one instruction to the bound program")
    if bytes(program_ixs[0].data[:8]) != DISCRIMINATORS.get(want_instruction, b""):
        raise PolicyViolation(
            f"instruction data is not a {want_instruction} call (bad discriminator)"
        )
    for ix in unsigned.instructions:
        if ix.program_id != target and ix.program_id not in PRELUDE_PROGRAM_IDS:
            raise PolicyViolation(f"tx smuggles an off-allow-list instruction to {ix.program_id}")
    required = {
        meta.pubkey for ix in unsigned.instructions for meta in ix.accounts if meta.is_signer
    }
    if required - {signer}:
        raise PolicyViolation("tx requires a signature this wallet does not hold")


def _b64(tx: Transaction) -> str:
    return base64.b64encode(bytes(tx)).decode()


# ── keypair helpers (throwaway devnet keys are gitignored) ───────────────────────
def load_keypair(path: str | Path) -> Keypair:
    return Keypair.from_bytes(bytes(json.load(open(path))))


def save_keypair(kp: Keypair, path: str | Path) -> None:
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(list(bytes(kp))))


def load_or_create_keypair(path: str | Path) -> Keypair:
    """Reuse a throwaway devnet keypair if present, else mint + persist one (gitignored)."""
    p = Path(path)
    if p.exists():
        return load_keypair(p)
    kp = Keypair()
    save_keypair(kp, p)
    return kp


def fund_if_low(rpc: SolanaRpc, funder: Keypair, to: Pubkey, target_sol: float) -> str | None:
    """Top ``to`` up to ``target_sol`` from ``funder`` via a devnet System transfer (setup
    plumbing, not the policy-gated demo path). No-op + ``None`` if already funded."""
    from solders.system_program import TransferParams, transfer

    have = rpc.get_balance(str(to)) / 1_000_000_000
    if have >= target_sol:
        return None
    lamports = int(round((target_sol - have) * 1_000_000_000))
    ix = transfer(TransferParams(from_pubkey=funder.pubkey(), to_pubkey=to, lamports=lamports))
    sim = rpc.simulate(
        _b64(Transaction.new_signed_with_payer([ix], funder.pubkey(), [funder], Hash.default()))
    )
    if sim.get("err") is not None:
        raise OnChainError(f"funding {to} would fail: {describe_tx_error(sim['err'])}")
    tx = Transaction.new_signed_with_payer(
        [ix], funder.pubkey(), [funder], Hash.from_string(rpc.latest_blockhash())
    )
    sig = rpc.send(_b64(tx))
    rpc.confirm(sig)
    return sig


@dataclass
class LocalDevnetWallet:
    """A real devnet keypair behind the WalletSeam. Enforces the authorized policy in-client,
    then SIMULATES (fail-closed gate) and SENDS a real ``forge_markets`` transaction. Slots
    behind the exact seam a Privy TEE wallet would — the difference is only where the key
    lives and where policy is enforced, not the interface."""

    keypair: Keypair
    rpc: SolanaRpc
    _policy: Policy | None = field(default=None, init=False)
    _spent: float = field(default=0.0, init=False)

    @classmethod
    def from_file(cls, path: str | Path, rpc: SolanaRpc) -> "LocalDevnetWallet":
        return cls(keypair=load_keypair(path), rpc=rpc)

    @property
    def pubkey(self) -> Pubkey:
        return self.keypair.pubkey()

    def funded(self) -> float:
        return self.rpc.get_balance(str(self.pubkey)) / 1_000_000_000

    def authorize(self, policy: Policy) -> None:
        self._policy = policy

    def sign_within_policy(self, intent: TxIntent) -> SignResult:
        funded = self.funded() if intent.amount > 0 else 0.0
        binding = _enforce_policy(self._policy, intent, spent=self._spent, funded=funded)
        assert intent.unsigned_tx is not None  # guaranteed by _enforce_policy
        _verify_unsigned_tx(intent.unsigned_tx, binding, self.pubkey)
        signature = self._simulate_then_send(intent.unsigned_tx)
        self._spent = round(self._spent + intent.amount, 9)
        return SignResult(intent=intent, ref=signature)

    def _signed(self, unsigned: UnsignedTx, blockhash: Hash) -> Transaction:
        return Transaction.new_signed_with_payer(
            list(unsigned.instructions), self.pubkey, [self.keypair], blockhash
        )

    def _simulate_then_send(self, unsigned: UnsignedTx) -> str:
        # Simulate first (sigVerify off, blockhash replaced): never broadcast a doomed tx.
        sim = self.rpc.simulate(_b64(self._signed(unsigned, Hash.default())))
        if sim.get("err") is not None:
            raise OnChainError(
                f"{unsigned.instruction_name} would fail: {describe_tx_error(sim['err'])}"
            )
        tx = self._signed(unsigned, Hash.from_string(self.rpc.latest_blockhash()))
        signature = self.rpc.send(_b64(tx))
        try:
            self.rpc.confirm(signature)
        except RpcError as exc:
            raise OnChainError(str(exc)) from None
        return signature


class PrivyNotConfigured(Exception):
    """The Privy custody path is not enabled (missing app creds / wallet id / policy attach)."""


@dataclass
class PrivyWallet:
    """A Privy server-wallet (custody key in a TEE, non-exportable) behind the same WalletSeam.

    Enforces the authorized policy IN-CLIENT before it will build a transaction — the exact
    same cap + allow-list + discriminator checks as :class:`LocalDevnetWallet` — then hands the
    unsigned transaction to Privy's ``signAndSendTransaction`` (devnet). Once the founder
    attaches a Solana policy to the Privy app, that same policy is ALSO enforced server-side in
    the TEE (defence in depth). The demo defaults to ``LocalDevnetWallet``; this is the
    drop-in for the custody-grade path.

    ``transport`` is injectable so the policy refusals are unit-tested with zero network — a
    refused intent must never reach Privy.
    """

    wallet_id: str
    address: Pubkey
    rpc: SolanaRpc
    app_id: str | None = None
    app_secret: str | None = None
    transport: Callable[[str, dict], dict] | None = None
    _policy: Policy | None = field(default=None, init=False)
    _spent: float = field(default=0.0, init=False)

    @classmethod
    def from_env(
        cls,
        rpc: SolanaRpc,
        *,
        wallet_id: str | None = None,
        address: str | None = None,
    ) -> "PrivyWallet":
        """Wire the provisioned Privy server-wallet behind the WalletSeam: wallet id + address
        from env (``PRIVY_WALLET_ID`` / ``PRIVY_WALLET_ADDRESS``, else the devnet demo defaults)
        and app creds from env / a local ``.env``. Raises :class:`PrivyNotConfigured` if creds
        are absent — the caller can then fall back to :class:`LocalDevnetWallet`."""
        env_wallet_id, env_address = privy_wallet_config()
        app_id, app_secret = privy_creds()
        if not (app_id and app_secret):
            raise PrivyNotConfigured(cls.founder_setup())
        return cls(
            wallet_id=wallet_id or env_wallet_id,
            address=Pubkey.from_string(address or env_address),
            rpc=rpc,
            app_id=app_id,
            app_secret=app_secret,
        )

    @property
    def pubkey(self) -> Pubkey:
        return self.address

    def funded(self) -> float:
        return self.rpc.get_balance(str(self.address)) / 1_000_000_000

    def authorize(self, policy: Policy) -> None:
        self._policy = policy

    def sign_within_policy(self, intent: TxIntent) -> SignResult:
        funded = self.funded() if intent.amount > 0 else 0.0
        binding = _enforce_policy(self._policy, intent, spent=self._spent, funded=funded)
        assert intent.unsigned_tx is not None
        _verify_unsigned_tx(intent.unsigned_tx, binding, self.address)
        # Only NOW (policy satisfied) do we touch Privy — a refusal never leaves the process.
        tx_b64 = self._unsigned_b64(intent.unsigned_tx)
        result = self._privy_sign_and_send(tx_b64)
        signature = str(result.get("data", {}).get("hash", ""))
        if not signature:
            raise OnChainError(f"Privy returned no signature: {describe_tx_error(result)}")
        # Confirm to FINALIZED before returning: Privy preflight-simulates the NEXT tx on its own
        # RPC node, which lags a merely 'confirmed' account and would revert 'not initialized'
        # (e.g. staking into a just-created market). Finalized is rooted cluster-wide.
        try:
            self.rpc.confirm(signature, commitment="finalized", timeout_s=90)
        except RpcError as exc:
            raise OnChainError(str(exc)) from None
        self._spent = round(self._spent + intent.amount, 9)
        return SignResult(intent=intent, ref=signature)

    def test_sign_self_transfer(self, lamports: int = 0) -> str:
        """Enclave-path smoke (Do #3): build a devnet System-Program self-transfer (default 0
        lamports — it CANNOT move value), have Privy sign + send it inside the TEE, and return the
        signature. It stays within the attached policy (System program is allow-listed; 0 lamports
        is under the cap), so it also proves the policy permits a legitimate tx.

        This is the RAW enclave path — the server-side Privy policy still gates it, but it does NOT
        run the client-side ``ChainPolicy`` (that's :meth:`sign_within_policy`). Kept deliberately
        un-repurposable: a self-transfer can only ever pay a fee, never move value out."""
        from solders.system_program import TransferParams, transfer

        ix = transfer(
            TransferParams(from_pubkey=self.address, to_pubkey=self.address, lamports=lamports)
        )
        result = self._privy_sign_and_send(self._unsigned_b64_ixs([ix]))
        signature = str(result.get("data", {}).get("hash", ""))
        if not signature:
            raise OnChainError(f"Privy returned no signature: {describe_tx_error(result)}")
        return signature

    def _unsigned_b64(self, unsigned: UnsignedTx) -> str:
        return self._unsigned_b64_ixs(list(unsigned.instructions))

    def _unsigned_b64_ixs(self, instructions: Sequence[Instruction]) -> str:
        # Privy signs; we build an UNSIGNED tx with the Privy wallet as fee payer.
        msg = Message.new_with_blockhash(
            list(instructions), self.address, Hash.from_string(self.rpc.latest_blockhash())
        )
        return base64.b64encode(bytes(Transaction.new_unsigned(msg))).decode()

    def _privy_sign_and_send(self, tx_b64: str) -> dict:
        env_id, env_secret = privy_creds()
        app_id = self.app_id or env_id
        app_secret = self.app_secret or env_secret
        if not (app_id and app_secret and self.wallet_id):
            raise PrivyNotConfigured(self.founder_setup())
        body = {
            "method": "signAndSendTransaction",
            "caip2": PRIVY_SOLANA_DEVNET_CAIP2,  # devnet — Privy routes by this; never mainnet
            "params": {"transaction": tx_b64, "encoding": "base64"},
        }
        if self.transport is not None:  # injected fake in tests — a refusal never reaches here
            return self.transport(self.wallet_id, body)
        # Real path: routed through privy_http so it carries the Cloudflare-safe User-Agent and
        # redacts on error (a bare urllib request here would be 403-banned as Python-urllib/*).
        try:
            return privy_request(
                "POST",
                f"/v1/wallets/{self.wallet_id}/rpc",
                app_id=app_id,
                app_secret=app_secret,
                body=body,
            )
        except PrivyError as exc:
            raise OnChainError(str(exc)) from None

    @staticmethod
    def founder_setup() -> str:
        """What must be true to enable this path — surfaced when creds/wallet id are missing."""
        return (
            "Privy custody not enabled. Needs (all devnet): 1) PRIVY_APP_ID + PRIVY_APP_SECRET "
            "in env or a local .env; 2) PRIVY_WALLET_ID + PRIVY_WALLET_ADDRESS (a Solana server "
            "wallet); 3) a Solana signing policy attached (per-tx max-SOL cap + a program "
            f"allow-list incl. forge_markets {FORGE_PROGRAM_ID}) — run scripts/privy_setup.py. "
            "Until then, use LocalDevnetWallet."
        )
