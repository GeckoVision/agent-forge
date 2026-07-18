import { Ban, CircleCheck } from "lucide-react";

const EXCUSES = ["“Under review.”", "“Check back later.”", "Somehow it went the other way."];
const PROMISES = [
  "No person decides who won.",
  "No company holds your cash.",
  "The match data decides — the payout is automatic.",
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
          You win. Then the excuses start.
        </h2>
        <p className="body-l mt-6 max-w-2xl text-muted-foreground text-pretty">
          “Under review.” “Check back later.” Or a result that somehow went the
          other way. You did everything right and walked away with nothing.
          Gorilla ends that — no person decides who won, no company holds your
          cash. The match data decides, and the payout is automatic.
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
              You won. You waited. You got nothing.
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
              You win, you get paid. Full stop.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
