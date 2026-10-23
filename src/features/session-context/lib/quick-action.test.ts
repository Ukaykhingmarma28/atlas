import { describe, expect, it } from "vitest";
import { resolveQuickAction, type QuickActionInput } from "./quick-action";

const base: QuickActionInput = {
  isRepo: true,
  branch: "feat/x",
  detached: false,
  changedFiles: 0,
  upstream: "origin/feat/x",
  ahead: 0,
  behind: 0,
  busy: false,
};

const kindOf = (patch: Partial<QuickActionInput>) =>
  resolveQuickAction({ ...base, ...patch })?.kind ?? null;

describe("resolveQuickAction", () => {
  it("offers nothing outside a repository", () => {
    expect(resolveQuickAction({ ...base, isRepo: false })).toBeNull();
  });

  it("is a hint while a git op runs, whatever else is true", () => {
    expect(kindOf({ busy: true, ahead: 3 })).toBe("hint");
  });

  it("asks for a branch when HEAD is detached", () => {
    expect(kindOf({ detached: true, ahead: 1 })).toBe("hint");
  });

  it("sends local changes to Source Control, since a commit needs a message", () => {
    const action = resolveQuickAction({ ...base, changedFiles: 2 });
    expect(action).toEqual({ kind: "open-changes", label: "Commit & push…" });
    expect(resolveQuickAction({ ...base, changedFiles: 2, upstream: null })?.label).toBe("Commit…");
  });

  it("publishes a branch with no upstream", () => {
    expect(kindOf({ upstream: null })).toBe("publish");
    expect(kindOf({ upstream: null, ahead: 4 })).toBe("publish");
  });

  it("refuses to guess on a diverged branch", () => {
    expect(kindOf({ ahead: 1, behind: 1 })).toBe("hint");
  });

  it("pulls when behind and pushes when ahead", () => {
    expect(kindOf({ behind: 2 })).toBe("pull");
    expect(kindOf({ ahead: 2 })).toBe("push");
  });

  it("says so when there is nothing to do", () => {
    expect(resolveQuickAction(base)).toMatchObject({ kind: "hint", label: "Push" });
  });
});
