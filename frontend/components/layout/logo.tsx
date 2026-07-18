import { cn } from "@/lib/utils";

/** A Merkle-node glyph: a root node fed by two leaves — the settlement thesis as a mark. */
export function Logo({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      fill="none"
      className={cn("size-7", className)}
      aria-hidden
    >
      <rect
        x="1"
        y="1"
        width="30"
        height="30"
        rx="7"
        fill="var(--secondary)"
        stroke="var(--primary)"
        strokeOpacity="0.45"
        strokeWidth="1"
      />
      <path
        d="M16 7 L16 13 M16 13 L10 19 M16 13 L22 19"
        stroke="var(--primary)"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
      <circle cx="16" cy="7" r="2.4" fill="var(--primary)" />
      <circle cx="10" cy="20" r="2.4" fill="var(--accent)" />
      <circle cx="22" cy="20" r="2.4" fill="var(--accent)" />
      <circle cx="16" cy="13" r="1.6" fill="var(--foreground)" />
    </svg>
  );
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn("flex items-center gap-2", className)}>
      <Logo />
      <span className="text-[15px] font-semibold tracking-tight">
        Gorilla
        <span className="text-muted-foreground"> Markets</span>
      </span>
    </span>
  );
}
