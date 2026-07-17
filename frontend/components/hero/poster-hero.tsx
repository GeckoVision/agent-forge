import Link from "next/link";
import { ArrowRight, ExternalLink } from "lucide-react";

import { Button } from "@/components/ui/button";
import { TrustBadge } from "@/components/hero/trust-badge";
import { LiveDevnetStats } from "@/components/hero/live-devnet-stats";
import { HeroMarketCard } from "@/components/hero/hero-market-card";
import { explorerAddress, FORGE_PROGRAM_ID } from "@/lib/solana/config";

/**
 * Sports-poster hero. The z-sandwich, back to front:
 *   z-0  ambient texture (grain + column rules + purple/gold gradient wash)
 *   z-10 oversized compressed ALL-CAPS headline (the "background type")
 *   z-20 the REAL stat card, square-edged, floated clear at the right
 *   z-30 foreground UI — eyebrow, subhead, trust badge, CTAs, live stats
 * The full approved message is preserved for a11y/SEO (sr-only); the visible
 * type is the compressed poster cut of it.
 */
export function PosterHero() {
  return (
    <section className="relative isolate overflow-hidden border-b border-border/60">
      {/* ── z-0 · ambient poster texture — the visible purple gradient wash
             lives HERE (narrative surface only), never on data surfaces ──── */}
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
        <div className="poster-vgrid absolute inset-0" />
        {/* purple atmospheric wash across the hero + a gold accent, anchored
            where the stat card floats — clearly visible on the lighter base */}
        <div
          className="absolute inset-0"
          style={{
            background:
              "radial-gradient(60% 72% at 80% 30%, color-mix(in oklch, var(--primary) 44%, transparent), transparent 70%), radial-gradient(52% 60% at 94% 98%, color-mix(in oklch, var(--gold) 26%, transparent), transparent 72%), linear-gradient(158deg, color-mix(in oklch, var(--primary) 24%, transparent) 0%, transparent 48%)",
          }}
        />
        <div className="poster-grain absolute inset-0" />
      </div>

      <div className="mx-auto max-w-6xl px-4 pt-16 pb-16 sm:px-6 sm:pt-24">
        {/* eyebrow — gold slash detail, top-left */}
        <p className="eyebrow flex items-center gap-2 text-muted-foreground">
          <span aria-hidden className="font-display text-base text-gold">
            {"//"}
          </span>
          Superteam × TxODDS · Prediction Markets &amp; Settlement
        </p>

        {/* ── the poster stack ─────────────────────────────────────────── */}
        <div className="relative mt-5">
          <h1
            className="poster-headline relative z-10"
            style={{
              color: "color-mix(in oklch, var(--foreground) 88%, var(--primary))",
            }}
          >
            <span className="sr-only">
              Bet on sports — and actually get paid.
            </span>
            <span aria-hidden>
              <span className="block">Bet on</span>
              <span className="block">Sports —</span>
              <span className="text-gradient-gold block">Get paid</span>
            </span>
          </h1>

          {/* the real stat card — floated at the RIGHT, clear of the type so no
              letter of "BET ON / SPORTS / GET PAID" is obscured. It nests into
              the right whitespace beside the headline; stacks below on < lg. */}
          <div className="relative z-20 mx-auto mt-10 w-full max-w-sm lg:absolute lg:top-1/2 lg:right-0 lg:mt-0 lg:-translate-y-1/2">
            <HeroMarketCard />
          </div>
        </div>

        {/* ── z-30 · foreground UI ──────────────────────────────────────── */}
        <div className="relative z-30 mt-12 max-w-2xl lg:mt-14">
          <p className="body-l text-muted-foreground text-pretty">
            An AI places the bets. When the match ends, the official data pays
            the winners automatically — on-chain. No bookie decides who won, and
            no company can sit on your money.
          </p>

          <div className="mt-8 flex flex-col items-start gap-5">
            <TrustBadge className="rounded-none" />
            <div className="flex flex-wrap items-center gap-3">
              <Button asChild size="lg" className="rounded-none">
                <Link href="/settlement">
                  See a settlement
                  <ArrowRight />
                </Link>
              </Button>
              <Button
                asChild
                size="lg"
                variant="outline"
                className="rounded-none"
              >
                <Link href="/agent">Watch the agent</Link>
              </Button>
              <Button
                asChild
                size="lg"
                variant="ghost"
                className="rounded-none"
              >
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
        </div>

        <LiveDevnetStats className="relative z-30 mt-12" />
      </div>
    </section>
  );
}
