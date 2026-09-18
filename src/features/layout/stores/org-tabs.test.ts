// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { ORG_SCOPED_TYPES, PROJECTLESS_TYPES, type TabType } from "@/lib/constants";
// The store's own predicates, not copies: a re-implementation here would keep
// passing after the store stopped applying the rule.
import { persistsInEditorState, restoredTabType } from "./layout-store";

/**
 * Org-scoped tabs must never reach the per-project editor state.
 *
 * That file is keyed by PROJECT PATH, and the same project is commonly open
 * in more than one org. A persisted `spaces-{convId}` tab therefore came back
 * on the INCOMING org's mount still pointing at the outgoing org's
 * conversation, rendering "This Space is no longer available" — closing the
 * tab on switch could not fix it, because the restore happened afterwards.
 */

/** The persist filter `buildEditorState` applies (save and flush). */
function persistable(tabs: Array<{ type: TabType; closable: boolean }>) {
  return tabs.filter(persistsInEditorState);
}

/** The types the editor-state restore brings back, for files written before the fix. */
function restorable(types: string[]) {
  return types.map(restoredTabType).filter((t) => t !== null);
}

describe("org-scoped tab persistence", () => {
  const tabs: Array<{ type: TabType; closable: boolean }> = [
    { type: "editor", closable: true },
    { type: "spaces", closable: true },
    { type: "comms-draft", closable: true },
    { type: "settings", closable: true },
    { type: "chat", closable: false },
  ];

  it("never writes spaces or draft tabs to the project's editor state", () => {
    const kept = persistable(tabs).map((t) => t.type);
    expect(kept).not.toContain("spaces");
    expect(kept).not.toContain("comms-draft");
    // Everything else that was persisted before still is.
    expect(kept).toEqual(["editor", "settings"]);
  });

  it("refuses to restore them from a file written before the fix", () => {
    expect(restorable(["editor", "spaces", "comms-draft"])).toEqual(["editor"]);
  });

  it("settings is projectless but NOT org-scoped — it survives a switch", () => {
    expect(PROJECTLESS_TYPES.has("settings")).toBe(true);
    expect(ORG_SCOPED_TYPES.has("settings")).toBe(false);
  });

  it("usage is org-scoped: it closes on switch and never persists per project", () => {
    expect(ORG_SCOPED_TYPES.has("usage")).toBe(true);
    expect(persistable([{ type: "usage", closable: true }])).toEqual([]);
  });

  it("a persisted Console tab migrates to usage before the org-scoped guard drops it", () => {
    expect(restorable(["mission-control"])).toEqual([]);
  });

  it("an unknown persisted type is dropped, a known one comes back as itself", () => {
    expect(restorable(["no-such-tab-type", "settings"])).toEqual(["settings"]);
  });

  it("every org-scoped type is also projectless (they open with no project)", () => {
    for (const type of ORG_SCOPED_TYPES) {
      expect(PROJECTLESS_TYPES.has(type)).toBe(true);
    }
  });
});
