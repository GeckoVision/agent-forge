"""Policy-gated wallet seam — the custody boundary, $0 offline.

The user authorizes ONE policy (a spend cap + a purpose allow-list); the agent hands the
wallet transaction intents; the wallet signs ONLY within that policy and REFUSES anything
over the cap or off the allow-list BEFORE producing a signature. The agent never holds keys.

``WalletSeam`` is the injected boundary (the same shape as an auth ``Session``). The offline
``SandboxWallet`` here is the falsify-offline first deliverable; the on-chain ``PrivyWallet``
(next chunk) implements the SAME three methods — ``funded`` / ``authorize`` /
``sign_within_policy`` — but signs a real Solana ``place_bet`` / ``settle`` transaction and
enforces the policy in a server-side (TEE) wallet. Keep this shape stable so ``PrivyWallet``
is a drop-in behind ``WalletSeam``.

Amounts are in stake units (devnet SOL in the on-chain chunk); no real value moves here.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Protocol, runtime_checkable

if TYPE_CHECKING:
    # Only for the annotation — the offline core never imports solders/forge_client at
    # runtime, so ``SandboxWallet`` stays a zero-dependency, offline-falsifiable unit.
    from .forge_client import UnsignedTx


@dataclass(frozen=True)
class Policy:
    """What the user authorized once — the bound the wallet signs within."""

    max_spend: float
    allowed_purposes: frozenset[str]


@dataclass(frozen=True)
class TxIntent:
    """A transaction the agent asks the wallet to sign. ``purpose`` is matched against the
    policy allow-list; ``amount`` is checked against the spend cap.

    ``unsigned_tx`` is the additive on-chain extension: the offline ``SandboxWallet`` ignores
    it (there is nothing to sign), while ``LocalDevnetWallet`` / ``PrivyWallet`` sign the
    real ``forge_markets`` transaction it carries. Defaulting to ``None`` keeps the offline
    shape — ``TxIntent(purpose, amount, description)`` — unchanged."""

    purpose: str
    amount: float
    description: str
    unsigned_tx: "UnsignedTx | None" = None


@dataclass(frozen=True)
class SignResult:
    """The signed result. ``ref`` is an opaque sandbox reference offline (NO real signature —
    there are no keys here); ``PrivyWallet`` returns a real transaction signature in the same
    field."""

    intent: TxIntent
    ref: str


class PolicyViolation(Exception):
    """The wallet refused: over cap, off-purpose, unauthorized, or unfunded. The bound held."""


@runtime_checkable
class WalletSeam(Protocol):
    """The policy-gated hands. Any wallet (sandbox, Privy, OKX) satisfies this."""

    def funded(self) -> float: ...
    def authorize(self, policy: Policy) -> None: ...
    def sign_within_policy(self, intent: TxIntent) -> SignResult: ...


@dataclass
class SandboxWallet:
    """A $0 ephemeral wallet: auto-funded, no real keys, no real value. Enforces the user's
    policy — signs within it, refuses anything over cap or off-purpose. Deterministic, so the
    whole offline core is falsifiable offline (Pattern B)."""

    funded_amount: float = 100.0
    _policy: Policy | None = field(default=None, init=False)
    _spent: float = field(default=0.0, init=False)

    def funded(self) -> float:
        return round(self.funded_amount - self._spent, 6)

    def authorize(self, policy: Policy) -> None:
        self._policy = policy

    def sign_within_policy(self, intent: TxIntent) -> SignResult:
        if self._policy is None:
            raise PolicyViolation("no policy authorized — the user hasn't delegated authority")
        if intent.purpose not in self._policy.allowed_purposes:
            raise PolicyViolation(f"purpose {intent.purpose!r} is not in the authorized policy")
        # Cap + funding checks run BEFORE any signing — an over-cap intent never produces a
        # ref and never moves the spend counter.
        if self._spent + intent.amount > self._policy.max_spend:
            raise PolicyViolation(f"would exceed the {self._policy.max_spend:g} policy cap")
        if intent.amount > self.funded():
            raise PolicyViolation("insufficient sandbox funds")
        self._spent = round(self._spent + intent.amount, 6)
        # Deterministic opaque ref — there is NO signing here (no keys, no broadcast).
        digest = hashlib.sha256(
            f"{intent.purpose}:{intent.amount}:{self._spent}".encode()
        ).hexdigest()[:16]
        return SignResult(intent=intent, ref=f"sandbox:{digest}")
