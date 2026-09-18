import { describe, expect, it } from "vitest";
import {
  addDays,
  fmtRange,
  inRange,
  previousRange,
  resolveRange,
  spanDays,
  weekKey,
} from "./date-range";

const TODAY = "2026-09-17";

describe("resolveRange", () => {
  it("presets end today and span N days inclusive", () => {
    expect(resolveRange({ preset: "7d" }, TODAY)).toEqual({ from: "2026-09-11", to: TODAY });
    expect(resolveRange({ preset: "30d" }, TODAY)).toEqual({ from: "2026-08-19", to: TODAY });
    expect(resolveRange({ preset: "90d" }, TODAY)).toEqual({ from: "2026-06-20", to: TODAY });
    expect(spanDays("2026-08-19", TODAY)).toBe(30);
  });

  it("'all' is unbounded on the left", () => {
    expect(resolveRange({ preset: "all" }, TODAY)).toEqual({ from: null, to: TODAY });
  });

  it("custom keeps the given bounds and swaps them when reversed", () => {
    expect(resolveRange({ preset: "custom", from: "2026-01-01", to: "2026-01-31" })).toEqual({
      from: "2026-01-01",
      to: "2026-01-31",
    });
    expect(resolveRange({ preset: "custom", from: "2026-01-31", to: "2026-01-01" })).toEqual({
      from: "2026-01-01",
      to: "2026-01-31",
    });
  });

  it("custom with a missing bound collapses to the other (or today)", () => {
    expect(resolveRange({ preset: "custom", from: "2026-02-03" }, TODAY)).toEqual({
      from: "2026-02-03",
      to: TODAY,
    });
    expect(resolveRange({ preset: "custom", to: "2026-02-03" }, TODAY)).toEqual({
      from: "2026-02-03",
      to: "2026-02-03",
    });
  });
});

describe("previousRange", () => {
  it("is the same length and ends the day before the range starts", () => {
    const r = resolveRange({ preset: "7d" }, TODAY);
    const p = previousRange(r)!;
    expect(p).toEqual({ from: "2026-09-04", to: "2026-09-10" });
    expect(spanDays(p.from!, p.to)).toBe(spanDays(r.from!, r.to));
    expect(addDays(p.to, 1)).toBe(r.from);
  });

  it("handles a one-day window", () => {
    expect(previousRange({ from: "2026-03-01", to: "2026-03-01" })).toEqual({
      from: "2026-02-28",
      to: "2026-02-28",
    });
  });

  it("is null for the unbounded preset", () => {
    expect(previousRange({ from: null, to: TODAY })).toBeNull();
  });
});

describe("weekKey", () => {
  it("is the Monday of the containing week", () => {
    expect(weekKey("2026-09-17")).toBe("2026-09-14"); // Thursday → Monday
    expect(weekKey("2026-09-14")).toBe("2026-09-14"); // Monday stays
    expect(weekKey("2026-09-20")).toBe("2026-09-14"); // Sunday belongs to the week before
    expect(weekKey("2026-09-21")).toBe("2026-09-21");
  });
});

describe("day arithmetic", () => {
  it("spanDays is inclusive", () => {
    expect(spanDays("2026-01-01", "2026-01-01")).toBe(1);
    expect(spanDays("2026-01-01", "2026-01-10")).toBe(10);
    expect(spanDays("2026-02-27", "2026-03-02")).toBe(4);
  });

  it("addDays crosses a spring-forward date without drifting", () => {
    // US DST began 2026-03-08; a 23-hour day would otherwise land on the 7th.
    expect(addDays("2026-03-07", 1)).toBe("2026-03-08");
    expect(addDays("2026-03-07", 2)).toBe("2026-03-09");
    expect(addDays("2026-03-09", -2)).toBe("2026-03-07");
    // EU DST began 2026-03-29.
    expect(addDays("2026-03-28", 1)).toBe("2026-03-29");
    expect(addDays("2026-03-28", 2)).toBe("2026-03-30");
    // Fall back too.
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2026-11-01", 1)).toBe("2026-11-02");
  });

  it("addDays crosses month and year boundaries", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("inRange uses inclusive bounds and honours an open start", () => {
    const r = { from: "2026-01-10", to: "2026-01-20" };
    expect(inRange("2026-01-10", r)).toBe(true);
    expect(inRange("2026-01-20", r)).toBe(true);
    expect(inRange("2026-01-09", r)).toBe(false);
    expect(inRange("2026-01-21", r)).toBe(false);
    expect(inRange("1999-01-01", { from: null, to: "2026-01-20" })).toBe(true);
  });

  it("fmtRange reads 'All time' for the unbounded preset", () => {
    expect(fmtRange({ from: null, to: TODAY })).toBe("All time");
    expect(fmtRange({ from: "2026-09-17", to: "2026-09-17" })).not.toContain("–");
    expect(fmtRange({ from: "2026-09-11", to: "2026-09-17" })).toContain("–");
  });
});
