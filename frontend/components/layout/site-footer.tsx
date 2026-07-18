import { FORGE_PROGRAM_ID } from "@/lib/solana/config";
import { ExplorerLink } from "@/components/shared/explorer-link";
import { FooterClock } from "@/components/layout/footer-clock";

/**
 * Monolog-inspired editorial footer. Back to front:
 *   ambient   the violet bleed + greyscale halftone DUNE, rising from the floor
 *   meta row  live clock · back-to-top + status · ©Gorilla (small mono/caps)
 *   facts     the real on-chain facts (forge_markets id + TxLINE verification)
 *   baseline  a giant GORILLA wordmark (Anton) + a bracketed tagline
 * Everything decorative is STATIC (reduced-motion-safe); only the clock ticks.
 */
export function SiteFooter() {
  return (
    <footer className="relative isolate mt-28 overflow-hidden border-t border-border/60">
      {/* ── ambient · the purple bleed + dithered halftone dune (both static) ─ */}
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
        <div className="footer-bleed absolute inset-x-0 bottom-0 h-2/3" />
        <div className="footer-halftone absolute inset-x-0 bottom-0 h-3/4" />
      </div>

      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        {/* ── meta row — 3 columns, small mono / uppercase ─────────────────── */}
        <div className="grid grid-cols-1 gap-6 border-b border-border/40 py-8 sm:grid-cols-3 sm:items-start">
          {/* LEFT — live clock + date + network */}
          <FooterClock />

          {/* CENTER — back to top (CSS smooth-scroll, reduced-motion-safe) + status */}
          <div className="flex flex-col gap-1.5 sm:items-center sm:text-center">
            <a
              href="#top"
              className="eyebrow inline-flex w-fit items-center gap-1 text-muted-foreground transition-colors hover:text-foreground sm:mx-auto"
            >
              Back to top <span aria-hidden>↑</span>
            </a>
            <span className="mono-s text-muted-foreground/70">
              Superteam × TxODDS · Demo Day 2026
            </span>
          </div>

          {/* RIGHT — copyright */}
          <div className="flex flex-col gap-1.5 sm:items-end sm:text-right">
            <span className="eyebrow text-muted-foreground">
              ©2026 Gorilla
            </span>
            <span className="mono-s text-muted-foreground/60">
              Trustless agent-settled markets
            </span>
          </div>
        </div>

        {/* ── baseline zone — facts strip + the poster wordmark ────────────── */}
        <div className="relative pt-10 pb-9 sm:pt-14">
          {/* the real on-chain facts — kept prominent, never lost */}
          <div className="mono-s flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground/70">
            <span className="inline-flex items-center gap-2">
              <span className="text-muted-foreground/60">forge_markets</span>
              <ExplorerLink value={FORGE_PROGRAM_ID.toBase58()} />
            </span>
            <span aria-hidden className="text-muted-foreground/30">
              ·
            </span>
            <span className="text-muted-foreground/60">
              Verified by TxLINE on Solana · Devnet
            </span>
          </div>

          {/* baseline row — giant wordmark (left) + bracketed tagline (right) */}
          <div className="mt-8 flex flex-col gap-y-5 lg:flex-row lg:items-end lg:justify-between lg:gap-x-8">
            <span
              aria-hidden
              className="footer-wordmark text-gradient block select-none"
            >
              Gorilla
            </span>
            <span className="mono-s shrink-0 text-sm tracking-wide text-muted-foreground lg:pb-3 lg:text-right">
              <span className="text-gold">「</span>
              You win. You get paid.
              <span className="text-gold">」</span>
            </span>
          </div>
        </div>
      </div>
    </footer>
  );
}
