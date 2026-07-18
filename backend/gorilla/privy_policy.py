"""Privy Solana signing policy — build it, falsify it offline, attach it (server-side custody).

This is the SERVER-SIDE half of the custody boundary: a policy enforced inside Privy's TEE (and
at its API tier for value caps) so the enclave itself refuses an out-of-policy signature — the
belt to the client-side :class:`~gorilla.wallets.ChainPolicy` braces. The demo's policy:

* a per-transaction **max-SOL cap** (default 0.05 SOL) on System-Program transfers, expressed as
  a ``DENY`` rule (``Transfer.lamports gt cap``) — a DENY, not an ``ALLOW lte``, because Privy
  evaluates EVERY instruction and DENY takes precedence: an ``ALLOW lte`` would be silently
  overridden by the program-allowlist ALLOW below, so only a DENY actually caps value; and
* a **program allow-list** (``ALLOW`` ``programId in {forge_markets, System, ComputeBudget}``) —
  any instruction touching another program gets no ALLOW and Privy's default-DENY rejects the tx.

Privy's documented evaluation model (verified against the live API reference):
  - every instruction in the transaction is evaluated independently;
  - a rule fires on an instruction only when the instruction satisfies ALL of its conditions;
  - per instruction: any DENY -> DENY; else any ALLOW -> ALLOW; else default DENY;
  - the transaction is allowed only if EVERY instruction resolves to ALLOW.

:func:`simulate_privy_evaluation` encodes exactly that model so the policy is falsifiable with
zero network (Pattern B): feed it the real built instructions and assert the verdict. The live
test-sign then confirms the real enclave agrees.
"""

from __future__ import annotations

from typing import Any

from solders.instruction import Instruction

from .forge_client import COMPUTE_BUDGET_ID, FORGE_PROGRAM_ID, SYSTEM_PROGRAM_ID
from .privy_http import PrivyError, Transport, privy_request

SIGN_METHOD = "signAndSendTransaction"

# 0.05 SOL — comfortably above the 0.01/0.005 demo bets, well under the 0.3 SOL funded balance.
DEFAULT_MAX_LAMPORTS = 50_000_000

# The three programs the forge_markets settlement loop + the devnet test-sign ever touch at the
# top level: forge_markets itself, the System Program (self-transfer test-sign / funding), and
# the ComputeBudget prelude the settle instruction carries.
DEFAULT_ALLOWED_PROGRAM_IDS: tuple[str, ...] = (
    str(FORGE_PROGRAM_ID),
    str(SYSTEM_PROGRAM_ID),
    str(COMPUTE_BUDGET_ID),
)

# System Program Transfer instruction: variant 2 (u32 LE) then u64 LE lamports.
_SYSTEM_TRANSFER_TAG = (2).to_bytes(4, "little")


# Privy enforces name length server-side (verified live: a >50-char rule name is a 400). Guard
# BOTH the policy name and every rule name so an over-long name fails offline, not on the wire.
_MAX_NAME = 50


def _check_name(kind: str, name: str) -> None:
    if not 1 <= len(name) <= _MAX_NAME:
        raise ValueError(f"Privy {kind} name must be 1-{_MAX_NAME} chars (got {len(name)})")


def build_forge_markets_policy(
    *,
    name: str = "gorilla-forge-markets-devnet",
    cap_lamports: int = DEFAULT_MAX_LAMPORTS,
    allowed_program_ids: tuple[str, ...] = DEFAULT_ALLOWED_PROGRAM_IDS,
) -> dict[str, Any]:
    """Build the Privy Solana policy document (the exact JSON ``POST /v1/policies`` expects)."""
    _check_name("policy", name)
    if cap_lamports <= 0:
        raise ValueError("cap must be positive")
    rules = [
        {
            "name": "Allow forge_markets, System, ComputeBudget",
            "method": SIGN_METHOD,
            "conditions": [
                {
                    "field_source": "solana_program_instruction",
                    "field": "programId",
                    "operator": "in",
                    "value": list(allowed_program_ids),
                }
            ],
            "action": "ALLOW",
        },
        {
            "name": "Deny SOL transfer over per-tx cap",
            "method": SIGN_METHOD,
            "conditions": [
                {
                    "field_source": "solana_system_program_instruction",
                    "field": "Transfer.lamports",
                    "operator": "gt",
                    "value": str(cap_lamports),
                }
            ],
            "action": "DENY",
        },
    ]
    for rule in rules:
        _check_name("rule", str(rule["name"]))
    return {"version": "1.0", "name": name, "chain_type": "solana", "rules": rules}


# ── offline model of Privy's documented engine (Pattern B falsification) ──────────
def _transfer_lamports(ix: Instruction) -> int | None:
    """The lamports of a System-Program ``Transfer`` instruction, else ``None`` (the
    ``Transfer.lamports`` field only exists for a System transfer)."""
    if str(ix.program_id) != str(SYSTEM_PROGRAM_ID):
        return None
    data = bytes(ix.data)
    if len(data) < 12 or data[:4] != _SYSTEM_TRANSFER_TAG:
        return None
    return int.from_bytes(data[4:12], "little")


def _condition_holds(cond: dict[str, Any], ix: Instruction) -> bool:
    """Whether one condition is satisfied by one instruction. A condition whose field does not
    apply to this instruction (e.g. ``Transfer.lamports`` on a non-transfer) is NOT satisfied."""
    src, field, op, value = (
        cond["field_source"],
        cond["field"],
        cond["operator"],
        cond["value"],
    )
    if src == "solana_program_instruction" and field == "programId":
        pid = str(ix.program_id)
        return pid in value if op == "in" else pid == value
    if src == "solana_system_program_instruction" and field == "Transfer.lamports":
        lam = _transfer_lamports(ix)
        if lam is None:
            return False
        target = int(value)
        return {
            "gt": lam > target,
            "gte": lam >= target,
            "lt": lam < target,
            "lte": lam <= target,
            "eq": lam == target,
        }.get(op, False)
    return False  # a field source this model does not implement is treated as non-matching


def _instruction_allowed(policy: dict[str, Any], ix: Instruction) -> bool:
    """One instruction's verdict under the policy: DENY > ALLOW > default-DENY."""
    allow = False
    for rule in policy["rules"]:
        if rule["method"] != SIGN_METHOD:
            continue
        if all(_condition_holds(c, ix) for c in rule["conditions"]):
            if rule["action"] == "DENY":
                return False  # DENY takes precedence — short-circuit
            allow = True
    return allow


def simulate_privy_evaluation(policy: dict[str, Any], instructions: list[Instruction]) -> bool:
    """Model Privy's enclave verdict for a ``signAndSendTransaction`` of ``instructions``: the tx
    is allowed only if EVERY instruction independently resolves to ALLOW. Zero network."""
    return all(_instruction_allowed(policy, ix) for ix in instructions)


# ── thin control-plane client (create + attach + read) — transport injectable ─────
class PrivyControlPlane:
    """Create policies and attach them to a wallet via Privy's REST API. The transport is
    injectable so create/attach/read are unit-tested offline; the default hits ``api.privy.io``.
    """

    def __init__(
        self,
        app_id: str,
        app_secret: str,
        *,
        transport: Transport | None = None,
    ) -> None:
        self._app_id = app_id
        self._app_secret = app_secret
        self._transport = transport

    def _call(
        self,
        method: str,
        path: str,
        body: dict[str, Any] | None = None,
        *,
        idempotency_key: str | None = None,
    ) -> dict[str, Any]:
        if self._transport is not None:
            return self._transport(method, path, body)
        return privy_request(
            method,
            path,
            app_id=self._app_id,
            app_secret=self._app_secret,
            body=body,
            idempotency_key=idempotency_key,
        )

    def create_policy(self, policy: dict[str, Any], *, idempotency_key: str | None = None) -> str:
        """``POST /v1/policies`` -> the new policy id. Pass ``idempotency_key`` so a founder re-run
        returns the same policy instead of creating a duplicate."""
        resp = self._call("POST", "/v1/policies", policy, idempotency_key=idempotency_key)
        policy_id = resp.get("id")
        if not isinstance(policy_id, str) or not policy_id:
            raise PrivyError(f"Privy create policy returned no id: {resp}")
        return policy_id

    def attach_policy(self, wallet_id: str, policy_id: str) -> dict[str, Any]:
        """``PATCH /v1/wallets/{id}`` setting ``policy_ids`` (Privy allows one policy per wallet)."""
        return self._call("PATCH", f"/v1/wallets/{wallet_id}", {"policy_ids": [policy_id]})

    def get_wallet(self, wallet_id: str) -> dict[str, Any]:
        """``GET /v1/wallets/{id}`` — read-only (owner_id / policy_ids / address)."""
        return self._call("GET", f"/v1/wallets/{wallet_id}", None)
