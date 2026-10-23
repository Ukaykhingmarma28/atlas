import { describe, expect, it } from "vitest";
import { MAX_REMEMBERED_SCOPES, withRecent } from "./diff-panel-store";

describe("withRecent", () => {
  it("moves a re-set key to the end", () => {
    const next = withRecent({ a: 1, b: 2 }, "a", 3);
    expect(Object.entries(next)).toEqual([
      ["b", 2],
      ["a", 3],
    ]);
  });

  it("drops the oldest past the cap", () => {
    let record: Record<string, number> = {};
    for (let i = 0; i < MAX_REMEMBERED_SCOPES + 5; i++) record = withRecent(record, `tab${i}`, i);
    const keys = Object.keys(record);
    expect(keys).toHaveLength(MAX_REMEMBERED_SCOPES);
    expect(keys[0]).toBe("tab5");
    expect(keys[keys.length - 1]).toBe(`tab${MAX_REMEMBERED_SCOPES + 4}`);
  });
});
