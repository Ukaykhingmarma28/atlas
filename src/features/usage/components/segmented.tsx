import { cn } from "@/lib/utils";

/**
 * The house segmented control (the old Console's 7d/30d/90d recipe): a hairline-bordered
 * track with flush segments, the active one on `--bg-active`. Used for the range presets,
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
        "flex h-[26px] items-center overflow-hidden rounded-md border border-[var(--border-default)]",
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
            "h-full px-2.5 text-[11px] transition-colors",
            o.value === value
              ? "bg-[var(--bg-active)] text-[var(--text-primary)]"
              : "text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-secondary)]",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
