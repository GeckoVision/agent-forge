"""``python -m gorilla`` — subcommand dispatch: ``watch`` (default) + ``demo``.

Thin transport: parse argv, route to the signal-first ``watch`` stream or the offline ``demo``
smoke. All the logic lives in the package (``watch`` / ``agent.demo``); this only wires the CLI.

A bare ``python -m gorilla`` runs **live watch** — the real operating mode. It used to run the
offline ``demo``, which meant the default invocation printed a SYNTHETIC market and "signed"
bets that were never transactions. The offline smoke is still available as an explicit
``demo``, because the falsifiable offline simulation is worth keeping (Pattern B) — it just
must not be what you get by accident.
"""

from __future__ import annotations

import argparse
import sys
from collections.abc import Sequence
from typing import TextIO

from .agent import demo
from .watch import add_watch_arguments, run_watch_command


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="gorilla",
        description="Gorilla Markets — live sharp-money signals on real World Cup odds.",
    )
    sub = parser.add_subparsers(dest="command")
    watch_cmd = sub.add_parser(
        "watch", help="stream the REAL odds feed and flag sharp-money line moves (default)"
    )
    add_watch_arguments(watch_cmd)
    sub.add_parser(
        "demo",
        help="SYNTHETIC $0 offline smoke of the agent core — no real odds, no chain (dev only)",
    )
    return parser


def main(argv: Sequence[str] | None = None, *, out: TextIO = sys.stdout) -> int:
    """Entry point for ``python -m gorilla [watch|demo] [...]``.

    A bare invocation (or ``watch``) streams the LIVE feed — the real operating mode. ``demo``
    is the explicit, clearly-labelled synthetic offline smoke. ``out`` is injectable so the
    ``watch`` path is testable to a buffer; the ``demo`` path prints to stdout.
    """
    parser = _build_parser()
    args = parser.parse_args(argv)
    if args.command == "demo":
        return demo()
    if args.command is None:
        # A bare invocation is a live watch with the defaults — never the synthetic path.
        args = parser.parse_args(["watch"])
    return run_watch_command(args, out=out)
