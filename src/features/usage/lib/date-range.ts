/**
 * Local-day arithmetic for the Usage dashboard. Every key is a local "YYYY-MM-DD" string — the
 * same key Rust emits — so comparisons are plain string comparisons and nothing here touches
 * a timezone twice.
 */

import type { DateRange, RangePreset } from "../types";

export const PRESET_DAYS: Record<Exclude<RangePreset, "custom">, number | null> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
  all: null,
};

const pad = (n: number) => String(n).padStart(2, "0");

/** Local calendar day of a Date as "YYYY-MM-DD". */
export function dayKey(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Local midnight of a "YYYY-MM-DD" key. */
export function parseDay(key: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
}

/** `key` shifted by `days` calendar days (DST-safe: goes through local midnight). */
export function addDays(key: string, days: number): string {
  const d = parseDay(key);
  d.setDate(d.getDate() + days);
  return dayKey(d);
}

/** Inclusive day count between two keys (`from` ≤ `to`). */
export function spanDays(from: string, to: string): number {
  const a = parseDay(from).getTime();
  const b = parseDay(to).getTime();
  return Math.round((b - a) / 86_400_000) + 1;
}

export interface ResolvedRange {
  /** Inclusive; `null` = unbounded (the "all" preset). */
  from: string | null;
  /** Inclusive. */
  to: string;
}

/** Concrete bounds for a range, ending today for presets. */
export function resolveRange(range: DateRange, today = dayKey(new Date())): ResolvedRange {
  if (range.preset === "custom") {
    const to = range.to ?? today;
    const from = range.from ?? to;
    return from <= to ? { from, to } : { from: to, to: from };
  }
  const days = PRESET_DAYS[range.preset];
  if (days === null) return { from: null, to: today };
  return { from: addDays(today, -(days - 1)), to: today };
}

/**
 * The window of equal length ending the day before `range` starts — what the period-over-period
 * deltas compare against. `null` for the unbounded preset, and for a custom range that starts
 * before the earliest known day (there is nothing to compare with).
 */
export function previousRange(resolved: ResolvedRange): ResolvedRange | null {
  if (resolved.from === null) return null;
  const n = spanDays(resolved.from, resolved.to);
  const to = addDays(resolved.from, -1);
  return { from: addDays(to, -(n - 1)), to };
}

export function inRange(day: string, r: ResolvedRange): boolean {
  return (r.from === null || day >= r.from) && day <= r.to;
}

/** Monday of the week containing `key`, as a key — the week-bucket id. */
export function weekKey(key: string): string {
  const d = parseDay(key);
  const dow = (d.getDay() + 6) % 7; // Mon=0
  d.setDate(d.getDate() - dow);
  return dayKey(d);
}

/** "Sep 17" / "Sep 17, 2025" when the year differs from now. */
export function fmtDay(key: string, now = new Date()): string {
  const d = parseDay(key);
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

/** "Sep 11 – Sep 17" for a resolved range; "All time" when unbounded. */
export function fmtRange(r: ResolvedRange): string {
  if (r.from === null) return "All time";
  if (r.from === r.to) return fmtDay(r.from);
  return `${fmtDay(r.from)} – ${fmtDay(r.to)}`;
}

export function epochToDay(ms: number): string {
  return dayKey(new Date(ms));
}
