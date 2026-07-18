# Gorilla — Demo Narration (plain language)

**For:** voiceover. Written to be read aloud, edited freely, and understood by
someone who has never placed a bet and has never touched crypto.

**Runtime:** ~110s. Pairs with `docs/demo-script.md` (which holds the on-screen
beats, the exact figures, and the claim checks).

**Rules this script follows:**
- No jargon. Not one word of it. No "oracle", "Merkle proof", "CPI", "escrow",
  "on-chain", "custody", "protocol", "trustless", "decentralized".
- The *why us* lands in the first 25 seconds, not at the end.
- Every claim is one the demo shows on screen.
- Internal tooling is never named.

---

## The idea in one sentence

*(If someone only hears one line, this is it. Use it as the video description too.)*

> **Normally you bet against a company that profits when you lose. Gorilla lets
> you bet against another person instead — and nobody, including us, can touch
> the payout.**

---

## Beat 1 — The problem (0:00–0:15)

> "When you place a bet, there's a company on the other side of it. They set the
> price. They hold your money. And you get paid when they say you get paid.
>
> That company makes money when you lose. So the better you get at this, the
> less they want you around."

*Tone: matter-of-fact, not outraged. This is just how it works, and everyone
watching already knows it.*

---

## Beat 2 — What's different (0:15–0:35)

> "Gorilla takes the company out.
>
> You're betting against another person. Nobody sets the price against you.
> The money doesn't sit in anyone's account — it sits in a program, and the
> program pays out on its own. When the match ends, the result comes straight
> from the same data feed the professional bookmakers use.
>
> There's nobody to trust, and nobody to ask."

*This is the whole pitch. If the video gets cut to 30 seconds, it's beats 1 and 2.*

---

## Beat 3 — Real match, real prices (0:35–0:55)

> "This is a real World Cup match, with real prices — recorded off that live
> feed, millions of them.
>
> Watch Ecuador's number. It sits flat for hours, then jumps four points in a
> single update. Something moved."

*On screen: the chart, the fixture name, the highlighted move.*

---

## Beat 4 — The agent acts by itself (0:55–1:20)

> "That jump is what the agent is waiting for. And it's picky — one signal in
> three thousand readings. It almost never fires.
>
> When it does, it places the bet itself. Nobody clicks approve.
>
> And it can never run off with the money. The agent doesn't hold the keys — it
> asks a separate wallet to sign, and that wallet refuses anything over the
> limit. The whole budget here is a fraction of a coin."

*On screen: terminal, then the transaction. Let it load on camera — the wait is
the proof it's real.*

---

## Beat 4.5 — And you can do it yourself (1:20–1:35)

> "You don't have to hand it to an agent, either. This is a match being played
> right now. Pick a side, pick an amount, and the bet goes straight on chain —
> into the program, not into an account we control.
>
> Fifteen thousandths of a coin in the pot. Ours is the five."

*On screen: the settlement page, wallet connect, YES / 0.005 SOL, Simulate going
green, Place bet, then the explorer tab loading the confirmed transaction.*

> ⚠️ **This beat is a HUMAN placing a bet. Beat 4 is the AGENT placing one.**
> They are different transactions and different claims — do not let the edit
> imply the agent did this, or that a human approved the agent's stake. Keep
> "no human approves this" (beat 4) away from this footage.

**Claim check:** tx `48w3m9zs…Wpnb`, confirmed devnet 2026-07-18T21:13:45Z,
`err=None`. Stake 0.005 SOL → vault `3t5ogg…re6f`. Market `4TuMHk…` pot moved
0.0100 → **0.0150 SOL**, still `Open`. Fixture 18257865, kickoff 21:00Z — the
match was **in progress** when this was placed. ✅

---

## Beat 5 — Nobody can interfere with the payout (1:20–1:40)

> "Ecuador wins, two-one.
>
> Here's the part that matters. Nobody at Gorilla decides that. The program
> looks up the published result, checks it against a receipt it can verify by
> itself, and pays. If the receipt doesn't match, nothing moves.
>
> We couldn't change the outcome if we wanted to. That's the point."

---

## Beat 6 — Honest close (1:40–1:55)

> "So: real prices coming in, an agent that acts on its own, and a payout nobody
> can interfere with — not the house, not us.
>
> It's running on a test network today. Going live is a decision, not a demo.
>
> And whether the agent's strategy actually makes money — we don't know yet. We
> haven't watched enough matches to say, and we're not going to pretend
> otherwise. What we've built is the part that has to be trustworthy."

*Ending on the limit is a strength with technical judges and investors, not a
weakness. It signals we know the difference between what we built and what we've
proven. Keep it.*

---

## 20-second cut (for social)

> "When you place a bet, there's a company on the other side who profits when
> you lose. Gorilla takes them out. You bet against another person, the money
> sits in a program instead of someone's account, and the payout happens on its
> own when the result comes in. Nobody can interfere with it — including us."

---

## Word swaps — if a technical word creeps back in

| Don't say | Say |
|---|---|
| oracle | the data feed / the published result |
| Merkle proof | a receipt the program checks by itself |
| on-chain / smart contract | a program that runs on its own |
| escrow / custody | the money sits in the program, not in an account |
| trustless | there's nobody to trust |
| devnet | a test network *(the word `devnet` still appears on screen — that's the honest part)* |
| CPI / cross-program invocation | *(cut entirely — nobody needs this)* |
| signal / detector fires | the agent spots the move |
| basis points / pp | points |

---

## Numbers — confirm before recording

- **"millions of prices"** — deliberately vague and safe. The World Cup capture
  is ~3.66M odds updates; the full multi-competition load is 12.29M. Pick one and
  say the exact figure only if the on-screen provenance shows the same number.
- **"one signal in three thousand readings"** — verified: 1 signal across 3,310
  readings on this fixture's full-match line.
- **"four points"** — verified: 19.3% → 23.4%, +4.1pp, single update.
- **"a fraction of a coin"** — real caps are 0.05 SOL total, 0.01 per bet.

## Do not say

Everything on the DO-NOT-SAY list in `docs/demo-script.md` applies here without
exception — especially any version of "the agent wins", "beats the market", "has
an edge", or any ROI figure. The backtest does not support them.
