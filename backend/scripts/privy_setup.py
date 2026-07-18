"""Founder-run Privy custody setup — attach the Solana signing policy + devnet test-sign.

DEVNET-ONLY. Thin CLI over :mod:`gorilla.privy_policy` + :mod:`gorilla.wallets`; all the
logic lives in the package. The target wallet is app-owned (``owner_id: null``), so every step
runs headless with Basic app auth — no authorization signatures. The app secret is read from
env / local ``.env`` and NEVER printed.

    # inspect only — build + print the policy, read the wallet, no mutation, no network sign:
    PYTHONPATH=. uv run python scripts/privy_setup.py --dry-run

    # the real founder step — create the policy, attach it, then a devnet test-sign:
    PYTHONPATH=. uv run python scripts/privy_setup.py

    # also prove Privy refuses an over-cap tx server-side (sends a doomed tx on devnet):
    PYTHONPATH=. uv run python scripts/privy_setup.py --prove-deny
"""

from __future__ import annotations

import argparse
import json

from gorilla.forge_client import to_lamports
from gorilla.privy_http import PrivyError, privy_creds, privy_wallet_config
from gorilla.privy_policy import (
    DEFAULT_MAX_LAMPORTS,
    PrivyControlPlane,
    build_forge_markets_policy,
)
from gorilla.solana_rpc import SolanaRpc
from gorilla.wallets import OnChainError, PrivyWallet

# Stable idempotency key: a re-run within 24h returns the same policy, never a duplicate.
IDEMPOTENCY_KEY = "gorilla-forge-markets-devnet-policy-v2"


def _explorer(sig: str) -> str:
    return f"https://explorer.solana.com/tx/{sig}?cluster=devnet"


def main() -> int:
    ap = argparse.ArgumentParser(description="Attach a Privy Solana signing policy + test-sign.")
    ap.add_argument("--dry-run", action="store_true", help="build/print policy + read wallet only")
    ap.add_argument("--force", action="store_true", help="re-create + re-attach even if attached")
    ap.add_argument("--skip-test-sign", action="store_true", help="attach only, no devnet sign")
    ap.add_argument(
        "--prove-deny", action="store_true", help="also send an over-cap tx to prove Privy DENY"
    )
    ap.add_argument("--cap-lamports", type=int, default=DEFAULT_MAX_LAMPORTS)
    args = ap.parse_args()

    rule = "=" * 78
    print(rule)
    print("Gorilla — Privy Solana custody setup (DEVNET-ONLY)")
    print(rule)

    app_id, app_secret = privy_creds()
    wallet_id, address = privy_wallet_config()
    print(f"app creds present : {bool(app_id and app_secret)}")  # never print the values
    print(f"wallet id         : {wallet_id}")
    print(f"wallet address    : {address}")
    if not (app_id and app_secret):
        print("\nBLOCKED: no PRIVY_APP_ID / PRIVY_APP_SECRET in env or backend/.env.")
        return 1

    policy = build_forge_markets_policy(cap_lamports=args.cap_lamports)
    cp = PrivyControlPlane(app_id, app_secret)

    # 0 · read-only: confirm the wallet is app-owned (headless-attachable) + current policy.
    wallet = cp.get_wallet(wallet_id)
    owner_id = wallet.get("owner_id")
    existing = wallet.get("policy_ids") or []
    print(
        f"\nwallet owner_id   : {owner_id!r}  ({'app-owned' if not owner_id else 'HAS OWNER KEY'})"
    )
    print(f"attached policies : {existing}")

    print("\npolicy to attach (per-tx cap + program allow-list):")
    print(json.dumps(policy, indent=2))

    if args.dry_run:
        print("\n--dry-run: no policy created, no wallet mutated, no tx signed.")
        return 0

    if owner_id:
        print(
            "\nNOTE: wallet has an owner key — attaching a policy needs an authorization "
            "signature (not headless). Finish in the Privy dashboard or with the owner key."
        )

    # 1 · create + attach the policy (idempotent), unless one is already attached.
    if existing and not args.force:
        policy_id = existing[0]
        print(f"\n1 · policy already attached: {policy_id}  (use --force to re-create)")
    else:
        policy_id = cp.create_policy(policy, idempotency_key=IDEMPOTENCY_KEY)
        print(f"\n1 · created policy: {policy_id}")
        cp.attach_policy(wallet_id, policy_id)
        print(f"2 · attached to wallet {wallet_id}")

    # verify the attachment stuck.
    after = cp.get_wallet(wallet_id)
    attached = after.get("policy_ids") or []
    ok = policy_id in attached
    print(f"3 · verify GET wallet.policy_ids = {attached}  -> {'OK' if ok else 'MISMATCH'}")
    if not ok:
        print("BLOCKED: policy did not attach; check the response above.")
        return 1

    if args.skip_test_sign:
        print("\n--skip-test-sign: policy attached, no devnet sign performed.")
        return 0

    # 4 · devnet test-sign through the enclave — the end-to-end proof of policy-gated signing.
    rpc = SolanaRpc()
    wallet_obj = PrivyWallet.from_env(rpc)
    bal = rpc.get_balance(address) / 1e9
    print(f"\n4 · test-sign: Privy wallet balance {bal:.4f} SOL (devnet)")
    try:
        sig = wallet_obj.test_sign_self_transfer(lamports=0)
        print(f"    signAndSendTransaction (0-lamport self-transfer) -> {sig}")
        rpc.confirm(sig)
        print(f"    CONFIRMED on devnet: {_explorer(sig)}")
    except (OnChainError, PrivyError) as exc:
        print(f"    TEST-SIGN FAILED: {exc}")
        return 1

    # 5 · (optional) prove the policy DENIES an over-cap tx server-side.
    if args.prove_deny:
        over = args.cap_lamports + to_lamports(1.0)
        print(f"\n5 · prove-deny: attempt an over-cap self-transfer ({over} lamports)")
        try:
            bad = wallet_obj.test_sign_self_transfer(lamports=over)
            print(f"    UNEXPECTEDLY SIGNED (policy NOT enforcing cap): {bad}")
            return 1
        except (OnChainError, PrivyError) as exc:
            print(f"    correctly REFUSED by Privy policy: {exc}")

    print("\n" + rule)
    print(
        "DONE: Solana signing policy attached + devnet test-sign confirmed under enclave custody."
    )
    print(rule)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
