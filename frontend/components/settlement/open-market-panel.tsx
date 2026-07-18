"use client";

import { useEffect, useMemo, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import {
  Ban,
  CircleCheck,
  FlaskConical,
  Info,
  LoaderCircle,
  PartyPopper,
  Send,
  Sparkles,
  Users,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { ConnectButton } from "@/components/wallet/connect-button";
import { ExplorerLink } from "@/components/shared/explorer-link";
import {
  AccountRow,
  discHex,
} from "@/components/settlement/place-bet-panel";
import {
  EXPECTED_CLUSTER,
  NetworkBanner,
} from "@/components/settlement/network-banner";
import { ShareBetButton } from "@/components/settlement/market-summary";
import { useInstructionFlow } from "@/hooks/use-instruction-flow";
import { CLUSTER_LABEL } from "@/lib/solana/cluster";
import { DATA_MODE, type ExplorerCluster } from "@/lib/solana/config";
import {
  buildCreateMarketIx,
  marketPda,
  type MarketAccount,
} from "@/lib/solana/forge-client";
import { fetchMarket } from "@/lib/solana/markets";
import {
  decideOpen,
  kickoffLabel,
  OPEN_MARKET_PERIOD,
  OPEN_MARKET_PREDICATE,
  openableBets,
  sortByKickoff,
  type CoveredFixture,
} from "@/lib/solana/open-market";
import { cn } from "@/lib/utils";

/**
 * Open a market: pick a covered match, pick one of the two verified bets, sign
 * ONE transaction, and the market exists on chain with its share link ready.
 *
 * Same honesty rules as the bet panel: only matches the oracle can settle are
 * offered (capture presence = coverage), only the two verified stat labels are
 * offered, a send is gated behind a clean simulation, and if the (fixture, stat)
 * market already exists that's a warm "join it", never an error — the PDA is
 * unique, so someone simply got there first.
 */

// What the existing-market check knows for the currently derived PDA. "error"
// means the RPC read failed — we say so and let the simulation gate catch a
// duplicate, rather than blocking the flow on a flaky read.
type ExistingState =
  | { key: string; result: MarketAccount | null | "error" }
  | null;

export function OpenMarketPanel({
  covered,
  loadingFixtures,
  cluster = "devnet",
  onLand,
  onClose,
}: {
  covered: CoveredFixture[];
  loadingFixtures: boolean;
  cluster?: ExplorerCluster;
  /** Land on this market: select its tab (created or joined — same landing). */
  onLand: (market: MarketAccount) => void;
  onClose: () => void;
}) {
  const { publicKey } = useWallet();

  const [fixtureId, setFixtureId] = useState<number | null>(null);
  const [statKey, setStatKey] = useState<1 | 2 | null>(null);
  const [existing, setExisting] = useState<ExistingState>(null);
  // Set once the create transaction confirms — flips the panel to the share state.
  const [created, setCreated] = useState<{
    address: string;
    landed: boolean;
  } | null>(null);

  const flow = useInstructionFlow({
    simOk: "Simulation succeeded — the market is valid and ready to sign.",
    sent: (outcome) => `Market opened on-chain (${outcome}).`,
    timeout:
      "Couldn't confirm this transaction within 30s. It may not have been broadcast — " +
      "check the signature on the explorer, and that your wallet is on " +
      `${CLUSTER_LABEL[EXPECTED_CLUSTER]}. No market has been recorded as opened.`,
  });

  const matches = useMemo(() => sortByKickoff(covered), [covered]);
  const match = matches.find((f) => f.fixtureId === fixtureId) ?? null;
  const bets = useMemo(() => (match ? openableBets(match) : []), [match]);
  const bet = bets.find((b) => b.statKey === statKey) ?? null;

  // The market PDA is derivable from the pick alone — no wallet needed — so the
  // create-or-join answer can show before anyone connects.
  const pdaAddress = useMemo(() => {
    if (fixtureId === null || statKey === null) return null;
    return marketPda(BigInt(fixtureId), statKey)[0].toBase58();
  }, [fixtureId, statKey]);

  useEffect(() => {
    if (!pdaAddress) return;
    let alive = true;
    fetchMarket(pdaAddress, DATA_MODE)
      .then((m) => alive && setExisting({ key: pdaAddress, result: m }))
      .catch(() => alive && setExisting({ key: pdaAddress, result: "error" }));
    return () => {
      alive = false;
    };
  }, [pdaAddress]);

  // Only trust a check that matches the current pick.
  const checked = existing && existing.key === pdaAddress ? existing.result : null;
  const checking = pdaAddress !== null && (!existing || existing.key !== pdaAddress);
  const decision =
    checked === "error" || checked === null ? null : decideOpen(checked);
  const existingMarket = decision?.kind === "join" ? decision.market : null;
  // Create is offered when the account is confirmed absent, or when the check
  // errored (honest note below; the simulation gate still catches a duplicate).
  const canOfferCreate =
    pdaAddress !== null &&
    !checking &&
    existingMarket === null &&
    (checked === "error" || decideOpen(checked).kind === "create");

  const built = useMemo(() => {
    if (!publicKey || fixtureId === null || statKey === null) return null;
    try {
      return buildCreateMarketIx({
        fixtureId: BigInt(fixtureId),
        statKey,
        threshold: OPEN_MARKET_PREDICATE.threshold,
        comparison: OPEN_MARKET_PREDICATE.comparison,
        period: OPEN_MARKET_PERIOD,
        authority: publicKey,
      });
    } catch {
      return null;
    }
  }, [publicKey, fixtureId, statKey]);

  async function openMarket() {
    if (!built) return;
    const confirmed = await flow.send(built.instruction);
    if (!confirmed) return;
    const address = built.market.toBase58();
    setCreated({ address, landed: false });
    // Read the freshly created account back so the tabs get a real MarketAccount.
    // A couple of retries cover confirmed-but-not-yet-readable RPC lag; if it still
    // doesn't read, the share link (address is deterministic) works regardless.
    for (let attempt = 0; attempt < 3; attempt++) {
      const market = await fetchMarket(address, DATA_MODE).catch(() => null);
      if (market) {
        setCreated({ address, landed: true });
        onLand(market);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  const pickMatch = (id: number) => {
    setFixtureId(id);
    setStatKey(null);
    flow.reset();
  };
  const pickBet = (key: 1 | 2) => {
    setStatKey(key);
    flow.reset();
  };

  // ── the created state: the market exists, the link is the point ──────────────
  if (created) {
    return (
      <div className="flex flex-col gap-4">
        <PanelHeader onClose={onClose} />
        <div className="flex flex-col gap-3 rounded-lg border border-primary/30 bg-primary/5 p-4">
          <span className="flex items-center gap-2 text-sm font-semibold">
            <PartyPopper className="size-4 text-primary" />
            Market open — share it with your friends.
          </span>
          {match && bet && (
            <span className="text-sm text-muted-foreground">
              {match.participant1} vs {match.participant2} ·{" "}
              <span className="text-foreground">{bet.label}</span>
            </span>
          )}
          <p className="text-xs leading-relaxed text-muted-foreground">
            You open it, but you can&rsquo;t touch it — settlement only follows the
            confirmed result. Anyone with the link can put their stake on either
            side.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <ShareBetButton address={created.address} />
            <ExplorerLink value={created.address} cluster={cluster} />
          </div>
          {!created.landed && (
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <LoaderCircle className="size-3.5 shrink-0 animate-spin" />
              Reading the new market back from {CLUSTER_LABEL[EXPECTED_CLUSTER]}…
              the link above already points to it.
            </p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <PanelHeader onClose={onClose} />

      <p className="text-sm text-muted-foreground">
        Pick a match and a bet, sign one transaction (~0.002 SOL of rent on{" "}
        {CLUSTER_LABEL[EXPECTED_CLUSTER]}), and the market exists on chain — with a
        link your friends can bet against.
      </p>

      {/* 1 — pick the match. Covered fixtures only: presence in the capture is the
          coverage evidence, so nothing here can ever be a match the oracle can't settle. */}
      <div className="flex flex-col gap-2">
        <span className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
          Pick a match
        </span>
        {loadingFixtures ? (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <LoaderCircle className="size-3.5 animate-spin" />
            Loading the covered matches…
          </p>
        ) : matches.length === 0 ? (
          <p className="rounded-lg border border-border/70 bg-secondary/40 p-2.5 text-xs leading-relaxed text-muted-foreground">
            No covered matches are available right now. Markets can only be opened
            on matches the oracle can settle, and the fixtures data didn&rsquo;t
            load — so there&rsquo;s nothing to offer, rather than something made up.
          </p>
        ) : (
          <div className="flex max-h-52 flex-col gap-1 overflow-y-auto pr-1">
            {matches.map((f) => (
              <button
                key={f.fixtureId}
                onClick={() => pickMatch(f.fixtureId)}
                className={cn(
                  "flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-left transition-colors cursor-pointer",
                  f.fixtureId === fixtureId
                    ? "border-primary/40 bg-primary/5"
                    : "border-border/70 hover:bg-secondary",
                )}
              >
                <span className="text-sm font-medium">
                  {f.participant1} vs {f.participant2}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {kickoffLabel(f.kickoffMs)}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* 2 — pick the bet. ONLY the two verified goal stats; an unmapped stat key
          must never be offered (a confidently wrong label beats no label — backwards). */}
      {match && (
        <div className="flex flex-col gap-2">
          <span className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
            Pick the bet
          </span>
          <div className="grid grid-cols-2 gap-2">
            {bets.map((b) => (
              <button
                key={b.statKey}
                onClick={() => pickBet(b.statKey)}
                className={cn(
                  "flex flex-col items-center gap-0.5 rounded-lg border px-2 py-2 transition-colors cursor-pointer",
                  b.statKey === statKey
                    ? "border-yes/40 bg-yes/10 text-yes"
                    : "border-border/70 text-muted-foreground hover:bg-secondary",
                )}
              >
                <span className="text-sm font-semibold">{b.label}</span>
                <span className="text-xs opacity-80">full match</span>
              </button>
            ))}
          </div>
          <p className="flex items-start gap-1.5 text-xs leading-relaxed text-muted-foreground">
            <Info className="mt-0.5 size-3.5 shrink-0" />
            Friends then bet YES or NO on it. Bets stay open until the market
            settles — a kickoff cutoff is coming in v1.5.
          </p>
        </div>
      )}

      {/* 3 — create or join. The (fixture, stat) market is unique on chain. */}
      {pdaAddress && checking && (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <LoaderCircle className="size-3.5 animate-spin" />
          Checking whether this bet is already open on chain…
        </p>
      )}

      {existingMarket && match && bet && (
        <div className="flex flex-col gap-3 rounded-lg border border-accent/40 bg-accent/5 p-3">
          <span className="flex items-center gap-2 text-sm font-medium">
            <Users className="size-4 text-accent" />
            Someone already opened this bet — join it.
          </span>
          <p className="text-xs leading-relaxed text-muted-foreground">
            There&rsquo;s exactly one market per match and bet, and this one is
            live on chain. That&rsquo;s the fun part: your bet lands in the same
            pot as theirs.
          </p>
          <Button
            onClick={() => {
              onLand(existingMarket);
              onClose();
            }}
            className="self-start"
          >
            <Users />
            Take me to it
          </Button>
        </div>
      )}

      {checked === "error" && !checking && (
        <p className="rounded-lg border border-border/70 bg-secondary/40 p-2.5 text-xs leading-relaxed text-muted-foreground">
          Couldn&rsquo;t check {CLUSTER_LABEL[EXPECTED_CLUSTER]} for an existing
          market on this bet. You can still simulate — if the market already
          exists, the simulation will refuse the duplicate.
        </p>
      )}

      {canOfferCreate && match && bet && !publicKey && (
        <div className="flex flex-col items-start gap-3 rounded-lg border border-border/70 bg-background/40 p-3">
          <p className="text-sm text-muted-foreground">
            This bet isn&rsquo;t open yet — you&rsquo;d be first. Connect a{" "}
            {CLUSTER_LABEL[EXPECTED_CLUSTER]} wallet to build the real{" "}
            <code>create_market</code> instruction client-side and open it.
          </p>
          <ConnectButton />
        </div>
      )}

      {canOfferCreate && match && bet && publicKey && built && (
        <div className="flex flex-col gap-4">
          <NetworkBanner subject="market" />

          {/* the built instruction — same transparency as the bet panel */}
          <div className="flex flex-col gap-2 rounded-lg border border-border/70 bg-background/40 p-3">
            <span className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
              Built instruction (client-side)
            </span>
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">discriminator</span>
              <span className="tabular font-mono text-foreground">
                {discHex("create_market")}
              </span>
            </div>
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">args</span>
              <span className="tabular font-mono text-foreground">
                fixture={match.fixtureId}, stat={bet.statKey}, &gt; 0, period=0
              </span>
            </div>
            <Separator className="my-1" />
            <AccountRow label="market" pubkey={built.market.toBase58()} flags="w" />
            <AccountRow label="vault" pubkey={built.vault.toBase58()} flags="r" />
            <AccountRow
              label="authority"
              pubkey={publicKey.toBase58()}
              flags="s,w"
            />
          </div>

          {/* the whole ask, in words, right where they commit — with the trust claim */}
          <p className="rounded-lg border border-border/70 bg-background/40 p-2.5 text-sm">
            You&rsquo;re opening{" "}
            <span className="font-semibold">&ldquo;{bet.label}&rdquo;</span> for{" "}
            {match.participant1} vs {match.participant2}. You open it, but you
            can&rsquo;t touch it — settlement only follows the confirmed result.
          </p>

          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              onClick={() => flow.simulate(built.instruction)}
              disabled={flow.phase === "simulating" || flow.phase === "sending"}
              className="flex-1"
            >
              {flow.phase === "simulating" ? (
                <LoaderCircle className="animate-spin" />
              ) : (
                <FlaskConical />
              )}
              Simulate
            </Button>
            {/* Wrapper carries the not-allowed cursor: the disabled Button has
                `pointer-events-none`, so the hover cursor must live on the parent. */}
            <span className={cn("flex-1", !flow.canSend && "cursor-not-allowed")}>
              <Button
                onClick={openMarket}
                disabled={!flow.canSend}
                aria-disabled={!flow.canSend}
                className={cn("w-full", !flow.canSend && "opacity-40 saturate-50")}
              >
                {flow.phase === "sending" ? (
                  <LoaderCircle className="animate-spin" />
                ) : (
                  <Send />
                )}
                Open market
              </Button>
            </span>
          </div>
          {!flow.canSend && flow.phase !== "sending" && (
            <p className="-mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
              <Info className="size-3.5 shrink-0" />
              Run <span className="font-medium text-foreground">Simulate</span>{" "}
              first — it checks the market against the program before you can sign.
            </p>
          )}

          {/* result */}
          {flow.message && (
            <div
              className={cn(
                "flex flex-col gap-2 rounded-lg border p-3 text-sm",
                flow.phase === "sim-ok" || flow.phase === "sent"
                  ? "border-primary/30 bg-primary/5"
                  : flow.phase === "sim-err" || flow.phase === "send-err"
                    ? "border-destructive/30 bg-destructive/5"
                    : "border-border/70 bg-card",
              )}
            >
              <span className="flex items-center gap-2 font-medium">
                {flow.phase === "sim-ok" || flow.phase === "sent" ? (
                  <CircleCheck className="size-4 text-primary" />
                ) : (
                  <Ban className="size-4 text-destructive" />
                )}
                {flow.message}
              </span>
              {flow.sig && (
                <ExplorerLink
                  value={flow.sig}
                  kind="tx"
                  cluster={cluster}
                  short={false}
                />
              )}
              {flow.logs && flow.logs.length > 0 && (
                <pre className="max-h-32 overflow-auto rounded bg-background/60 p-2 font-mono text-[10px] leading-relaxed text-muted-foreground">
                  {flow.logs.join("\n")}
                </pre>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function PanelHeader({ onClose }: { onClose: () => void }) {
  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-2">
        <Sparkles className="size-4 text-accent" />
        <h3 className="text-sm font-semibold">Open a market</h3>
      </div>
      <div className="flex items-center gap-2">
        <Badge variant="secondary" className="font-mono">
          create_market
        </Badge>
        <button
          onClick={onClose}
          aria-label="Close open-a-market panel"
          className="rounded p-1 text-muted-foreground transition-colors cursor-pointer hover:bg-secondary hover:text-foreground"
        >
          <X className="size-4" />
        </button>
      </div>
    </div>
  );
}
