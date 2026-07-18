"""Profile the full on-chain loop against a Surfpool MAINNET FORK — no broadcast.

Surfpool (`surfpool start --network mainnet`) forks Solana mainnet locally: real mainnet
accounts (the TxODDS oracle + its daily-roots) are pulled on demand, transactions execute
against mainnet parameters, and NOTHING touches real mainnet. This script rehearses the
loop the founder will later broadcast, and reports the compute units + fees + rent each
instruction costs under those parameters:

    create_market -> stake(Yes) -> stake(No) -> settle -> claim

`settle` CPIs the REAL TxODDS mainnet oracle (9ExbZ...): the program is deployed to the fork
from the `mainnet-oracle` build, and the recorded World-Cup proof verifies against the real
mainnet on-chain root (TxODDS publishes the identical roots to devnet + mainnet), so the
CPI returns Ok(true) and the market settles Yes — the true mainnet settle cost, measured.

`surfnet_profileTransaction` behaves like `sendTransaction` (it EXECUTES + commits on the
fork) and returns per-instruction compute units + pre/post account snapshots. Signing fork
transactions is safe — the fork is not real mainnet. Prereqs: a running fork with
`forge_markets` (mainnet-oracle build) deployed and the authority funded — see
scripts/surfpool_rehearse.sh.

    GORILLA_TXORACLE_ID=9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA \
        uv run python scripts/profile_surfpool.py
"""

from __future__ import annotations

import base64
import json
import math
import os
import sys
import time
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any

# The fork is the TxODDS mainnet oracle rehearsal target: pin the builder to the mainnet id
# BEFORE importing gorilla (forge_client resolves the id at import). Overridable via env.
os.environ.setdefault("GORILLA_TXORACLE_ID", "9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA")

from solders.hash import Hash  # noqa: E402
from solders.keypair import Keypair  # noqa: E402
from solders.pubkey import Pubkey  # noqa: E402
from solders.transaction import Transaction  # noqa: E402

from gorilla.forge_client import (  # noqa: E402
    TXORACLE_PROGRAM_ID,
    UnsignedTx,
    claim_tx,
    create_market_tx,
    daily_scores_roots_pda,
    load_recorded_proof,
    market_pda,
    settle_tx,
    stake_tx,
    to_lamports,
    vault_pda,
    winning_predicate,
    with_priority_fee,
)

FORK_RPC = os.environ.get("FORK_RPC", "http://127.0.0.1:8899")
DEPLOY_KEYS = Path(__file__).resolve().parent.parent.parent / "program" / ".deploy-keys"
PROOF_PATH = Path(__file__).resolve().parent / "fixtures" / "recorded_stat_proof.json"
LAMPORTS_PER_SOL = 1_000_000_000
BASE_FEE_PER_SIG = 5_000  # Solana base fee, identical on devnet + mainnet

if "mainnet-beta" in FORK_RPC or "api.mainnet" in FORK_RPC:
    raise SystemExit("REFUSING: FORK_RPC must be a LOCAL surfpool fork, never real mainnet.")


def rpc(method: str, params: list[Any]) -> Any:
    req = urllib.request.Request(
        FORK_RPC,
        data=json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def airdrop(pubkey: Pubkey, sol: float) -> None:
    rpc("requestAirdrop", [str(pubkey), int(sol * LAMPORTS_PER_SOL)])


def send_and_confirm(tx_b64: str) -> str:
    """Commit a tx on the FORK (surfnet_profileTransaction does NOT commit, so state is
    advanced by an actual send between profiles). Fork-only — never real mainnet."""
    res = rpc(
        "sendTransaction", [tx_b64, {"encoding": "base64", "preflightCommitment": "confirmed"}]
    )
    if "error" in res:
        raise SystemExit(f"fork send failed: {res['error']}")
    sig = res["result"]
    for _ in range(60):
        st = rpc("getSignatureStatuses", [[sig]])["result"]["value"][0]
        if st is not None:
            if st.get("err") is not None:
                raise SystemExit(f"fork tx {sig} failed: {st['err']}")
            if st.get("confirmationStatus") in ("confirmed", "finalized"):
                return sig
        time.sleep(0.5)
    raise SystemExit(f"fork tx {sig} not confirmed")


def blockhash() -> Hash:
    return Hash.from_string(
        rpc("getLatestBlockhash", [{"commitment": "confirmed"}])["result"]["value"]["blockhash"]
    )


def sign(unsigned: UnsignedTx, payer: Keypair, extra_signers: list[Keypair]) -> str:
    signers = [payer, *[s for s in extra_signers if s.pubkey() != payer.pubkey()]]
    tx = Transaction.new_signed_with_payer(
        list(unsigned.instructions), payer.pubkey(), signers, blockhash()
    )
    return base64.b64encode(bytes(tx)).decode()


_RENT_CACHE: dict[int, int] = {}


def rent_exempt_min(space: int) -> int:
    """Rent-exempt minimum for a `space`-byte account under the FORK's (mainnet) rent params —
    the SOL an account creation locks, independent of any value transferred into it."""
    if space not in _RENT_CACHE:
        _RENT_CACHE[space] = int(rpc("getMinimumBalanceForRentExemption", [space])["result"])
    return _RENT_CACHE[space]


@dataclass
class Profiled:
    name: str
    cu: int
    num_sigs: int
    err: Any
    payer_delta: int  # lamports the fee payer's balance changed by (negative = spent)
    created_spaces: dict[str, int]  # newly-created account -> its data length (bytes)
    logs: list[str]

    @property
    def base_fee(self) -> int:
        return self.num_sigs * BASE_FEE_PER_SIG

    @property
    def rent(self) -> int:
        """Locked rent = the rent-exempt minimum of every account this instruction created
        (excludes staked value that also lands in a created vault)."""
        return sum(rent_exempt_min(space) for space in self.created_spaces.values())


def profile(name: str, tx_b64: str, payer: Pubkey, num_sigs: int) -> Profiled:
    res = rpc("surfnet_profileTransaction", [tx_b64, name])
    if "error" in res:
        raise SystemExit(f"{name}: profileTransaction rpc error: {res['error']}")
    val = res["result"]["value"]
    tp = val["transactionProfile"]
    # fee payer delta ('update' carries [before, after]) + created-account sizes ('create'
    # carries a single dict — hence rent, not value) from the aggregate account snapshots.
    payer_delta = 0
    created_spaces: dict[str, int] = {}
    for pk, st in tp.get("accountStates", {}).items():
        change = st.get("accountChange")
        if not change:
            continue
        ctype = change.get("type")
        data = change.get("data")
        if ctype == "update" and isinstance(data, list) and len(data) == 2 and pk == str(payer):
            payer_delta = data[1]["lamports"] - data[0]["lamports"]
        elif ctype == "create" and isinstance(data, dict):
            enc = data.get("data") or [""]
            created_spaces[pk] = len(base64.b64decode(enc[0])) if enc[0] else 0
    return Profiled(
        name=name,
        cu=tp["computeUnitsConsumed"],
        num_sigs=num_sigs,
        err=tp.get("errorMessage"),
        payer_delta=payer_delta,
        created_spaces=created_spaces,
        logs=tp.get("logMessages") or [],
    )


def main() -> int:
    proof = load_recorded_proof(PROOF_PATH)
    fixture_id = int(proof["summary"]["fixtureId"])
    stat_key = int(proof["statToProve"]["key"])
    period = int(proof["statToProve"]["period"])
    predicate = winning_predicate(proof)

    authority = Keypair.from_bytes(bytes(json.load(open(DEPLOY_KEYS / "deploy-authority.json"))))
    staker_yes = Keypair()
    staker_no = Keypair()
    for kp in (staker_yes, staker_no):
        airdrop(kp.pubkey(), 5.0)
    airdrop(authority.pubkey(), 100.0)

    market, _ = market_pda(fixture_id, stat_key)
    if rpc("getAccountInfo", [str(market), {"encoding": "base64"}])["result"]["value"] is not None:
        raise SystemExit(
            f"market {market} already exists on the fork — restart surfpool for a clean "
            "rehearsal (profileTransaction commits state)."
        )

    yes_sol, no_sol = 0.02, 0.01
    priority = int(os.environ.get("PRIORITY_FEE_MICROLAMPORTS", "0"))

    steps = [
        (
            "create_market",
            create_market_tx(fixture_id, stat_key, predicate, period, authority.pubkey()),
            authority,
            [authority],
        ),
        (
            "stake_yes",
            stake_tx(fixture_id, stat_key, staker_yes.pubkey(), "Yes", to_lamports(yes_sol)),
            staker_yes,
            [staker_yes],
        ),
        (
            "stake_no",
            stake_tx(fixture_id, stat_key, staker_no.pubkey(), "No", to_lamports(no_sol)),
            staker_no,
            [staker_no],
        ),
        ("settle", settle_tx(fixture_id, stat_key, proof), authority, [authority]),
        ("claim", claim_tx(fixture_id, stat_key, staker_yes.pubkey()), staker_yes, [staker_yes]),
    ]

    root_pda, _, epoch_day = daily_scores_roots_pda(proof["summary"]["updateStats"]["minTimestamp"])
    print("=" * 78)
    print("Surfpool MAINNET-FORK profile — forge_markets loop (NO broadcast)")
    print("=" * 78)
    print(f"fork RPC        : {FORK_RPC}")
    print(f"txoracle (CPI)  : {TXORACLE_PROGRAM_ID}")
    print(f"daily-roots PDA : {root_pda}  (epoch-day {epoch_day})")
    print(f"fixture/stat    : {fixture_id}/{stat_key}   priority-fee: {priority} µlamports/CU")
    print("-" * 78)
    print(
        f"{'instruction':<14}{'CU':>9}{'base fee':>11}{'prio fee':>10}{'rent (lamports)':>18}  result"
    )

    results: list[Profiled] = []
    for name, tx, payer, signers in steps:
        tx = with_priority_fee(tx, priority)
        signed = sign(tx, payer, signers)
        # Profile against the current committed state (profileTransaction does NOT commit)...
        p = profile(name, signed, payer.pubkey(), num_sigs=1)
        results.append(p)
        prio_fee = math.ceil(_cu_limit(tx) * priority / 1_000_000) if priority else 0
        rent = p.rent
        status = "ok" if p.err is None else f"ERR {p.err}"
        print(f"{name:<14}{p.cu:>9}{p.base_fee:>11}{prio_fee:>10}{rent:>18}  {status}")
        if p.err is not None:
            print("   logs:")
            for line in p.logs[-12:]:
                print("     ", line)
            return 1
        # ...then actually send it so the NEXT step sees its state (open market, live stakes).
        send_and_confirm(signed)

    # settle correctness: the market must have settled Yes (the oracle certified the predicate).
    data = rpc("getAccountInfo", [str(market), {"encoding": "base64"}])["result"]["value"]
    from gorilla.forge_client import decode_market

    m = decode_market(base64.b64decode(data["data"][0]))
    print("-" * 78)
    print(
        f"settled market  : state={m.state} winner={m.winner} "
        f"(stake_yes={m.stake_yes} stake_no={m.stake_no})"
    )
    vault, _ = vault_pda(market)
    vbal = rpc("getBalance", [str(vault)])["result"]["value"]
    print(f"vault after claim: {vbal} lamports (0 == winner drained the pot)")
    total_cu = sum(p.cu for p in results)
    print(
        f"loop total      : {total_cu} CU   base fees {sum(p.base_fee for p in results)} lamports"
    )
    print("=" * 78)
    return 0


def _cu_limit(tx: UnsignedTx) -> int:
    """The SetComputeUnitLimit units in a tx's prelude (for the priority-fee estimate), or the
    Solana default 200k per instruction when unset."""
    from gorilla.forge_client import COMPUTE_BUDGET_ID

    for ix in tx.instructions:
        if ix.program_id == COMPUTE_BUDGET_ID and ix.data and ix.data[0] == 2:
            return int.from_bytes(bytes(ix.data[1:5]), "little")
    return 200_000 * sum(1 for ix in tx.instructions if ix.program_id != COMPUTE_BUDGET_ID)


if __name__ == "__main__":
    sys.exit(main())
