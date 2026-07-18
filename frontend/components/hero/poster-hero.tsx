"use client";

import { useEffect, useRef } from "react";

/**
 * Monolog-style hero — ONE minimal composition, now with restrained MOTION.
 * A giant bottom-anchored GORILLA wordmark (the hero element) under two
 * short, centered lines of copy, over a dark, moody, grainy atmosphere. No
 * eyebrow, no card, no CTA row, no stats bar — those live in the proof section
 * below.
 *
 * The Monolog "essence" is brought over achievably — NO WebGL / video / GSAP:
 *   1. on-load reveal   — copy fades + rises (subtle stagger); the wordmark
 *                          rises into place (SplitText-in-spirit). CSS, once.
 *   2. living atmosphere — the fog breathes + drifts slowly + continuously. CSS.
 *   3. scroll parallax   — the wordmark drifts at a fraction of the scroll rate
 *                          (JS sets --parallax-y; rAF-throttled, transform-only).
 * Every motion is transform/opacity only and gated by prefers-reduced-motion
 * (see globals.css) → reduced-motion renders the exact static hero. Grain stays
 * static.
 *
 * The z-sandwich, back to front:
 *   -z-10  atmosphere — subtle purple/gold wash + drifting fog + scrim + vignette + grain
 *   z-10   the giant wordmark (bottom-anchored, feet dissolving into the grain)
 *   z-20   the copy (small, centered, legible over everything)
 */
export function PosterHero() {
  const trackRef = useRef<HTMLDivElement>(null);

  // Subtle scroll parallax on the wordmark (the Monolog wordmark-as-scroll
  // element). transform-only, rAF-throttled, and fully disabled under
  // prefers-reduced-motion — the CSS default (--parallax-y: 0) keeps it static.
  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;

    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    let raf = 0;

    const FACTOR = 0.18; // wordmark lags scroll by ~18% → a gentle drift
    const MAX = 120; // px cap so it never travels too far

    const apply = () => {
      raf = 0;
      const y = Math.min(window.scrollY * FACTOR, MAX);
      el.style.setProperty("--parallax-y", `${y}px`);
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(apply);
    };

    const enable = () => {
      apply(); // set initial offset (covers a reload mid-scroll)
      window.addEventListener("scroll", onScroll, { passive: true });
    };
    const disable = () => {
      window.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      el.style.removeProperty("--parallax-y"); // → resting (CSS default 0px)
    };

    if (!media.matches) enable();

    const onChange = () => (media.matches ? disable() : enable());
    media.addEventListener("change", onChange);

    return () => {
      media.removeEventListener("change", onChange);
      disable();
    };
  }, []);

  return (
    <section className="relative isolate flex min-h-[84svh] flex-col overflow-hidden border-b border-border/60">
      {/* ── atmosphere — dark, calm, Monolog-quiet (no column rules, no cards) ── */}
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
        {/* subtle, cinematic purple/gold wash */}
        <div
          className="absolute inset-0"
          style={{
            background:
              "radial-gradient(60% 55% at 50% 20%, color-mix(in oklch, var(--primary) 30%, transparent), transparent 70%), radial-gradient(64% 62% at 82% 112%, color-mix(in oklch, var(--gold) 16%, transparent), transparent 72%), linear-gradient(180deg, color-mix(in oklch, var(--primary) 14%, transparent) 0%, transparent 46%)",
          }}
        />
        {/* the living layer — slow, seamless breathe + drift (gated below) */}
        <div className="hero-fog hero-fog-animated absolute inset-0" />
        {/* soft center scrim → seats the copy so it stays legible over the
            wordmark crown + grain */}
        <div
          className="absolute inset-0"
          style={{
            background:
              "radial-gradient(46% 32% at 50% 40%, color-mix(in oklch, black 46%, transparent), transparent 72%)",
          }}
        />
        <div className="hero-vignette absolute inset-0" />
        <div className="poster-grain poster-grain-strong absolute inset-0" />
      </div>

      {/* ── copy — understated, centered, in the space above the wordmark.
             Reveals on load: fade + rise, H1 then subhead (subtle stagger). ── */}
      <div className="relative z-20 flex flex-1 items-center justify-center px-4 pt-16 sm:px-6">
        <div className="mx-auto max-w-xl text-center [text-shadow:0_1px_22px_rgba(0,0,0,0.5)]">
          <h1
            className="hero-anim-reveal text-balance text-2xl font-semibold leading-snug tracking-tight text-foreground sm:text-3xl"
            style={{ animationDelay: "0.05s" }}
          >
            You won the bet. Getting paid shouldn&apos;t be the hard part.
          </h1>
          <p
            className="hero-anim-reveal mx-auto mt-5 max-w-md text-pretty text-base leading-relaxed text-muted-foreground sm:text-lg"
            style={{ animationDelay: "0.2s" }}
          >
            Gorilla settles it on-chain — the match data pays the winners
            automatically. No bookie, no excuses.
          </p>
        </div>
      </div>

      {/* ── the hero element — giant GORILLA, bottom-anchored, feet bleeding
             off the bottom / dissolving into grain. Decorative (the brand is
             already the nav wordmark + the copy's H1); centered, its own
             overflow-hidden keeps any side-bleed from ever widening the page and
             clips the on-load rise. The track carries the scroll parallax; the
             span carries the on-load rise + resting translateY(12%). ── */}
      <div
        ref={trackRef}
        aria-hidden
        className="hero-wordmark-track relative z-10 flex w-full justify-center overflow-hidden"
      >
        <span className="hero-wordmark hero-anim-rise block select-none">
          Gorilla
        </span>
      </div>
    </section>
  );
}
