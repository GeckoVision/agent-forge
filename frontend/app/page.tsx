import Link from "next/link";
import {
  ArrowRight,
  ExternalLink,
  Lock,
  ScrollText,
  Trophy,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { TrustBadge } from "@/components/hero/trust-badge";
import { FlowPipeline } from "@/components/hero/flow-pipeline";
import { LiveDevnetStats } from "@/components/hero/live-devnet-stats";
import { explorerAddress, FORGE_PROGRAM_ID } from "@/lib/solana/config";

const FEATURES = [
  {
    icon: ScrollText,
    title: "Settled by proof, not an admin",
    body: "settle CPIs into TxODDS's on-chain oracle, which verifies a 3-stage Merkle proof against its own committed root. A tampered proof reverts the transaction.",
    href: "/settlement",
    cta: "Open the proof viewer",
    tone: "primary" as const,
  },
  {
    icon: Lock,
    title: "The agent physically can't overspend",
    body: "Every bet is signed inside a custody policy — a max-spend cap plus a program allow-list. An out-of-policy transaction is refused before a signature exists.",
    href: "/agent",
    cta: "Watch the agent decide",
    tone: "accent" as const,
  },
  {
    icon: Trophy,
    title: "A track record that lives on-chain",
    body: "Every market, outcome and payout is public program state. The agent's history is decoded straight from the chain — nothing to trust, everything to verify.",
    href: "/track-record",
    cta: "See the track record",
    tone: "gold" as const,
  },
];

const toneRing = {
  primary: "text-primary bg-primary/10 ring-primary/25",
  accent: "text-accent bg-accent/10 ring-accent/25",
  gold: "text-gold bg-gold/10 ring-gold/25",
};

export default function HomePage() {
  return (
    <div className="mx-auto max-w-6xl px-4 sm:px-6">
      {/* ── Hero ─────────────────────────────────────────────────────────── */}
      <section className="flex flex-col items-center gap-8 pt-16 pb-14 text-center sm:pt-24">
        <span className="rounded-full border border-border/70 bg-secondary/40 px-3 py-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
          Superteam × TxODDS · Prediction Markets &amp; Settlement
        </span>

        <h1 className="max-w-4xl text-4xl font-semibold leading-[1.05] tracking-tight text-balance sm:text-6xl">
          Bet on sports —{" "}
          <span className="text-gradient">and actually get paid</span>.
        </h1>

        <p className="max-w-2xl text-lg leading-relaxed text-muted-foreground text-pretty">
          An AI watches the game and places your bets. The second you win,
          you&apos;re paid — automatically, from{" "}
          <span className="font-medium text-foreground">
            official match data no one can fake
          </span>
          . The result can&apos;t be fixed. No one can keep your money.
        </p>

        <div className="flex flex-col items-center gap-4">
          <TrustBadge />
          <div className="flex flex-wrap items-center justify-center gap-3">
            <Button asChild size="lg">
              <Link href="/settlement">
                Watch a bet pay itself out
                <ArrowRight />
              </Link>
            </Button>
            <Button asChild size="lg" variant="outline">
              <Link href="/agent">Watch the agent</Link>
            </Button>
            <Button asChild size="lg" variant="ghost">
              <a
                href={explorerAddress(FORGE_PROGRAM_ID.toBase58(), "devnet")}
                target="_blank"
                rel="noreferrer"
              >
                View program on Solana
                <ExternalLink />
              </a>
            </Button>
          </div>
        </div>

        <LiveDevnetStats className="mt-4" />
      </section>

      {/* ── The loop ─────────────────────────────────────────────────────── */}
      <section className="pb-14">
        <Card className="overflow-hidden">
          <CardContent className="flex flex-col gap-6 py-2">
            <div className="flex flex-col gap-1">
              <h2 className="text-sm font-semibold tracking-wide text-muted-foreground uppercase">
                How a bet becomes a payout
              </h2>
              <p className="text-sm text-muted-foreground">
                One loop, entirely on devnet — from reading the market to a
                cryptographically-settled payout.
              </p>
            </div>
            <FlowPipeline className="py-2" />
          </CardContent>
        </Card>
      </section>

      {/* ── Feature cards ────────────────────────────────────────────────── */}
      <section className="grid gap-4 pb-8 md:grid-cols-3">
        {FEATURES.map((f) => (
          <Link key={f.title} href={f.href} className="group">
            <Card className="h-full transition-colors hover:border-border group-hover:bg-card/80">
              <CardContent className="flex h-full flex-col gap-4">
                <span
                  className={`flex size-11 items-center justify-center rounded-xl ring-1 ${toneRing[f.tone]}`}
                >
                  <f.icon className="size-5" />
                </span>
                <h3 className="text-lg font-semibold leading-snug tracking-tight">
                  {f.title}
                </h3>
                <p className="text-sm leading-relaxed text-muted-foreground">
                  {f.body}
                </p>
                <span className="mt-auto inline-flex items-center gap-1.5 pt-2 text-sm font-medium text-foreground">
                  {f.cta}
                  <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
                </span>
              </CardContent>
            </Card>
          </Link>
        ))}
      </section>
    </div>
  );
}
