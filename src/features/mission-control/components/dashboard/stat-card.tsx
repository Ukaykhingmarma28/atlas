import { cn } from "@/lib/utils";

/** A single metric tile — label, big value, optional sub-line + accent dot. */
export function StatCard({
  label,
  value,
  sub,
  accent,
  className,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "rounded-lg border border-[var(--border)] bg-[var(--card)] px-3.5 py-3 flex flex-col gap-1.5",
        className,
      )}
    >
      <div className="flex items-center gap-1.5">
        {accent && (
          <span className="h-1.5 w-1.5 rounded-full shrink-0" style={{ backgroundColor: accent }} />
        )}
        <span className="text-3xs font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">
          {label}
        </span>
      </div>
      <span className="text-xl font-mono tabular-nums text-[var(--foreground)] leading-none">
        {value}
      </span>
      {sub && <span className="text-2xs text-[var(--muted-foreground)] font-mono">{sub}</span>}
    </div>
  );
}
