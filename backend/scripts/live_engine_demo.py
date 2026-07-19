"""Many real devnet transactions through the DEPLOYED settlement engine.

For each harvested TxLINE proof (a real settled World Cup fixture), run the full
loop against the live programs: create_market -> stake YES -> stake NO ->
settle (CPI into the engine, F1-bound) -> winner claims. Every predicate/period
is derived from the proof, so F1 passes by construction and the settle actually
completes on-chain. Explorer links printed for each.

    cd backend && PYTHONPATH=. .venv/bin/python scripts/live_engine_demo.py --count 5

DEVNET ONLY. Faucet SOL. The funder is the deploy authority.
"""

import argparse
import json
from pathlib import Path

from gorilla.forge_client import market_pda
from gorilla.settlement import SettlementError, run_settlement
from gorilla.solana_rpc import SolanaRpc
from gorilla.wallets import LocalDevnetWallet, load_keypair, load_or_create_keypair
from gorilla.wallets import ChainPolicy  # noqa: F401  (policy types live here)
from solders.keypair import Keypair  # noqa: F401

_HERE = Path(__file__).resolve().parent
FUNDER_KEY = _HERE.parent.parent / "program" / ".deploy-keys" / "deploy-authority.json"
KEYS_DIR = _HERE / "keys"
HARVEST = Path(
    "/home/nan/PycharmProjects/Gecko/sharp-detector/data/txodds-history/proofs/harvest.jsonl"
)


def _policy(purposes, cap):
    from gorilla.staking import chain_policy

    return chain_policy(cap_sol=cap, purposes=frozenset(purposes))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--count", type=int, default=5)
    ap.add_argument("--yes-sol", type=float, default=0.01)
    ap.add_argument("--no-sol", type=float, default=0.005)
    args = ap.parse_args()

    rpc = SolanaRpc()
    funder_kp = load_keypair(str(FUNDER_KEY))
    print(f"funder (authority): {funder_kp.pubkey()}  {rpc.get_balance(str(funder_kp.pubkey())) / 1e9:.3f} SOL\n")

    proofs = [json.loads(line) for line in open(HARVEST)]
    done = 0
    settled_links = []
    for rec in proofs:
        if done >= args.count:
            break
        fixture_id, stat_key, proof = rec["fixtureId"], rec["statKey"], rec["proof"]
        market, _ = market_pda(fixture_id, stat_key)
        # skip a fixture/stat that already has a market (PDA init would fail)
        if rpc._call("getAccountInfo", [str(market), {"encoding": "base64"}])["value"]:
            continue

        yes_kp = load_or_create_keypair(KEYS_DIR / f"live-yes-{fixture_id}-{stat_key}.json")
        no_kp = load_or_create_keypair(KEYS_DIR / f"live-no-{fixture_id}-{stat_key}.json")
        from gorilla.wallets import fund_if_low

        for kp, target in ((yes_kp, args.yes_sol + 0.02), (no_kp, args.no_sol + 0.02)):
            fund_if_low(rpc, funder_kp, kp.pubkey(), target)

        funder = LocalDevnetWallet(keypair=funder_kp, rpc=rpc)
        funder.authorize(_policy({"create-market", "settle"}, 1.0))
        yes = LocalDevnetWallet(keypair=yes_kp, rpc=rpc)
        yes.authorize(_policy({"place-bet", "claim"}, args.yes_sol))
        no = LocalDevnetWallet(keypair=no_kp, rpc=rpc)
        no.authorize(_policy({"place-bet", "claim"}, args.no_sol))

        print(f"── fixture {fixture_id} · stat {stat_key} · value {proof['statToProve']['value']} ──")
        try:
            result = run_settlement(
                rpc=rpc,
                funder=funder,
                staker_yes=yes,
                staker_no=no,
                fixture_id=fixture_id,
                stat_key=stat_key,
                proof=proof,
                yes_sol=args.yes_sol,
                no_sol=args.no_sol,
            )
        except SettlementError as e:
            print(f"   settle rejected (fail-closed): {str(e)[:120]}\n")
            continue
        print(f"   SETTLED · market {result.market} · winner {result.winner}")
        for label, link in result.explorer_links().items():
            print(f"     {label:13s} {link}")
        settled_links.append((fixture_id, stat_key, result.market, result.explorer_links()))
        done += 1
        print()

    print(f"\n=== {done} markets settled end-to-end through the engine ===")
    print(f"funder balance now: {rpc.get_balance(str(funder_kp.pubkey())) / 1e9:.3f} SOL")
    # dump a machine-readable summary for the frontend seam / submission
    out = _HERE / "live-engine-settlements.json"
    json.dump(
        [
            {"fixtureId": f, "statKey": s, "market": m, "links": links}
            for (f, s, m, links) in settled_links
        ],
        open(out, "w"),
        indent=1,
    )
    print(f"summary written: {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
