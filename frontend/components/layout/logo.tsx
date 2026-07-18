import { cn } from "@/lib/utils";

export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn("flex items-center", className)}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/gorilla-logo.svg" alt="Gorilla Markets" className="h-6 w-auto" />
    </span>
  );
}
