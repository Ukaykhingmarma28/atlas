import { cn } from "@/lib/utils";

/**
 * The house segmented control (the old Console's 7d/30d/90d recipe): a hairline-bordered
 * track with flush segments, the active one on `--atlas-element-active`. Used for the range presets,
 * the group-by axis and the chart metric.
 */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  className,
}: {
  /** `null` = nothing active (a custom range beside the presets). */
  value: T | null;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (v: T) => void;
  /** Accessible name for the group. */
  label: string;
  className?: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn(
        "flex h-control-md items-center overflow-hidden rounded-md border border-[var(--border)]",
        className,
      )}
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          onClick={() => onChange(o.value)}
          className={cn(
            "h-full px-2.5 text-xs transition-colors",
            o.value === value
              ? "bg-[var(--atlas-element-active)] text-[var(--foreground)]"
              : "text-[var(--muted-foreground)] hover:bg-[var(--atlas-element-hover)] hover:text-[var(--secondary-foreground)]",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
