import { Ban, CircleCheck } from "lucide-react";

const EXCUSES = [
  "The old bookie: “under review,” “check back later.”",
  "Win too often, and your account gets limited.",
  "The new apps: big players push the number right at the end.",
];
const PROMISES = [
  "Nobody decides who won.",
  "Nobody holds your money.",
  "The winner is the real score — and no one can move that.",
];

/** The emotional contrast beat — a dark, atmospheric purple→gold poster band. */
export function ProblemSection() {
  return (
    <section
      aria-label="The problem"
      className="relative isolate overflow-hidden border-y border-border"
    >
      {/* dark atmospheric wash: purple top-left → gold bottom-right, over the
          violet-charcoal base, with a faint grain film. Kept dark on purpose. */}
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
        <div
          className="absolute inset-0"
          style={{
            background:
              "radial-gradient(72% 64% at 12% -6%, color-mix(in oklch, var(--primary) 34%, transparent), transparent 62%), radial-gradient(64% 68% at 98% 108%, color-mix(in oklch, var(--gold) 22%, transparent), transparent 62%), linear-gradient(120deg, color-mix(in oklch, var(--primary) 16%, transparent) 0%, transparent 56%)",
          }}
        />
        <div className="poster-grain absolute inset-0" />
      </div>

      <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6 sm:py-28">
        <p className="eyebrow flex items-center gap-2 text-gold">
          <span aria-hidden className="font-display text-base">
            {"//"}
          </span>
          The problem
        </p>
        <h2 className="display-poster mt-4 max-w-3xl text-balance">
          The bet is fair. The payout is where they get you.
        </h2>
        <p className="body-l mt-6 max-w-2xl text-muted-foreground text-pretty">
          The old bookie stalls your payout, or limits your account when you keep
          winning. The newer betting apps have a quieter problem: when you’re
          betting on a price that people can trade, big players shove that price
          around at the last second to win the bet. Researchers measured it in
          2026 — the money came{" "}
          <span className="text-foreground">mostly from regular players</span>.
        </p>
        <p className="body-l mt-4 max-w-2xl text-muted-foreground text-pretty">
          Both come down to the same thing: you can’t trust who decides the
          result. Gorilla decides it with the one thing nobody can push around —
          the final score.{" "}
          <a
            href="https://arxiv.org/abs/2606.31675"
            target="_blank"
            rel="noopener noreferrer"
            className="text-gold underline decoration-gold/40 underline-offset-4 hover:decoration-gold"
          >
            See the research →
          </a>
        </p>

        <div className="mt-12 grid gap-4 md:grid-cols-2">
          <div className="rounded-xl border border-no/25 bg-no/[0.06] p-6 backdrop-blur-sm">
            <span className="eyebrow text-no">Everywhere else</span>
            <ul className="mt-4 flex flex-col gap-3">
              {EXCUSES.map((e) => (
                <li key={e} className="flex items-center gap-3 text-sm">
                  <Ban className="size-4 shrink-0 text-no" />
                  <span className="text-muted-foreground">{e}</span>
                </li>
              ))}
            </ul>
            <p className="mt-5 border-t border-no/20 pt-4 text-sm font-medium text-foreground">
              Different trick, same ending: someone else decides if you won.
            </p>
          </div>

          <div className="rounded-xl border border-primary/30 bg-primary/[0.07] p-6 backdrop-blur-sm">
            <span className="eyebrow text-primary">Gorilla</span>
            <ul className="mt-4 flex flex-col gap-3">
              {PROMISES.map((p) => (
                <li key={p} className="flex items-center gap-3 text-sm">
                  <CircleCheck className="size-4 shrink-0 text-yes" />
                  <span className="text-foreground">{p}</span>
                </li>
              ))}
            </ul>
            <p className="mt-5 border-t border-primary/20 pt-4 text-sm font-semibold text-primary">
              Nobody in the middle. You win, you get paid.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
