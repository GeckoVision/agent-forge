# Recording Guide — what the founder captures

I produce the terminal beat and the diagram. **Everything in a browser is yours** —
I can't capture browser windows. This is the whole list, in capture order.

## Before you hit record

- [ ] **Wallet on Devnet.** Check it, don't assume. A wallet on mainnet was the
      root cause of three failed bets tonight and produced signatures that existed
      on no cluster.
- [ ] Wallet has devnet SOL (`4vaqPy1n…yTwn` was funded and worked).
- [ ] Browser zoom 100%, window 1440×900 or 1920×1080. Same size for every take.
- [ ] Close every other tab. Hide bookmarks. No notifications.
- [ ] **Nothing secret on screen** — no `.env`, no session files, no wallet seed.

---

## Shot 1 — a human bets on a live match ⭐ capture this first

**Why first:** it's the only perishable beat. It reads as "live" today and won't
tomorrow.

1. `/settlement`, wallet connected, network shown as devnet
2. Featured open market = `4TuMHk…` (fixture 18257865, France v England)
3. Click **YES**, then **0.005 SOL**
4. Click **Simulate** — wait for green. *This is not optional; "Place bet" stays
   disabled until it succeeds.*
5. Click **Place bet**, approve in the wallet
6. **Let the explorer tab load on camera.** Don't cut the wait — the wait is the
   evidence it's real.

**Already banked, if you'd rather not re-shoot:** tx `48w3m9zs…Wpnb`, confirmed
21:13:45Z, pot `0.0100 → 0.0150 SOL`.

## Shot 2 — the odds chart and the flagged move

`/agent`. Show the fixture header (France v England · World Cup · recorded
replay), then the chart, then the highlighted move.

Say **"full match"** out loud — the period is what disambiguates the line now.

## Shot 3 — settlement by proof

`/settlement`, the **settled** card (`2HWE5U…`, fixture 18197649) → **View settle
transaction** → open the Merkle proof viewer.

This is a real settlement with a real oracle CPI. Nothing here is mocked or
reenacted.

> It's a different fixture from shots 1–2. That's fine and the narration doesn't
> depend on it — France v England can't settle until the match ends and TxODDS
> commits a root covering it.

## Shot 4 — terminal ✅ done, don't re-record

`sharp-detector/demo/demo_hero.gif` (and `.cast` if you want to re-render at a
different size). Honest copy, verified numbers, no edge claims.

## Shot 5 — architecture

The mermaid diagram in `demo-script.md` beat 5.5. Designer builds it up in three
strokes: feed → agent → chain.

---

## Say / don't say

Full list in `demo-script.md`. The three that matter most:

- ❌ Never any ROI number or "edge" / "beats the market" / "profitable". The
  backtest is INCONCLUSIVE on every slice.
- ❌ Never imply mainnet. Say **devnet** out loud.
- ✅ Do say the rarity: **1 signal in 3,310 readings**. True, checkable, and a
  better line than any performance claim.

**Keep shots 1 and 4 apart in the edit.** Shot 4 is the AGENT staking with no
human approval. Shot 1 is a HUMAN approving a stake. Different transactions,
different claims — don't let "no human approves this" run over shot 1's footage.

## Two rules worth SHOWING, not hiding

Both came up tonight and both are strengths, framed right:

**"Anyone can open a market on any fixture."** `create_market` is permissionless
— no admin, no allow-list, no gatekeeper. The payer becomes `authority`, which
the code calls "bookkeeping". One market per `(fixture, stat_key)` pair. This is
the strongest openness claim in the product; say it out loud.

**"One stake per market. You can't add to it or switch sides."** Enforced by the
program (`init`, not `init_if_needed`), not by policy. The same rigidity that
stops you changing your mind is what stops anyone moving the goalposts on you.
Frame it as a property, not a limitation.

> Don't confuse this with the settled-market refusal. They're different:
> `MarketNotOpen` = the market is over. Position-exists = you already bet here.

## The bet, in plain words

Market `stat #1 > 0` on fixture 18257865 = **"France scores at least one goal."**
You bet YES with 0.005 SOL.

Mapping confirmed longitudinally: stat 1 = Participant1 goals, stat 2 =
Participant2 goals — `stat['2']` tracked the score 1→2 live. Only keys 1 and 2
are confirmed; the other 62 are unmapped, so don't narrate any other market.
