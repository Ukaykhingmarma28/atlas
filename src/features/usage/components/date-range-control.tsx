import { useMemo, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import type { DateRange, RangePreset } from "../types";
import { addDays, dayKey, fmtRange, parseDay, resolveRange } from "../lib/date-range";
import { Segmented } from "./segmented";

const PRESETS: ReadonlyArray<{ value: Exclude<RangePreset, "custom">; label: string }> = [
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
  { value: "90d", label: "90d" },
  { value: "all", label: "All" },
];

/**
 * Range presets plus a custom picker. The custom picker is a hand-rolled month grid (no date
 * library in the bundle): first click sets the start, second the end, either order; hovering
 * previews the span. Two months side by side would be the desktop convention, but the popover
 * sits in a 32px header and one month reads faster.
 */
export function DateRangeControl({
  range,
  onChange,
  /** Earliest day with any data, so the grid greys out days before it. */
  earliest,
}: {
  range: DateRange;
  onChange: (r: DateRange) => void;
  earliest: string | null;
}) {
  const today = dayKey(new Date());
  const resolved = resolveRange(range, today);
  const [open, setOpen] = useState(false);
  const isCustom = range.preset === "custom";

  return (
    <div className="flex items-center gap-1.5">
      <Segmented
        label="Range preset"
        value={isCustom ? null : range.preset}
        options={PRESETS}
        onChange={(preset) => onChange({ preset })}
      />
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger asChild>
          <button
            type="button"
            title="Custom range"
            className={cn(
              "flex h-[26px] items-center gap-1.5 rounded-md border px-2 text-[11px] transition-colors outline-none",
              isCustom
                ? "border-[var(--border-strong)] bg-[var(--bg-active)] text-[var(--text-primary)]"
                : "border-[var(--border-default)] text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-secondary)]",
            )}
          >
            <CalendarDays size={12} />
            <span className="tabular-nums">{isCustom ? fmtRange(resolved) : "Custom"}</span>
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            align="end"
            sideOffset={6}
            className="z-[var(--z-max)] rounded-lg border border-[var(--border-default)] bg-[var(--bg-elevated)] p-2 shadow-[var(--shadow-overlay)] outline-none"
          >
            <MonthGrid
              from={isCustom ? (resolved.from ?? today) : null}
              to={isCustom ? resolved.to : null}
              today={today}
              earliest={earliest}
              onPick={(from, to) => {
                onChange({ preset: "custom", from, to });
                setOpen(false);
              }}
            />
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}

const WEEKDAY = ["M", "T", "W", "T", "F", "S", "S"];

function MonthGrid({
  from,
  to,
  today,
  earliest,
  onPick,
}: {
  from: string | null;
  to: string | null;
  today: string;
  earliest: string | null;
  onPick: (from: string, to: string) => void;
}) {
  const [cursor, setCursor] = useState(() => {
    const base = parseDay(to ?? today);
    return new Date(base.getFullYear(), base.getMonth(), 1);
  });
  const [anchor, setAnchor] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);

  const days = useMemo(() => {
    const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
    const lead = (first.getDay() + 6) % 7; // Monday-first
    const count = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0).getDate();
    const cells: Array<string | null> = Array.from({ length: lead }, () => null);
    for (let d = 1; d <= count; d++)
      cells.push(dayKey(new Date(cursor.getFullYear(), cursor.getMonth(), d)));
    while (cells.length % 7) cells.push(null);
    return cells;
  }, [cursor]);

  // The span being shown: a committed range, or the anchor→hover preview mid-pick.
  const [selFrom, selTo] = anchor
    ? [anchor, hover ?? anchor].sort()
    : from && to
      ? [from, to]
      : [null, null];

  const monthLabel = cursor.toLocaleDateString(undefined, { month: "long", year: "numeric" });

  const pick = (day: string) => {
    if (!anchor) {
      setAnchor(day);
      return;
    }
    const [a, b] = [anchor, day].sort();
    setAnchor(null);
    setHover(null);
    onPick(a, b);
  };

  return (
    <div className="w-[224px] select-none">
      <div className="flex items-center justify-between px-0.5 pb-1.5">
        <button
          type="button"
          aria-label="Previous month"
          className="flex size-5 items-center justify-center rounded text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
          onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1))}
        >
          <ChevronLeft size={12} />
        </button>
        <span className="text-[11px] font-medium text-[var(--text-primary)]">{monthLabel}</span>
        <button
          type="button"
          aria-label="Next month"
          className="flex size-5 items-center justify-center rounded text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] disabled:opacity-30"
          disabled={dayKey(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1)) > today}
          onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1))}
        >
          <ChevronRight size={12} />
        </button>
      </div>
      <div className="grid grid-cols-7 gap-px">
        {WEEKDAY.map((w, i) => (
          <span
            key={i}
            className="flex h-5 items-center justify-center text-[9px] font-medium uppercase tracking-wider text-[var(--text-tertiary)]"
          >
            {w}
          </span>
        ))}
        {days.map((day, i) => {
          if (!day) return <span key={i} />;
          const future = day > today;
          const before = earliest !== null && day < earliest;
          const inSel = selFrom !== null && selTo !== null && day >= selFrom && day <= selTo;
          const edge = day === selFrom || day === selTo;
          return (
            <button
              key={day}
              type="button"
              disabled={future}
              onMouseEnter={() => anchor && setHover(day)}
              onClick={() => pick(day)}
              className={cn(
                "flex h-6 items-center justify-center text-[11px] tabular-nums transition-colors",
                edge
                  ? "rounded-md bg-[var(--text-primary)] text-[var(--text-inverse)]"
                  : inSel
                    ? "bg-[var(--bg-active)] text-[var(--text-primary)]"
                    : "rounded-md text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]",
                future && "cursor-default text-[var(--text-ghost)] hover:bg-transparent",
                before && !inSel && "text-[var(--text-muted)]",
                day === today &&
                  !edge &&
                  "underline decoration-[var(--text-tertiary)] underline-offset-2",
              )}
            >
              {Number(day.slice(-2))}
            </button>
          );
        })}
      </div>
      <div className="mt-1.5 flex items-center justify-between px-0.5 text-[10px] text-[var(--text-tertiary)]">
        <span>{anchor ? "Pick the end day" : "Pick two days"}</span>
        <button
          type="button"
          className="hover:text-[var(--text-primary)]"
          onClick={() => onPick(addDays(today, -6), today)}
        >
          This week
        </button>
      </div>
    </div>
  );
}
