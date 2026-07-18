"""The live staking path — a real detector signal becomes a real devnet transaction.

Where :mod:`gorilla.settlement` runs the full create -> stake -> settle -> claim loop for the
settlement demo, this is the narrow path the *watching agent* needs: make sure a market exists
for the fixture it is watching, then stake the bet its own signal produced — through the same
policy-gated :class:`~gorilla.wallets.LocalDevnetWallet`, with the same in-client cap +
program/instruction allow-list enforced BEFORE anything is signed.

DEVNET-ONLY, enforced by :class:`~gorilla.solana_rpc.SolanaRpc`. Mainnet is founder-gated and
is not reachable from any code path here: the wallet is a devnet keypair, the RPC constructor
refuses a mainnet URL, and every transaction is simulated before it is sent.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from .agent import BET_PURPOSE, to_tx_intent
from .decision import BetIntent
from .forge_client import (
    Comparison,
    TraderPredicate,
    create_market_tx,
    decode_market,
    market_pda,
    position_pda,
    stake_tx,
    to_lamports,
)
from .settlement import CREATE_PURPOSE, FORGE_BINDINGS
from .solana_rpc import SolanaRpc
from .wallet import Policy, SignResult, TxIntent
from .wallets import ChainPolicy, ChainWallet, LocalDevnetWallet, load_keypair

# The funded devnet keypair the agent signs through. A throwaway devnet key, outside the repo.
DEFAULT_KEYPAIR_PATH = Path("~/.gecko/wallets/gecko-dev.json")
KEYPAIR_PATH_ENV = "GORILLA_DEVNET_KEYPAIR"

# The stat a watch-mode market is opened against. The watch demo stakes and does not settle,
# so the predicate only has to be a real, stored, on-chain condition — not a winning one.
DEFAULT_STAT_KEY = 1
DEFAULT_PREDICATE = TraderPredicate(threshold=0, comparison=Comparison.GREATER_THAN)
DEFAULT_PERIOD = 0


class StakingError(Exception):
    """The live staking path could not complete (market unreadable, stake would revert)."""


@dataclass(frozen=True)
class LiveMarket:
    """The on-chain market a watching agent stakes into."""

    fixture_id: int
    stat_key: int
    address: str
    create_sig: str | None  # None when the market already existed (a re-run)

    def explorer(self) -> str:
        return f"https://explorer.solana.com/address/{self.address}?cluster=devnet"


def keypair_path(path: str | Path | None = None) -> Path:
    """The devnet keypair to sign with — explicit arg, ``$GORILLA_DEVNET_KEYPAIR``, or default."""
    import os

    if path is not None:
        return Path(path).expanduser()
    override = os.environ.get(KEYPAIR_PATH_ENV)
    return Path(override).expanduser() if override else DEFAULT_KEYPAIR_PATH.expanduser()


def chain_policy(*, cap_sol: float, purposes: frozenset[str]) -> ChainPolicy:
    """The policy the user authorizes once: a total spend cap AND a
    ``purpose -> (program, instruction)`` allow-list.

    Belt and braces on the real signer: the cap bounds total value, the bindings bound WHAT can
    be called, and :func:`gorilla.wallets._verify_unsigned_tx` re-checks the built transaction
    really is that call (right discriminator, no smuggled instruction, no foreign signer)."""
    return ChainPolicy(
        max_spend=cap_sol,
        allowed_purposes=purposes,
        bindings={p: FORGE_BINDINGS[p] for p in purposes},
    )


def devnet_wallet(
    *,
    rpc: SolanaRpc | None = None,
    path: str | Path | None = None,
    cap_sol: float,
    purposes: frozenset[str] = frozenset({BET_PURPOSE, CREATE_PURPOSE}),
) -> LocalDevnetWallet:
    """The REAL signer: a funded devnet ed25519 keypair behind the ``WalletSeam``, authorized
    with a :class:`ChainPolicy`. Signs and sends real devnet transactions."""
    wallet = LocalDevnetWallet(keypair=load_keypair(keypair_path(path)), rpc=rpc or SolanaRpc())
    wallet.authorize(chain_policy(cap_sol=cap_sol, purposes=purposes))
    return wallet


def ensure_market(
    *,
    rpc: SolanaRpc,
    wallet: ChainWallet,
    fixture_id: int,
    stat_key: int = DEFAULT_STAT_KEY,
    predicate: TraderPredicate = DEFAULT_PREDICATE,
    period: int = DEFAULT_PERIOD,
    log: Callable[[str], None] | None = None,
) -> LiveMarket:
    """Return the market for ``(fixture_id, stat_key)``, opening it on-chain if it is absent.

    Idempotent: a re-run against an existing OPEN market reuses it (``create_sig`` is ``None``)
    rather than failing, so watching the same fixture twice does not need a fresh nonce. A
    market that has already SETTLED cannot be staked into and raises."""
    market, _ = market_pda(fixture_id, stat_key)
    existing = rpc.get_account_data(str(market))
    if existing is not None:
        decoded = decode_market(existing)
        if decoded.state != "Open":
            raise StakingError(
                f"market {market} for fixture {fixture_id} is {decoded.state}, not Open — "
                "it cannot take a new stake"
            )
        if log:
            log(f"market {market} already open (fixture {fixture_id}, stat {stat_key})")
        return LiveMarket(fixture_id, stat_key, str(market), None)

    unsigned = create_market_tx(fixture_id, stat_key, predicate, period, wallet.pubkey)
    sig = wallet.sign_within_policy(
        TxIntent(
            CREATE_PURPOSE,
            0.0,
            f"open market for fixture {fixture_id} / stat {stat_key}",
            unsigned_tx=unsigned,
        )
    ).ref
    if log:
        log(f"opened market {market} for fixture {fixture_id}  [{sig}]")
    return LiveMarket(fixture_id, stat_key, str(market), sig)


def stake_on_bet(
    *,
    wallet: ChainWallet,
    market: LiveMarket,
    bet: BetIntent,
    rpc: SolanaRpc | None = None,
) -> SignResult:
    """Build the REAL ``forge_markets`` stake transaction for ``bet`` and have the policy-gated
    wallet sign + send it on devnet. Returns the :class:`SignResult` whose ``ref`` is a real,
    on-chain-verifiable transaction signature.

    A :class:`~gorilla.wallet.PolicyViolation` (over cap, off allow-list) propagates to the
    caller UNSIGNED — the refusal happens before any signature exists.

    When ``rpc`` is supplied the staker's position is checked FIRST: ``stake`` uses Anchor's
    ``init`` (v1 allows one position per staker per market), so a second stake into the same
    market cannot land. Catching that here reports the real reason instead of broadcasting a
    transaction that is guaranteed to fail with a bare ``AccountAlreadyInUse``."""
    amount = to_lamports(bet.amount)
    if amount <= 0:
        raise StakingError(f"stake for fixture {bet.fixture_id} rounds to zero lamports")
    if rpc is not None:
        market_key, _ = market_pda(market.fixture_id, market.stat_key)
        position, _ = position_pda(market_key, wallet.pubkey)
        if rpc.get_account_data(str(position)) is not None:
            raise StakingError(
                f"this wallet already holds a position in market {market.address} — "
                "forge_markets v1 allows ONE stake per staker per market"
            )
    unsigned = stake_tx(market.fixture_id, market.stat_key, wallet.pubkey, bet.side, amount)
    return wallet.sign_within_policy(to_tx_intent(bet, unsigned_tx=unsigned))


def authorized_purposes(policy: Policy) -> frozenset[str]:
    """The purposes a policy allows — used to report the custody bound in the run header."""
    return frozenset(policy.allowed_purposes)
