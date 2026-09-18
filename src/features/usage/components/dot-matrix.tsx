import { useMemo } from "react";
import { cn } from "@/lib/utils";
import { useMounted } from "@/components/usage-primitives";

/**
 * A trend drawn as a dot matrix — the headline figures' sparkline.
 *
 * One column per day, each a stack of seven dots rising from a baseline row
 * that is always lit, so a quiet day still reads as a day rather than as a gap
 * in the chart. Seven rows rather than five because the resolution is what the
 * shape is made of: at five, a day at a third of the peak and one at half drew
 * the same column. It is the same family as the tick meters elsewhere in this tab and as
 * the body's glyph chart: marks on a grid rather than a smooth path, which at
 * this size is legible where a 14px line is a smudge.
 *
 * `null` in the series means "no value today" (a rate with no denominator, not
 * a rate of zero) and draws as an empty column — the baseline dot dims for it,
 * so an undefined day is visibly different from a zero one.
 */
export function DotMatrix({
  values,
  rows = 7,
  className,
  /** Cap the columns drawn, keeping the most recent — a year does not fit. */
  maxColumns = 60,
}: {
  values: ReadonlyArray<number | null>;
  rows?: number;
  className?: string;
  maxColumns?: number;
}) {
  const mounted = useMounted();
  const columns = useMemo(
    () => (values.length > maxColumns ? values.slice(values.length - maxColumns) : values),
    [values, maxColumns],
  );
  const max = useMemo(
    () => columns.reduce<number>((m, v) => (v !== null && v > m ? v : m), 0),
    [columns],
  );
  if (columns.length === 0) return null;

  return (
    <div className={cn("flex h-[30px] items-end gap-[1.5px]", className)} aria-hidden>
      {columns.map((v, i) => {
        // Every non-zero day lights at least one dot above the baseline: a day
        // that did a hundredth of the peak still happened, and rounding it to
        // the floor erased the long tail of ordinary days entirely.
        const lit =
          v === null || max <= 0 ? 0 : v <= 0 ? 0 : Math.max(1, Math.round((v / max) * rows));
        const newest = i === columns.length - 1;
        return (
          <div key={i} className="flex min-w-0 flex-1 flex-col-reverse items-center gap-[1.5px]">
            {Array.from({ length: rows }, (_, r) => {
              const on = mounted && r < lit;
              // The baseline row stands in for the axis and stays visible.
              const base = r === 0;
              return (
                <span
                  key={r}
                  // A fixed 3px round dot rather than a full-width bar: at one
                  // column per day a bar filling its column closes the gaps
                  // into a solid block — which is a bar chart, not the matrix
                  // this is meant to be. Seven rows of 3px on a 1.5px pitch
                  // come to exactly the 30px the container reserves.
                  className="block size-[3px] shrink-0 rounded-full"
                  style={{
                    background: newest && on ? "var(--foreground)" : "var(--secondary-foreground)",
                    opacity: on ? (newest ? 1 : 0.85) : base ? (v === null ? 0.1 : 0.22) : 0.07,
                    transition: "opacity 260ms ease-out",
                    transitionDelay: `${Math.min(i, 40) * 8}ms`,
                  }}
                />
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
