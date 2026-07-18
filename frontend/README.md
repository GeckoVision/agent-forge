# Gorilla Markets — web

The Demo-Day surface for Gorilla Markets: a dark, modern web app that
visualises the full devnet flow — an autonomous agent reading odds, betting under
a policy it can't exceed, and a market settled by TxODDS's own on-chain Merkle
proof. It reads **real devnet state** from the deployed `forge_markets` program.

> Trustless agent-settled prediction markets. Every outcome settles by the data
> provider's own on-chain Merkle proof — the program never calls the result.

## Stack

Next.js (App Router) · TypeScript · Tailwind CSS v4 · shadcn/ui · `@solana/web3.js`
· `@solana/wallet-adapter`. Package manager: **pnpm**.

## Run it

```bash
pnpm install
pnpm dev            # http://localhost:3000
```

With no configuration the app uses the public devnet RPC
(`https://api.devnet.solana.com`) — rate-limited but fully functional. For a
faster/reliable RPC, copy the env template and add a Helius devnet key:

```bash
cp .env.local.example .env.local
# then set HELIUS_API_KEY=... (or DEVNET_RPC_URL=...)
```

The RPC key is read **server-side only** by the `/api/rpc` proxy
(`app/api/rpc/route.ts`) and is never shipped to the browser bundle. `.env.local`
is gitignored.

```bash
pnpm build          # production build
pnpm lint           # eslint
```

## The four screens

1. **Overview** (`/`) — the pitch, the "Verified by TxLINE on Solana" trust badge,
   the end-to-end loop, and live devnet vitals (markets, settled count, pot) read
   from on-chain program accounts.
2. **Agent** (`/agent`) — the agent's reasoning, step by step: reads a live odds
   feed → detects a sharp move → sizes a bet → a policy-gated wallet signs it. Shows
   the custody policy (max-spend cap + program allow-list) and two refusals an
   out-of-policy call triggers *before a signature exists*.
3. **Settlement** (`/settlement`) — **the centerpiece.** A real settled market with a
   collapsible **Merkle-proof viewer**: the `TxODDS daily root (on-chain) →
   {summary + Merkle path} → validate_stat → settle` pipeline, visualised as a
   fixture stat folding up through three proof stages into the committed on-chain
   root. Shows the winner, the settle transaction, and the tamper-reverts guarantee.
   Includes a connect-wallet + build-and-simulate **place-a-bet** action.
4. **Track record** (`/track-record`) — the agent's history (markets, win/loss, pot),
   decoded straight from on-chain program accounts.

## Reading on-chain state

- Program `forge_markets` — `7Pvo6SEh1zBa1Euvj5QQ4td9GpfsQosTpxhqwWtWUFt6` (devnet).
- `lib/solana/forge-client.ts` mirrors the program's wire format as data — the same
  discriminators, account order, PDA seeds and byte layout the backend client uses —
  to **decode** `Market`/`Position` accounts and **build** the `stake` instruction
  client-side. Nothing here is a heuristic; it's the frozen program interface.
- The place-a-bet action **simulates first** and only enables sign-and-send when the
  simulation passes — so on an already-settled market it surfaces the program's
  fail-closed `MarketNotOpen` refusal instead of wasting a doomed transaction.

## Data-source modes (the mainnet-sim seam)

Every data-source call takes a resolved `NetworkConfig` selected by `DATA_MODE`
(`lib/solana/config.ts`). `devnet` is wired and live. `mainnet-sim` is a deliberate
**seam** for a future "mainnet simulation" toggle (a mainnet-fork RPC + the mainnet
oracle id); it is present end-to-end (config, RPC proxy branch, network badge) but
not connected to a live endpoint. Flipping the mode is the only change required.

## Project layout

```
app/
  page.tsx                    Overview (hero)
  agent/page.tsx              Agent dashboard
  settlement/page.tsx         Settlement + Merkle-proof viewer
  track-record/page.tsx       On-chain track record
  api/rpc/route.ts            Server-side RPC proxy (keeps the key off the client)
components/
  ui/                         shadcn/ui primitives
  hero/  agent/  settlement/  track/  layout/  wallet/  shared/
hooks/use-markets.ts          Live on-chain market reads
lib/
  solana/config.ts            program ids, markets, modes, explorer links
  solana/forge-client.ts      decoders + PDA derivation + stake ix builder
  solana/markets.ts           getProgramAccounts / tx classification
  solana/proof.ts             the recorded proof → 3-stage Merkle model
  agent/scenario.ts           the agent-reasoning scenario data
```
