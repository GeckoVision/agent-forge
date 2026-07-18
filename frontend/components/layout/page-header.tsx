import { cn } from "@/lib/utils";

export function PageHeader({
  eyebrow,
  title,
  description,
  className,
}: {
  eyebrow: string;
  title: string;
  /** A string, or a node when a page needs styled copy (e.g. a dimmed technical footnote). */
  description?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-4", className)}>
      <span className="eyebrow text-primary">{eyebrow}</span>
      <h1 className="display-l">{title}</h1>
      {description && (
        <p className="body-l max-w-2xl text-muted-foreground text-pretty">
          {description}
        </p>
      )}
    </div>
  );
}
