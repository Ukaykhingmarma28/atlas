import { describe, expect, it } from "vitest";
import {
  nextAfterSettling,
  placeProjectNames,
  sortThreads,
  splitSettled,
} from "./sidebar-grouping";

const row = (projectName: string, elsewhere = false) => ({ projectName, elsewhere });

describe("placeProjectNames", () => {
  it("names nothing inside the open project", () => {
    expect(placeProjectNames([row("atlas"), row("atlas")], false)).toEqual([
      { heading: null, showProject: false },
      { heading: null, showProject: false },
    ]);
  });

  it("names a row from another project on its own card", () => {
    expect(placeProjectNames([row("atlas"), row("docs", true)], false)).toEqual([
      { heading: null, showProject: false },
      { heading: null, showProject: true },
    ]);
  });

  it("heads each run of a mixed list, and names no card", () => {
    const placed = placeProjectNames(
      [row("atlas", true), row("atlas", true), row("docs", true), row("atlas", true)],
      true,
    );
    expect(placed.map((p) => p.heading)).toEqual(["atlas", null, "docs", "atlas"]);
    expect(placed.every((p) => !p.showProject)).toBe(true);
  });

  it("heads a list with only one project when no project is open", () => {
    expect(placeProjectNames([row("atlas", true)], true)[0]!.heading).toBe("atlas");
  });

  it("heads what the filter left, not what it removed", () => {
    // The first "docs" row was filtered out; the next one still gets the heading.
    expect(placeProjectNames([row("atlas"), row("docs")], true).map((p) => p.heading)).toEqual([
      "atlas",
      "docs",
    ]);
  });
});

describe("sortThreads", () => {
  const rows = [
    { threadId: "a", updatedAt: "2026-10-03T00:00:00Z", createdAt: "2026-10-01T00:00:00Z" },
    { threadId: "b", updatedAt: "2026-10-02T00:00:00Z", createdAt: "2026-10-02T00:00:00Z" },
    { threadId: "c", updatedAt: "2026-09-30T00:00:00Z", createdAt: null },
  ];

  it("keeps Rust's latest-activity order for recent", () => {
    expect(sortThreads(rows, "recent")).toBe(rows);
  });

  it("puts the most recently started first for created, counting an unknown start from its activity", () => {
    expect(sortThreads(rows, "created").map((r) => r.threadId)).toEqual(["b", "a", "c"]);
  });
});

describe("splitSettled", () => {
  const settleable = (threadId: string, settledAt: string | null) => ({ threadId, settledAt });

  it("keeps the active rows in order and puts the newest settled first", () => {
    const { active, settled } = splitSettled([
      settleable("a", null),
      settleable("old", "2026-10-01T00:00:00Z"),
      settleable("b", null),
      settleable("new", "2026-10-05T00:00:00Z"),
    ]);
    expect(active.map((r) => r.threadId)).toEqual(["a", "b"]);
    expect(settled.map((r) => r.threadId)).toEqual(["new", "old"]);
  });
});

describe("nextAfterSettling", () => {
  const rows = ["a", "b", "c"].map((threadId) => ({ threadId }));

  it("moves to the row below, or above from the bottom", () => {
    expect(nextAfterSettling(rows, "a")?.threadId).toBe("b");
    expect(nextAfterSettling(rows, "c")?.threadId).toBe("b");
  });

  it("has nowhere to go from the only row", () => {
    expect(nextAfterSettling([{ threadId: "a" }], "a")).toBeNull();
  });

  it("starts at the top when the settled row was not in the list", () => {
    expect(nextAfterSettling(rows, "gone")?.threadId).toBe("a");
  });
});
