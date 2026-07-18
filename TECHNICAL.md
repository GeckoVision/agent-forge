# Gorilla Markets — Technical Documentation

## Core idea

Trustless **agent-settled** prediction markets on Solana. Autonomous agents read live **TxLINE** World Cup odds, detect sharp moves, and place bets — and every market settles by **TxODDS's own on-chain Merkle proof**: the program never calls the result. Each agent signs only inside a policy it physically cannot exceed.

Two problems, both solved and proven on devnet:
1. **Trustless settlement** — no admin/resolver decides the outcome; a cryptographic proof does, and a tampered proof reverts.
2. **Safe agent delegation** — the agent can bet on your behalf but can't drain you.

## Technical highlights

- **Trustless settlement via CPI.** `forge_markets.settle` does a CPI into TxODDS's `txoracle::validate_stat`, which verifies a 3‑stage Merkle proof against its own on-chain daily root and evaluates the market's predicate, returning `Ok(bool)`. The program records the returned winner (YES *or* NO) and pays the matching side; a tampered proof fails the CPI, which reverts `settle`. Decoding failures **fail closed** — the program never mispays.
- **Policy-gated agent custody.** A `WalletSeam` lets the agent sign through either a local keypair or a **Privy TEE server-wallet** whose enclave enforces an on-chain signing policy (a max‑SOL cap + a program allow‑list). An over‑cap transaction is refused *before a signature exists* (verified: `400 policy_violation`). Belt (client-side risk cap) + braces (enclave-enforced cap).
- **Mainnet-rehearsed.** The full loop is profiled against a Solana **mainnet fork** (Surfpool) with a CPI into TxODDS's *live mainnet* oracle — proven correct under mainnet parameters (CU/fees/rent) before any real transaction, which never broadcasts.
- **Production metadata.** On-chain IDL (auto-decodable by explorers) + an embedded `security.txt`.

## TxLINE / TxODDS integration — endpoints used

**TxLINE odds feed (real-time data the agent ingests):**
- `GET https://txline.txodds.com/api/odds/snapshot/{fixtureId}` — operation `getApiOddsSnapshotFixtureid`: a normalised odds snapshot per fixture. The agent reads this (recorded/$0 offline, or live via the two-token subscription session) to build a typed `OddsSnapshot`.
- `GET .../api/odds/updates/{fixtureId}` — operation `getApiOddsUpdatesFixtureid`: streamed updates for polling a moving market.

**TxODDS `txoracle` (on-chain program, CPI'd by `settle`):**
- Instruction: **`validate_stat`** — verifies a 3-stage Merkle proof (fixture summary + proof path) against the `daily_scores_roots` PDA and evaluates the market's stored predicate.
- Root PDA: seeds `["daily_scores_roots", u16_le(epochDay)]`, where `epochDay = floor(minTimestamp / 86_400_000)`.
- Program ids: **devnet** `6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J` · **mainnet** `9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA` (the recorded World-Cup proof is valid on both — TxODDS publishes the same daily roots cross-cluster).

## Architecture

| Layer | Path | Role |
|---|---|---|
| On-chain | `program/` | `forge_markets` (Anchor 1.0): `create_market` / `stake` / `settle` / `claim`. `settle` CPIs the oracle; a bad proof reverts. |
| Agent | `backend/gorilla/` | feed → detector → decision (risk policy) → policy-gated wallet → settle-by-proof → claim. Live by default; real captured history is the fallback. |
| Frontend | `frontend/` | Next.js + shadcn/ui. The **Merkle-proof viewer** visualizes settlement: the proof folding up into TxODDS's committed on-chain root. |

## Deployed (devnet)

- `forge_markets` program: `7Pvo6SEh1zBa1Euvj5QQ4td9GpfsQosTpxhqwWtWUFt6`
- On-chain IDL account: `AB8Vg1x6XEAUhVcSwELejjzaqoKTsGd1jj6n6NKB6jXc`
- Example settled market (winner = Yes, real World-Cup proof): `3urJkTFSAf6QXLU6QvkbbS4GjLn3Tos8VQjKgGmRrVL8`

## Run it

```bash
cd backend && uv sync && uv run pytest         # 169 tests, offline, $0
uv run python -m gorilla                       # LIVE: real World Cup odds + real detector
uv run python -m gorilla watch --act           # + a REAL policy-gated devnet stake
cd ../frontend && pnpm install && pnpm dev     # the UI on devnet
```

The live path needs a TxODDS session at `~/.gecko/txodds-session.json` and, for `--act`, a
funded devnet keypair at `~/.gecko/wallets/gecko-dev.json` (override with
`GORILLA_TXODDS_SESSION` / `GORILLA_DEVNET_KEYPAIR`). The captured-history fallback is
located by `GORILLA_TXODDS_HISTORY`. **Devnet only** — a mainnet RPC is refused.
