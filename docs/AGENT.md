# Gorilla — the autonomous agent (Trading Tools & Agents track)

**Live app:** https://gorilla-app-opal.vercel.app/ · **Repo:** https://github.com/GeckoVision/gorilla-app · **Network:** Solana devnet

An autonomous agent that watches live TxLINE odds, flags a significant line
move, and stakes on-chain **within a spend cap it cannot exceed** — never
holding your keys. It logs every signal and grades it against the settled
result, and it **refuses to claim an edge the data cannot support**.

## What it does (the running agent)

- **Watches** the TxLINE odds feed tick by tick and detects a line move —
  a shift in a price line's implied probability past a threshold (default 3.0pp)
  in a single update. `backend/gorilla/detector.py` (`SharpDetector`).
- **Decides** a bet from the move (momentum-follow, one deterministic rule) —
  `backend/gorilla/decision.py`.
- **Signs within a custody policy it cannot break** — the agent proposes a
  `BetIntent`; a separate wallet (`backend/gorilla/wallets.py`) signs it only
  inside a spend cap + a program allow-list, and refuses anything out of policy
  before a signature exists. The agent never holds the keys.
- **Stakes on-chain, on its own** — no human clicks approve. Run it with
  `python -m gorilla watch --live --act` (`backend/gorilla/watch.py`). It placed
  a real devnet stake during a live World Cup match this hackathon
  (tx `62SYrYer…vjZe`, fixture France v England).
- **Settles trustlessly** — the market settles by CPI into TxLINE's
  `validate_stat` (see [`SETTLEMENT.md`](SETTLEMENT.md) and
  [`SETTLEMENT-ENGINE.md`](SETTLEMENT-ENGINE.md)); the deployed engine is
  `9S6SwSp5ShrDV7NLhtUCqttHTgXTPp7PCNuWuSeHjEjT`.

Determinism + production-readiness: the detector and decision rule are pure and
deterministic; the custody policy is enforced by a wallet seam the agent cannot
bypass; settlement is fail-closed (a tampered proof reverts).

---

# Exhibit: the honest backtest

> The track asks whether the agent "logs the signal and tracks whether it
> predicted the outcome." It does — and goes further: **it refuses to claim an
> edge the data cannot support, and it once proved its own best result wrong.**

## The loop

Every signal the *shipped* detector fires is graded at the odds quoted the
moment it fired, against the settled match result. No strategy simulation, no
re-implementation — the same detector code that runs in the agent
(`backend/gorilla/detector.py`) is the code under test. Grading is deliberately
generous (no slippage, no size limits): an **upper bound** on any edge, never a
realistic return.

## The falsification — read this part first

The first full run produced a confident verdict: *NOT ACCURATE, anti-predictive,
ROI −21% over 145k bets.* **We withdrew it.** Investigating one suspicious chart
revealed that the detector's market key omitted `MarketPeriod`, so full-match
and first-half odds lines shared one key — and their interleaving *read as price
movement*. On one real fixture, 1,623 of 4,172 "sharp moves" were artifacts;
corpus-wide, **99.93% of measured signals were phantoms** (267,746 → 176). The
verdict had graded a bug, not a strategy. We fixed the key, re-ran everything,
and hardened the framework so the same class of error cannot silently pass
again. An agent that can prove itself wrong is the only kind whose claims mean
anything.

## The verdict today

| Slice | Decisive bets | ROI | 95% CI | Verdict |
|---|---|---|---|---|
| All markets | 41 | +2.1% | −29.7% … +37.0% (67pp wide) | **INCONCLUSIVE** |
| 1x2 only | 5 | +18.1% | −100% … +189% | **INCONCLUSIVE** |

That 67-point interval is simultaneously consistent with a strategy that loses a
third of every stake and one that returns a third on every stake. An estimate
that cannot tell those apart supports no verdict — so the framework refuses to
give one. Reaching a 10-point interval needs ~1,800 decisive bets ≈ **2,500
settled fixtures** — roughly 39 World Cups. That is a data-sourcing problem, not
a compute problem, and we say so instead of pretending otherwise.

**Verdict rules (two independent gates):** below 30 decisive bets → no verdict,
ever. A CI wider than 10pp *while straddling zero* → no verdict (a wide CI that
excludes zero has already answered the question — pinned by a test, after a
width-only gate wrongly suppressed a planted-signal world).

## What we do NOT claim

- We do **not** claim the agent is profitable. (n=41, CI straddles zero.)
- We do **not** claim it is unprofitable. (Same interval.)
- We do **not** claim "sharp money detection" on this data — the feed is a
  single de-margined fair-price book; there is no sharp-vs-public divergence in
  it to detect. What the detector honestly measures is **line movement**.

## Reproducibility

The detector under test lives in this public repo
(`backend/gorilla/detector.py`). The full backtest harness + the collected
TxODDS history it runs on live in a companion repo (private during the
hackathon — available to judges on request); its falsifiability is pinned by two
synthetic worlds enforced offline at $0: a **noise** world must never read
ACCURATE, and a **planted-signal** world must be surfaced. That pair is what
makes the framework's "INCONCLUSIVE" trustworthy rather than convenient.
