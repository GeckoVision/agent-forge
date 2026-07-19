# Gorilla — hackathon submission

**Track:** Prediction Markets and Settlement (TxODDS · Superteam) · **Network:** Solana devnet

**Live app:** https://gorilla-app-opal.vercel.app/ · **Repo:** https://github.com/GeckoVision/gorilla-app

---

## What it is

Gorilla is a **no-house prediction market for sports, settled on-chain by
proof**. You back an outcome against another person — the stakes sit in a Solana
program neither side controls, and when the match ends the winner is decided by
a cryptographic proof of the real result from TxLINE (a CPI into
`validate_stat`), not by any operator or vote.

Settlement is a **reusable on-chain engine** that binds every result to its
exact fixture, stat and period, so it can't be gamed. Our betting market is its
first consumer; a **parametric-insurance program** is a second — the same engine
settling a structurally different product. An optional autonomous agent watches
the odds and can place a bet within a spend cap it cannot exceed, never holding
your keys.

## Why it matters

Every bet has a settlement, and that's where value leaks: the old bookie stalls
or limits you; newer price-settled markets can be pushed at the last second
(measured, 2026 — [arXiv:2606.31675](https://arxiv.org/abs/2606.31675)). Gorilla
settles on the one thing nobody can move — the final score — verified by proof,
decided by no one.

## The settlement engine (the track's topic)

`settlement-core` is a standalone program any contract can CPI to resolve a
predicate against a TxLINE proof:

- **One call** — a consumer passes a declared query (fixture, stat, period,
  condition) + the proof; gets back a verified `Ok(true)`/`Ok(false)`, or a
  revert on a tampered proof. It re-implements no verification logic.
- **Safety built in** — the four fixture/stat/period/single-stat binding checks
  live *inside* the engine, so a consumer physically cannot settle a
  genuine-but-different result. Fail-closed: a faked proof pays nobody.
- **Reuse, proven** — a betting market and a parametric-insurance policy both
  settle through the same engine. **18/18 Mollusk tests**, including a
  tampered-proof revert on *each* consumer.
- **Permissionless** — `settle` has no signer gate; the winner settles
  themselves. No trusted keeper.

The engine adds no cryptographic trust over TxLINE's oracle — its value is the
forced binding every consumer inherits and one audited deployment.

## TxLINE endpoints used

- `GET /api/fixtures/snapshot` — fixtures
- `GET /api/odds/snapshot/{fixtureId}`, `GET /api/odds/updates/{fixtureId}` — odds
- `GET /api/scores/snapshot/{fixtureId}` — scores
- **`GET /api/scores/stat-validation`** — the three-stage Merkle proof (the
  settlement primitive; CPI'd into `validate_stat`)
- `GET /api/odds/stream`, `GET /api/scores/stream` — SSE (captured)

## How to run / verify

- **App:** https://gorilla-app-opal.vercel.app/ — open a market, stake, see the
  proof-backed settlement and claim.
- **The engine, in one command** (in-process SVM, offline, $0):
  ```
  cd program && SBF_OUT_DIR="$(pwd)/target/deploy" cargo test -p forge-markets-tests   # 18 passed
  ```
- **Tx-by-tx walkthrough of a real settled market:** [`docs/SETTLEMENT.md`](docs/SETTLEMENT.md)
- **How to test the transactions (three rings):** [`docs/TESTING.md`](docs/TESTING.md)
- **Engine design & rationale:** [`docs/SETTLEMENT-ENGINE.md`](docs/SETTLEMENT-ENGINE.md)

## Honest scope

Live on **devnet** — faucet SOL, no real money. Mainnet is a deliberate,
regulated decision, not a demo. The agent's autonomy and the trustless
settlement are what's built; whether the agent's strategy is profitable is an
open question we don't have the sample to claim.

## Feedback on the TxLINE API

**Liked most:** the scores-validation endpoint returning a real Merkle proof we
could CPI on-chain (`validate_stat`) — trustless result verification with no
external oracle. It held all three ways against your production mainnet oracle
in a read-only test (true→true, false→false, tampered→revert).

**Friction:**
1. The proof's `ts` argument must be `summary.updateStats.minTimestamp`, not the
   proof's top-level `ts` — a mismatch throws error 6010.
2. The daily-roots PDA is seeded from that same `minTimestamp`'s epoch-day — not
   obvious from the docs.
3. `MarketParameters`/`MarketPeriod` arrive as the string `"None"` in some
   payloads and `null` on the wire — a normalization trap that collapsed
   full-match and first-half lines into one until we keyed on the period.
4. The feed drops the connection without a `User-Agent` header.
5. Stat keys are integers (1 = Participant1 score, 2 = Participant2) — a
   name→key map in the response would help.
6. Access is time-windowed — historical fixtures 403 after the window.

Net: the settlement primitive is the standout; the friction was all in getting
the exact proof arguments right the first time.
