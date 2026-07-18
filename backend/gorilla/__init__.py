"""Gorilla Markets — the offline core of the single prediction agent.

Read verifiable World Cup odds -> detect a sharp move -> decide a policy-bounded bet ->
sign it through a pluggable, policy-gated wallet seam. Deterministic and falsifiable offline
($0, no key, no network); the on-chain chunk swaps the transport edge (a live feed + a Privy
wallet) behind the same seams.

The public surface is re-exported here so consumers (and the on-chain chunk) import from one
place: ``from gorilla import BetIntent, WalletSeam, TxlineFeed`` and friends.
"""

from __future__ import annotations

from .agent import AgentRun, RefusedBet, SignedBet, run_agent, to_tx_intent
from .decision import BetIntent, RiskPolicy, Side, decide
from .detector import OddsSnapshot, PriceQuote, SharpDetector, SharpMove
from .txline_feed import TxlineFeed, replay
from .wallet import (
    Policy,
    PolicyViolation,
    SandboxWallet,
    SignResult,
    TxIntent,
    WalletSeam,
)

__all__ = [
    # feed
    "TxlineFeed",
    "replay",
    "OddsSnapshot",
    "PriceQuote",
    # detection
    "SharpDetector",
    "SharpMove",
    # decision
    "decide",
    "BetIntent",
    "RiskPolicy",
    "Side",
    # wallet seam
    "WalletSeam",
    "Policy",
    "TxIntent",
    "SignResult",
    "SandboxWallet",
    "PolicyViolation",
    # agent loop
    "run_agent",
    "to_tx_intent",
    "AgentRun",
    "SignedBet",
    "RefusedBet",
]
