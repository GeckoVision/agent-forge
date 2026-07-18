import Link from "next/link";
import { ArrowRight, ExternalLink } from "lucide-react";

import { Button } from "@/components/ui/button";
import { TrustBadge } from "@/components/hero/trust-badge";
import { HeroMarketCard } from "@/components/hero/hero-market-card";
import { LiveDevnetStats } from "@/components/hero/live-devnet-stats";
import { explorerAddress, FORGE_PROGRAM_ID } from "@/lib/solana/config";

/**
 * "See it live" — the FIRST scroll after the (now purely atmospheric) hero, so
 * a visitor lands straight on value + proof. Everything the old hero carried as
 * foreground UI moved here: the concrete claim, the primary CTAs, and the REAL
 * on-chain proof. `HeroMarketCard` and `LiveDevnetStats` are the UNCHANGED live
 * components (real devnet data) — only their home moved.
 */
export function ProofSection() {
  return (
    <section
      aria-label="See it live"
      className="relative isolate overflow-hidden border-b border-border/60"
    >
      {/* faint atmosphere to bridge out of the hero — kept subtle (data lives
          here, so the barbell keeps it calmer than the narrative hero). */}
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
        <div
          className="absolute inset-0"
          style={{
            background:
              "radial-gradient(56% 60% at 88% 6%, color-mix(in oklch, var(--primary) 18%, transparent), transparent 66%), radial-gradient(48% 56% at 6% 102%, color-mix(in oklch, var(--gold) 12%, transparent), transparent 68%)",
          }}
        />
        <div className="poster-grain absolute inset-0" />
      </div>

      <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6 sm:py-24">
        <div className="grid gap-12 lg:grid-cols-2 lg:items-center">
          {/* left — the claim made concrete + the primary CTAs */}
          <div>
            <p className="eyebrow flex items-center gap-2 text-gold">
              <span aria-hidden className="font-display text-base">
                {"//"}
              </span>
              See it live
            </p>
            <h2 className="display-poster mt-4 max-w-xl text-balance">
              A settlement, live on Solana.
            </h2>
            <p className="body-l mt-6 max-w-lg text-muted-foreground text-pretty">
              Real markets, real payouts — every outcome settled by TxLINE&apos;s
              own on-chain Merkle proof. No bookie decides who won; nothing to
              trust, everything to verify.
            </p>

            <div className="mt-8 flex flex-col items-start gap-6">
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

          {/* right — the REAL market card (unchanged live component) */}
          <div className="mx-auto w-full max-w-sm lg:mx-0 lg:justify-self-end">
            <HeroMarketCard />
          </div>
        </div>

        <LiveDevnetStats className="mt-14" />
      </div>
    </section>
  );
}
