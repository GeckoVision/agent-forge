"""``python -m gorilla`` — subcommand dispatch: ``demo`` (default) + ``watch``.

Thin transport: parse argv, route to the offline ``demo`` smoke or the signal-first ``watch``
stream. All the logic lives in the package (``agent.demo`` / ``watch``); this only wires the CLI.
A bare ``python -m gorilla`` still runs the demo — the original behavior — so ``watch`` is
purely additive.
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
        description="Gorilla Markets — the offline agent core and its live signal stream.",
    )
    sub = parser.add_subparsers(dest="command")
    sub.add_parser(
        "demo", help="the $0 offline smoke of the agent core (read → detect → decide → sign)"
    )
    watch_cmd = sub.add_parser(
        "watch", help="stream the odds feed and flag sharp-money line moves as live signals"
    )
    add_watch_arguments(watch_cmd)
    return parser


def main(argv: Sequence[str] | None = None, *, out: TextIO = sys.stdout) -> int:
    """Entry point for ``python -m gorilla [demo|watch] [...]``.

    A bare invocation (or ``demo``) runs the offline smoke, preserving the original behavior;
    ``watch`` streams live sharp-money signals ($0 / offline by default). ``out`` is injectable so
    the ``watch`` path is testable to a buffer; the ``demo`` path prints to stdout as before.
    """
    parser = _build_parser()
    args = parser.parse_args(argv)
    if args.command == "watch":
        return run_watch_command(args, out=out)
    # Default (no subcommand) and explicit ``demo`` run the offline smoke.
    return demo()
