"""M9 (Privy custody) — the settlement loop with the AGENT wallet signing in Privy's TEE.

Same loop as ``e2e_settlement.py``, but the market authority + YES agent is the provisioned Privy
server-wallet (custody key non-exportable, policy enforced in the enclave). It signs create_market
-> stake YES -> settle -> claim through Privy's signAndSendTransaction; a throwaway LOCAL keypair
is only the NO counterparty (funding the other side of the pot). This proves live enclave custody
through the whole loop, behind the SAME WalletSeam the offline core uses.

DEVNET-ONLY. Reuses the client-side ``ChainPolicy`` floor (cap + program/instruction allow-list +
discriminator check) AND the server-side Privy policy attached by ``scripts/privy_setup.py``.

    PYTHONPATH=. uv run python scripts/e2e_settlement_privy.py --nonce 7
"""

from __future__ import annotations

import argparse
from pathlib import Path

from gorilla.forge_client import load_recorded_proof
from gorilla.settlement import FORGE_BINDINGS, SettlementResult, run_settlement
from gorilla.solana_rpc import SolanaRpc
from gorilla.wallets import (
    ChainPolicy,
    LocalDevnetWallet,
    PrivyWallet,
    fund_if_low,
    load_keypair,
    load_or_create_keypair,
)

_HERE = Path(__file__).resolve().parent
FUNDER_KEY = _HERE.parent.parent / "program" / ".deploy-keys" / "deploy-authority.json"
PROOF_PATH = _HERE / "fixtures" / "recorded_stat_proof.json"
KEYS_DIR = _HERE / "keys"  # gitignored (**/keys/)

BASE_FIXTURE_ID = 18179549
STAT_KEY = 1


def _policy(purposes: set[str], cap: float) -> ChainPolicy:
    return ChainPolicy(
        max_spend=cap,
        allowed_purposes=frozenset(purposes),
        bindings={p: FORGE_BINDINGS[p] for p in purposes},
    )


def main() -> int:
    ap = argparse.ArgumentParser(description="Live devnet settlement e2e under Privy custody.")
    ap.add_argument(
        "--nonce", type=int, default=0, help="offset the market fixture_id for a re-run"
    )
    ap.add_argument("--yes-sol", type=float, default=0.01, help="YES stake (devnet SOL)")
    ap.add_argument("--no-sol", type=float, default=0.005, help="NO stake (devnet SOL)")
    args = ap.parse_args()

    fixture_id = BASE_FIXTURE_ID + args.nonce
    rule = "=" * 78
    print(rule)
    print("Gorilla — settlement loop under Privy enclave custody (devnet, real TxODDS proof)")
    print(rule)

    rpc = SolanaRpc()
    proof = load_recorded_proof(PROOF_PATH)

    # The Privy server-wallet is the authority + YES agent: it signs create/stake/settle/claim in
    # the TEE. One object plays both run_settlement roles (funder + staker_yes).
    agent = PrivyWallet.from_env(rpc)
    agent.authorize(_policy({"create-market", "place-bet", "settle", "claim"}, cap=1.0))
    agent_bal = rpc.get_balance(str(agent.pubkey)) / 1e9
    print(f"agent (Privy TEE)    : {agent.pubkey}  {agent_bal:.4f} SOL  [wallet {agent.wallet_id}]")
    if agent_bal < args.yes_sol + 0.05:
        print(f"BLOCKED: Privy wallet underfunded ({agent_bal:.4f} SOL); fund it on devnet first.")
        return 1

    # The NO counterparty is a throwaway LOCAL key, funded from the deploy authority (setup only).
    funder_kp = load_keypair(FUNDER_KEY)
    staker_no_kp = load_or_create_keypair(KEYS_DIR / "staker-no-keypair.json")
    fund_if_low(rpc, funder_kp, staker_no_kp.pubkey(), args.no_sol + 0.02)
    no = LocalDevnetWallet(keypair=staker_no_kp, rpc=rpc)
    no.authorize(_policy({"place-bet", "claim"}, cap=args.no_sol))
    print(f"counterparty (local) : {staker_no_kp.pubkey()}  (NO side)")
    print(
        f"market fixture/stat  : {fixture_id} / {STAT_KEY}  (proof fixture "
        f"{proof['summary']['fixtureId']})\n"
    )

    result: SettlementResult = run_settlement(
        rpc=rpc,
        funder=agent,  # Privy: create_market + settle (authority)
        staker_yes=agent,  # Privy: stake YES + claim (the agent's bet, signed in the TEE)
        staker_no=no,  # local counterparty: stake NO
        fixture_id=fixture_id,
        stat_key=STAT_KEY,
        proof=proof,
        yes_sol=args.yes_sol,
        no_sol=args.no_sol,
    )

    print("\n" + rule)
    print(f"SETTLED under Privy custody · market {result.market}")
    print(
        f"  winner = {result.winner}  state = {result.state}  "
        f"pot = {(result.stake_yes + result.stake_no) / 1e9:g} SOL"
    )
    print("  every YES-side signature came from the Privy enclave; explorer links:")
    for label, link in result.explorer_links().items():
        print(f"    {label:13s} {link}")
    print(rule)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
