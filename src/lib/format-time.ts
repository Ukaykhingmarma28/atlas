/**
 * Times of day in the user's `timeFormat`: a 12- or 24-hour clock, or the
 * system's. Every place Atlas shows a time goes through here, so the setting
 * reaches all of them.
 *
 * The format is held here rather than read from the settings store, so these
 * pure helpers stay importable anywhere (tests included) without pulling in
 * the store and its IPC. The settings store pushes it in with
 * `setTimeFormat` on load and on every change; a view shows it on its next
 * render.
 */

export type TimeFormat = "system" | "12h" | "24h";

let current: TimeFormat = "system";

export function setTimeFormat(format: TimeFormat): void {
  current = format;
}

export function timeFormat(): TimeFormat {
  return current;
}

/** `hourCycle` for the active format; nothing for "system", so the locale
 *  decides. Not `hour12: false`: some engines read that as the `h24` cycle for
 *  a 12-hour locale and print midnight as "24:05". */
export function hourCycle(): { hourCycle?: "h12" | "h23" } {
  if (current === "12h") return { hourCycle: "h12" };
  if (current === "24h") return { hourCycle: "h23" };
  return {};
}

type DateInput = Date | number | string;

const SHORT_TIME: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit" };

/** A time of day, e.g. "3:07 PM" or "15:07". `options` picks the fields. */
export function formatTime(
  at: DateInput,
  options: Intl.DateTimeFormatOptions = SHORT_TIME,
  locale?: string | string[],
): string {
  return new Date(at).toLocaleTimeString(locale, { ...options, ...hourCycle() });
}

/** A date with its time, e.g. "Oct 22, 2026, 3:07 PM". */
export function formatDateTime(
  at: DateInput,
  options?: Intl.DateTimeFormatOptions,
  locale?: string | string[],
): string {
  return new Date(at).toLocaleString(locale, { ...options, ...hourCycle() });
}

const MONTH_DAY: Intl.DateTimeFormatOptions = { month: "numeric", day: "numeric" };
const MONTH_DAY_YEAR: Intl.DateTimeFormatOptions = { ...MONTH_DAY, year: "numeric" };

/**
 * A message's time, as short as it can be without hiding the day: "4:34 PM"
 * today, "yesterday at 4:34 PM", "10/22 4:34 PM" earlier this year and
 * "10/22/2025 4:34 PM" before that. Days are compared at local midnight, so a
 * DST day of 23 or 25 hours still counts as one.
 *
 * `now` is a parameter so a test can pin it. A row calls this when it renders,
 * and rows re-render rarely, so on a session left open past midnight "today"
 * goes stale until the row next renders. That is the cheap side of the trade
 * against a ticking clock in every row.
 */
export function formatDayAwareTime(
  at: DateInput,
  now: DateInput = Date.now(),
  locale?: string | string[],
): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "";
  const time = formatTime(date, SHORT_TIME, locale);
  const today = new Date(now);
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const startOfDay = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((startOfToday - startOfDay) / 86_400_000);
  // A message stamped slightly ahead of this clock still reads as today.
  if (days <= 0) return time;
  if (days === 1) return `yesterday at ${time}`;
  const sameYear = date.getFullYear() === today.getFullYear();
  return `${date.toLocaleDateString(locale, sameYear ? MONTH_DAY : MONTH_DAY_YEAR)} ${time}`;
}

const FULL_DATE: Intl.DateTimeFormatOptions = {
  weekday: "long",
  year: "numeric",
  month: "long",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
};

/** The whole date and time, for the tooltip behind a short timestamp:
 *  "Thursday, October 22, 2026 at 4:34 PM". */
export function formatFullTimestamp(at: DateInput, locale?: string | string[]): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "";
  return formatDateTime(date, FULL_DATE, locale);
}
