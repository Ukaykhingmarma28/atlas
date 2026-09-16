// @vitest-environment happy-dom
//
// `removed-agents` pulls in the chat store, which touches `window` at import.

import { describe, expect, it } from "vitest";
import type { AgentCatalogEntry } from "@/types/agent-catalog";
import { uninstalledBetween } from "./removed-agents";

function entry(id: string, installed: boolean, kind = "external"): AgentCatalogEntry {
  return { id, agentType: id, installed, kind } as AgentCatalogEntry;
}

describe("uninstalledBetween", () => {
  it("names an external that was installed and no longer is", () => {
    expect(
      uninstalledBetween(
        [entry("cersei", true, "native"), entry("claude-acp", true), entry("codex-acp", true)],
        [entry("cersei", true, "native"), entry("codex-acp", true)],
      ),
    ).toEqual(["claude-acp"]);
  });

  it("treats an entry flipping to installed=false the same as one that vanished", () => {
    expect(uninstalledBetween([entry("claude-acp", true)], [entry("claude-acp", false)])).toEqual([
      "claude-acp",
    ]);
  });

  it("reports nothing for an install, a no-op hydrate, or a detected-only entry", () => {
    expect(
      uninstalledBetween(
        [entry("codex-acp", true)],
        [entry("codex-acp", true), entry("claude-acp", true)],
      ),
    ).toEqual([]);
    expect(uninstalledBetween([entry("codex-acp", true)], [entry("codex-acp", true)])).toEqual([]);
    expect(uninstalledBetween([entry("cursor", false)], [])).toEqual([]);
  });

  it("never reads the first hydrate as a mass uninstall", () => {
    // Pre-hydration the catalog is empty; the native agent alone is not a
    // removal either.
    expect(uninstalledBetween([], [entry("cersei", true, "native")])).toEqual([]);
    expect(uninstalledBetween([entry("cersei", true, "native")], [])).toEqual([]);
  });
});
