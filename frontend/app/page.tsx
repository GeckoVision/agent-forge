import Link from "next/link";
import { ArrowRight, Lock, ScrollText, Trophy } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import { PosterHero } from "@/components/hero/poster-hero";
import { ProofSection } from "@/components/home/proof-section";
import { ProblemSection } from "@/components/home/problem-section";
import { HowItWorks } from "@/components/home/how-it-works";
import { OneEngineSection } from "@/components/home/one-engine-section";

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
    <>
      {/* ── Hero (Monolog-style single composition) ──────────────────────── */}
      <PosterHero />

      {/* ── See it live (relocated card + CTAs + live devnet proof) ───────── */}
      <ProofSection />

      {/* ── The problem (dark atmospheric band) ──────────────────────────── */}
      <ProblemSection />

      {/* ── How it works (3 steps + the real pipeline) ───────────────────── */}
      <HowItWorks />

      {/* ── One engine, two products (reusability proof — dark poster band) ─ */}
      <OneEngineSection />

      {/* ── Why it holds up (feature cards) ──────────────────────────────── */}
      <section className="border-t border-border">
        <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6 sm:py-24">
        <p className="eyebrow flex items-center gap-2 text-gold">
          <span aria-hidden className="font-display text-base">
            {"//"}
          </span>
          Why it holds up
        </p>
        <h2 className="display-poster mt-4 max-w-2xl text-balance">
          Three guarantees, all on-chain.
        </h2>

        <div className="mt-14 grid gap-4 md:grid-cols-3">
          {FEATURES.map((f) => (
            <Link key={f.title} href={f.href} className="group">
              <Card className="h-full transition-colors hover:border-primary/30 group-hover:bg-card/80">
                <CardContent className="flex h-full flex-col gap-4">
                  <span
                    className={`flex size-11 items-center justify-center rounded-lg ring-1 ${toneRing[f.tone]}`}
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
        </div>
        </div>
      </section>
    </>
  );
}
