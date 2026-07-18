#!/usr/bin/env python
"""Regenerate the /agent page's data artifacts from the real capture + the real policy.

Thin wrapper — all logic is in :mod:`gorilla.web_export`.

    uv run python scripts/export_web_artifacts.py --fixture 18257865

Writes ``frontend/data/agent-replay.json`` and ``frontend/data/agent-policy.json``.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from gorilla.web_export import ExportError, write_artifacts  # noqa: E402

# The fixture the agent actually staked on, on devnet.
DEFAULT_FIXTURE = 18257865
DEFAULT_OUT = Path(__file__).resolve().parents[2] / "frontend" / "data"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fixture", type=int, default=DEFAULT_FIXTURE)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--history", default=None, help="path to the TxODDS capture")
    args = parser.parse_args()

    try:
        written = write_artifacts(args.out, fixture_id=args.fixture, path=args.history)
    except ExportError as exc:
        print(f"export failed: {exc}", file=sys.stderr)
        return 1
    for name, path in written.items():
        print(f"wrote {name} -> {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
