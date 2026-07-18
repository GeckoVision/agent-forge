"""The Gorilla single agent — read odds, detect a sharp move, decide a bet, sign it.

Deterministic and offline. The loop takes a sequence of ``OddsSnapshot`` readings (from the
feed's offline ``replay`` or, live, repeated ``TxlineFeed.odds`` polls), runs the detector,
turns each flagged move into a policy-bounded ``BetIntent`` via ``decide``, and hands it to
the injected ``WalletSeam`` to sign within the custody policy. Two independent bounds hold:
the risk policy sizes the bet; the wallet refuses anything past its spend cap or off its
purpose allow-list. Nothing here holds keys or reaches the network.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from typing import TYPE_CHECKING

from .decision import BetIntent, RiskPolicy, decide
from .detector import OddsSnapshot, SharpDetector
from .wallet import PolicyViolation, SignResult, TxIntent, WalletSeam

if TYPE_CHECKING:
    from .forge_client import UnsignedTx

# The purpose a bet is signed under — must be in the wallet ``Policy`` allow-list. Named once
# here so the agent and any wallet policy agree on the allow-list key.
BET_PURPOSE = "place-bet"


def to_tx_intent(bet: BetIntent, *, unsigned_tx: "UnsignedTx | None" = None) -> TxIntent:
    """Map a trading ``BetIntent`` onto the generic ``TxIntent`` the wallet signs — the
    boundary between the trading rule and the custody gate. ``purpose`` (the allow-list key)
    is ``BET_PURPOSE``; ``amount`` is the stake the spend cap is checked against.

    ``unsigned_tx`` is the on-chain extension: pass the built ``forge_markets`` stake
    transaction and the on-chain wallet signs it; omit it and the intent is the offline shape
    the ``SandboxWallet`` signs. Either way the custody purpose is the same key."""
    return TxIntent(
        purpose=BET_PURPOSE,
        amount=bet.amount,
        description=f"place {bet.side} bet on {bet.market} (fixture {bet.fixture_id})",
        unsigned_tx=unsigned_tx,
    )


@dataclass(frozen=True)
class SignedBet:
    """A bet the wallet signed within policy."""

    intent: BetIntent
    result: SignResult


@dataclass(frozen=True)
class RefusedBet:
    """A bet the wallet refused — the custody bound holding (over cap / off allow-list)."""

    intent: BetIntent
    reason: str


@dataclass(frozen=True)
class AgentRun:
    """The offline loop's product — signed bets, wallet refusals, and per-fixture exposure
    (the seed of the on-chain leaderboard the settle chunk fills in)."""

    signed: tuple[SignedBet, ...]
    refused: tuple[RefusedBet, ...]
    exposure: Mapping[int, float]


def run_agent(
    snapshots: Iterable[OddsSnapshot],
    *,
    wallet: WalletSeam,
    policy: RiskPolicy,
    threshold_pct: float = 3.0,
) -> AgentRun:
    """Run the full offline loop over ``snapshots``. For each flagged sharp move it sizes a
    bet within ``policy`` and asks ``wallet`` to sign it; a wallet refusal is recorded (never
    raised) so the loop always completes. Deterministic given deterministic inputs."""
    detector = SharpDetector(threshold_pct=threshold_pct)
    exposure: dict[int, float] = {}
    signed: list[SignedBet] = []
    refused: list[RefusedBet] = []
    for snapshot in snapshots:
        move = detector.observe(snapshot)
        if move is None:
            continue
        bet = decide(move, policy, staked_on_fixture=exposure.get(move.fixture_id, 0.0))
        if bet is None:
            continue
        try:
            result = wallet.sign_within_policy(to_tx_intent(bet))
        except PolicyViolation as exc:
            refused.append(RefusedBet(bet, str(exc)))
            continue
        exposure[bet.fixture_id] = exposure.get(bet.fixture_id, 0.0) + bet.amount
        signed.append(SignedBet(bet, result))
    return AgentRun(tuple(signed), tuple(refused), dict(exposure))


def demo() -> int:
    """$0 SYNTHETIC offline smoke: prove the odds call is first-call-correct, then run the loop
    on a scripted moving market and show the policy-gated bet. No key, no network, no chain.

    This is the Pattern-B falsifiable simulation, NOT the operating mode: the prices are
    scripted, the odds read returns schema placeholders, and the "signatures" are sandbox refs.
    For the real thing — real World Cup odds and a real devnet stake — run ``gorilla watch``.

        uv run python -m gorilla demo
    """
    from .txline_feed import TxlineFeed, replay
    from .wallet import Policy, SandboxWallet

    rule = "─" * 68
    print(f"{rule}\n  Gorilla Markets — SYNTHETIC offline core ($0, no key, no network)")
    print("  scripted prices + sandbox refs — NOT market data, NOT transactions.")
    print(f"  the real path is: python -m gorilla watch\n{rule}")

    # 1 · one real odds read, first-call-correct (recorded / $0).
    feed = TxlineFeed()
    snap = feed.odds(42)
    print(
        f"\n  1 · odds read for fixture {snap.fixture_id}: well-formed call, "
        f"{len(snap.quotes)} quote(s) (recorded placeholders offline)"
    )

    # 2 · the user authorizes ONE custody policy; the agent does the rest.
    wallet = SandboxWallet(funded_amount=100.0)
    wallet.authorize(Policy(max_spend=50.0, allowed_purposes=frozenset({BET_PURPOSE})))
    risk = RiskPolicy(max_stake=10.0, max_per_fixture=25.0)
    print("  2 · user authorized: spend ≤ 50 for {place-bet}; risk ≤ 10/bet, 25/fixture")

    # 3 · run the loop over a scripted moving market -> a signed, policy-gated bet.
    run = run_agent(replay(fixture_id=42, move_at=3), wallet=wallet, policy=risk)
    print("\n  3 · loop over the moving market:")
    for sb in run.signed:
        print(
            f"      ✓ {sb.intent.side} {sb.intent.amount:g} on {sb.intent.market}  "
            f"[{sb.result.ref}]"
        )
        print(f"        └─ {sb.intent.rationale}")
    for rb in run.refused:
        print(f"      ✗ refused {rb.intent.side} {rb.intent.amount:g}: {rb.reason}")

    print(f"\n{rule}")
    print(
        f"  {len(run.signed)} bet(s) signed within policy · exposure {dict(run.exposure)} · "
        f"{wallet.funded():g} left"
    )
    print(
        "  The user read no docs, built no transaction, held no key. The on-chain chunk "
        "swaps\n  SandboxWallet for a policy-gated Privy wallet behind the same WalletSeam.\n"
    )
    return 0
