# TxLINE Settlement Engine — design & rationale

> Status: DESIGN. The "on-chain settlement engine" play for the TxODDS
> "Prediction Markets and Settlement" track. Synthesized from five independent
> engineering reviews (anchor · web3 · pinocchio · defi · solana-research),
> 2026-07-19. Deploy is founder-gated; nothing here is on-chain yet.

## The thesis, honestly stated

`forge-markets` is an app, not an engine: the trustless core (CPI into
`txoracle::validate_stat`, the F1 predicate-binding, the fail-closed
return-data decode) lives *inside* `settle_handler`, coupled to a `Market`
account. There is no instruction a second, unrelated program can CPI to get
"resolve this predicate against TxODDS." The track's whole premise —
"consumer contracts CPI into settlement" — is therefore aspirational in the
current code.

**The move:** extract that boundary into a reusable `settlement-core` (crate +
thin engine program). `forge-markets` becomes its *first consumer*, and a
second, structurally different consumer proves reuse.

**The honesty that survives an interview** (anchor + web3, independently): the
engine adds **no cryptographic trust** over CPIing `txoracle` directly —
`txoracle` is already the trust root. The engine's reason to exist is
**centralized F1-binding every consumer is forced through + one audited
deployment**. Pitch it in exactly those terms, or a sharp judge calls it
ceremony.

## Why our primitive is already strong (solana-research)

On the "trustless" axis the track judges, a Merkle proof against a signed
on-chain root **beats** both live alternatives on Solana:

- **UMA / Polymarket** — optimistic propose-and-dispute: economic bonding, a
  2-hour dispute window, "trust-minimized," not trustless. Adopting it would be
  a *downgrade* from a cryptographic guarantee to an economic one. Say this.
- **Drift BET** — a governance multisig writes the market's outcome after a
  resolution time. Committee-set, not proof-set.

We do not imitate either. But we **borrow Drift's shape** where it's better
than ours: `resolve → reduce-only window → permissionless settle crank`. Our
gap maps onto exactly the piece Drift already gets right (see Late-stake below).

## The interface

A consumer passes a **declared query** (what it thinks it's resolving) plus the
raw oracle args; gets back a verified bool or a revert. The binding is enforced
by the engine, unconditionally — a consumer physically cannot obtain an outcome
for an unbound proof:

```rust
pub struct PredicateQuery {
    pub fixture_id: i64,   // engine asserts fixture_summary.fixture_id == this
    pub stat_key:   u32,   // engine asserts stat_a.stat_to_prove.key    == this
    pub period:     i32,   // engine asserts stat_a.stat_to_prove.period == this
    pub predicate:  TraderPredicate,
}

// engine: Ok(true)=held, Ok(false)=not held, Err=tampered/undecodable → revert
pub fn resolve(ctx, query, ts, fixture_summary, fixture_proof,
               main_tree_proof, stat_a, stat_b: None, op: None) -> Result<bool>
```

The four F1 `require!`s move verbatim from `settle.rs:71-91` into `resolve`,
operating on `query` instead of a `Market`. `stat_b`/`op` are forbidden
(single-stat v1). The trust boundary, stated to a judge: *the engine guarantees
the bool corresponds to exactly the (fixture, stat, period, predicate) you
named; the consumer guarantees that tuple is its own market's.*

## What's reusable vs. Gorilla-specific

- **Reusable → engine:** all of `txoracle_cpi.rs` (already 100% market-agnostic
  — the extraction is 90% done for us), the oracle program-pin
  (`settle.rs:50`), the four F1 `require!`s, the fail-closed decode errors.
- **Gorilla-specific → stays:** `Market`/`Position`/`Side`/`MarketState`,
  create/stake/claim, pro-rata vault. Gorilla's `settle` shrinks to: read the
  market's tuple → build `PredicateQuery` → CPI the engine → map bool to `Side`
  → write. It gets *smaller*.

## The second consumer: parametric insurance (defi's pick)

Not a prop-bet (that's our market with N=2 — proves nothing). Insurance is
structurally different — fixed indemnity, asymmetric insurer/insured roles,
non-pooled release — settling on the **same** `validate_stat` proof. The
track lists it literally ("Corners A + B > 10").

`Policy` account `[b"policy", fixture_id, stat_key, insured]` + `pvault` + four
thin instructions: `open_policy` (insurer posts coverage) → `bind_policy`
(insured pays premium) → `settle_policy` (same CPI+F1 path via the engine) →
`claim_policy` (event → insured gets coverage; else insurer gets coverage +
premium; pull-payment, `invoke_signed`). ~1–2 days, settlement logic reused
verbatim. **Building it is what forces the `settlement-core` extraction** — the
reason it stops being a slide and becomes a boundary.

## The killer artifact

A Mollusk suite where **both** programs CPI the same engine double (reuse the
existing `mock-txoracle`), with a tamper-revert test on **each**. The single
test *"a program that is not `forge-markets` CPIs the engine, settles
trustlessly, and reverts on a tampered proof"* **is** the pitch — falsifiable
offline, in CI.

## The three honest calls (defi)

1. **Pari-mutuel, not AMM.** Provably solvent, zero protocol inventory risk =
   safe to reuse. AMM adds a liquidity subsidy + inventory risk and makes
   settlement *less* safe to reuse — off-thesis. Don't use an AMM to fix
   zero-counterparty; that's `lock_ts`.
2. **SOL for the sports market, USDC for insurance.** Pari-mutuel payout is a
   *ratio* — SOL's price drift between stake and settle cancels, so SOL is
   defensible. Fixed indemnity needs a stable unit. Because the core never
   touches the vault, it's **asset-agnostic**: *"one consumer escrows SOL, one
   USDC, both settle on the same proof"* — stronger than all-USDC.
3. **Zero-counterparty is a bootstrapping problem, not a settlement bug.** The
   engine correctly refuses to invent a counterparty. Fix above the engine:
   creator seeds both sides + a min-viable-market gate + `lock_ts` (which makes
   early two-sided staking rational).

## Risks to prove live, with pre-drafted answers

| Risk | Source | Answer / fix |
|---|---|---|
| **Late-stake exploit** — stakes accepted after the outcome is knowable (`stake.rs:23-26`, self-flagged) | web3, defi, research (arXiv:2606.31675 measured this on Polymarket) | `lock_ts` cutoff from the `_reserved` tail; borrow Drift's reduce-only window if time. **Cite the paper — it converts a TODO into a backed strength.** |
| **Return-data across the CPI hop** — after the engine CPIs txoracle, `get_return_data` holds txoracle's bytes; the engine's `Ok(bool)` overwrites; the consumer must read *immediately* after the engine CPI, no intervening CPI | anchor, web3 | Verify live under Mollusk/Surfpool. #1 technical risk of the extraction; cheap to prove. |
| **Fail-closed decode** must never return default/false on failure — must `Err` | anchor | Preserve `txoracle_cpi.rs:196-205` byte-for-byte. |
| **Oracle finality vs staleness** — `validate_stat` proves "value is in the daily root at `ts`", not "value is *final*"; within a period a settler could pick a not-yet-final snapshot | defi, research (Pyth/Switchboard both make staleness an explicit caller param; ours is neither, by omission) | Gate on the terminal summary (`ScoresUpdateStats.max_timestamp` past kickoff+duration). Decide explicitly whose job staleness bounding is; state it. |
| **Stranded pot / empty winning side** (`claim.rs`, `NoWinningStake`) | all | `reclaim` instruction (planned), timeout refund. |
| **`claim` transfers then sets `claimed`** | defi | Flip to checks-effects-interactions (set `claimed` *before* transfer). Trivial; satisfies the auditor reflex on sight. |
| **Admin path could swap the pinned oracle id** | research (Drift April-2026 $285M was admin-key compromise, not a math bug) | Confirm no upgrade-authority path bypasses the pin; cheap to state "we checked." |

## Compute & depth (pinocchio + research, corroborated by Solana docs)

- Depth: `consumer → engine → txoracle` = 2 hops; even `router → AMM → engine →
  txoracle` = 3, under the 4-deep ceiling. **The engine must CPI txoracle
  directly** — no intermediate helper program, or deeply-nested callers hit the
  wall.
- CU is one **shared meter** across the stack. `validate_stat` alone measured
  ~193k of the **default** 200k — but 200k is the default, not the ceiling
  (1.4M max via `SetComputeUnitLimit`). Two fixes, both production-readiness
  signals a judge looks for: **(a)** every settle/resolve tx must carry a
  `set_compute_unit_limit` instruction; **(b)** `require!` a proof-length bound
  (variable-length proof → variable CU → non-deterministic budget without it) —
  this also kills the sharpest determinism poke.
- **Ship a documented CU-cost-per-proof-depth table.** For a primitive other
  teams' programs CPI, an undocumented CU cost is a real integration blocker;
  the table is a gradeable production-readiness artifact.

## Pinocchio: NO-GO for this deadline (pinocchio-engineer)

The 193k CU lives *inside* `txoracle` — a foreign program we don't own;
Pinocchio can't touch it. A Pinocchio rewrite of our side reclaims ~8-20k
(<10%) of a number `set_compute_unit_limit` already dwarfs, at the cost of two
frameworks, manual `unsafe` validation in the trust-critical path, and exactly
the audit surface this track's judges scrutinize. Anchor's declarative
constraints *are* the "clean/deterministic" story the rubric rewards.

## Where Gecko genuinely helps (invisible in the pitch)

The off-chain **proof-acquisition dev loop** — `market(fixture, stat)` → pull
the settled fixture's proof from TxODDS's paywalled API → build settle args —
is riddled with first-call-wrong traps that are Gecko's exact "Nth painful API"
wedge (e.g. `ts` must be `summary.updateStats.minTimestamp`, not the proof's
top-level `ts`, or the oracle throws error 6010 — `forge_client.py:14-18`). Not
the on-chain settlement, which has nothing to do with API comprehension. The
honest internal line: *Gecko gets the right proof out of TxODDS first-call-correct;
the engine consumes it trustlessly on-chain.* Keep gecko-surf invisible in the
Gorilla narrative.

## Ranked plan (effort × judge-visible impact)

1. **`lock_ts` cutoff** — tiny (one constraint from `_reserved`), kills the
   late-stake exploit, academic backstop. Best ratio on the board.
2. **Extract `settlement-core`** (CPI seam + F1 binding) — the track's literal
   ask; ~90% pre-factored.
3. **Parametric-insurance second consumer** — proves reuse; forces #2.
4. **Mollusk two-consumer + tamper-revert suite** — the pitch, in CI.
5. **Empty-side `reclaim`** — closes a fund-safety hole.
6. **Checks-effects-interactions in `claim`; oracle-finality gate; proof-length
   bound; `set_compute_unit_limit` + CU table** — production-readiness signals.
7. **Interview prep** — the risk table above, and the "why not UMA" line.

## Deploy discipline

`forge_markets` is a pot-holding program; every deploy is founder-gated and
agents never sign/broadcast. Bundle into **one** reviewed upgrade, never serial
deploys: the F1-fix redeploy (the deployed devnet binary lacks the F1 strings —
source-only today) + `lock_ts` + `reclaim` + the engine extraction + the
pinocchio CU fixes. Pre-deploy: full Mollusk green including the new cases, a
fresh devnet e2e confirming F1 rejections fire on-chain, and the CU table
measured on Surfpool.
