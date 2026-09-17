import { describe, expect, it } from "vitest";
import {
  LEGACY_TAB_TYPES,
  ORG_SCOPED_TYPES,
  PROJECTLESS_TYPES,
  TAB_TYPES,
  migrateTabType,
} from "./constants";

describe("migrateTabType", () => {
  it("maps the legacy Console tab forward to Usage", () => {
    expect(migrateTabType("mission-control")).toBe("usage");
    expect(LEGACY_TAB_TYPES["mission-control"]).toBe("usage");
  });

  it("passes every current type through unchanged", () => {
    for (const t of TAB_TYPES) expect(migrateTabType(t)).toBe(t);
  });

  it("returns null for a type this build does not know", () => {
    expect(migrateTabType("pomodoro")).toBeNull();
    expect(migrateTabType("")).toBeNull();
  });

  it("every legacy target is a current type", () => {
    for (const target of Object.values(LEGACY_TAB_TYPES)) expect(TAB_TYPES).toContain(target);
  });
});

describe("usage tab scoping", () => {
  it("is an org surface: projectless and org-scoped", () => {
    expect(PROJECTLESS_TYPES.has("usage")).toBe(true);
    expect(ORG_SCOPED_TYPES.has("usage")).toBe(true);
  });
});
