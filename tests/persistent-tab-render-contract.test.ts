import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Guards `CenterPanel`'s persistent-tab render block against `PERSISTENT_TYPES`
 * silently drifting apart from it.
 *
 * `TabContentContainer` mounts persistent tab types (editor/terminal/browser/
 * knowledge-graph/pdf/chat/knowledge/settings/spaces — the ones kept alive
 * across a tab switch per `PERSISTENT_TYPES`) through an if/else-if chain
 * keyed on `tab.type`, ending in an unconditional `<TerminalPanel/>` fallback.
 * `tsc` cannot catch a type missing its own branch here: `tab.type` is typed
 * as the full `TabType` union regardless of which chain member is reached, so
 * every branch — including the fallback — type-checks whether or not it is
 * the *right* component. A type added to `PERSISTENT_TYPES` without a branch
 * here does not fail to compile and does not throw; it silently falls into
 * the terminal branch and renders a terminal instead of itself.
 *
 * This happened for real: commit 32767aff8 ("comms UI update", 2026-09-11)
 * added `"spaces"` to `PERSISTENT_TYPES` and `IDLE_EXPENSIVE_TYPES` but never
 * added a `tab.type === "spaces"` branch, so opening a Space tab mounted
 * `TerminalPanel`. Nothing in the toolchain caught it because nothing checks
 * that these two lists agree.
 *
 * We parse source text rather than rendering the component, matching
 * `ipc-contract.test.ts` / `state-payload-contract.test.ts`: it is cheap,
 * needs no DOM/store mocking, and inspects the exact thing that can drift —
 * the literal strings — rather than trying to simulate every tab type's
 * store dependencies to observe what actually mounted.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CENTER_PANEL_PATH = path.join(
  REPO_ROOT,
  "src",
  "features",
  "layout",
  "components",
  "center-panel.tsx",
);

/**
 * The persistent type that the if/else-if chain deliberately falls back to
 * when nothing else matches, instead of carrying its own `tab.type === "..."`
 * check. This is the one legitimate reason a `PERSISTENT_TYPES` entry can be
 * absent from the literal-match scan below — everything else must be
 * explicit, on pain of silently becoming this fallback too.
 */
const DELIBERATE_FALLBACK_TYPE = "terminal";

function readSource(): string {
  return readFileSync(CENTER_PANEL_PATH, "utf-8");
}

/** Pulls the quoted string literals out of the `PERSISTENT_TYPES` Set literal. */
function parsePersistentTypes(source: string): string[] {
  const match = source.match(
    /const PERSISTENT_TYPES: ReadonlySet<TabType> = new Set\(\[([\s\S]*?)\]\);/,
  );
  if (!match) {
    throw new Error(
      "Could not find `PERSISTENT_TYPES` in center-panel.tsx — the parser needs updating to match a reshaped declaration.",
    );
  }
  return [...match[1].matchAll(/"([a-z-]+)"/g)].map((m) => m[1]);
}

/**
 * Pulls every `tab.type === "..."` literal referenced inside the
 * `persistentTabs.map(...)` render block — the chat early-return and the
 * editor/knowledge/browser/knowledge-graph/pdf/settings/spaces ternary chain
 * both use this shape, so one regex over the whole block catches both.
 */
function parseHandledTypesInPersistentRenderBlock(source: string): string[] {
  const startMarker = "persistentTabs.map((tab) => {";
  const endMarker = "{activeIsNonPersistent &&";
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(
      "Could not locate the persistentTabs.map render block in center-panel.tsx — the parser needs updating to match a reshaped render.",
    );
  }
  const block = source.slice(start, end);
  return [...block.matchAll(/tab\.type === "([a-z-]+)"/g)].map((m) => m[1]);
}

describe("CenterPanel persistent-tab render contract", () => {
  it("finds a non-trivial PERSISTENT_TYPES set (parser smoke test)", () => {
    const persistentTypes = parsePersistentTypes(readSource());
    // Floor well under the real count (9 at time of writing) — a smoke alarm
    // for "the regex stopped matching", not a coverage target.
    expect(persistentTypes.length).toBeGreaterThanOrEqual(5);
  });

  it("gives every PERSISTENT_TYPES entry its own branch in the render block", () => {
    const source = readSource();
    const persistentTypes = parsePersistentTypes(source);
    const handled = new Set([
      ...parseHandledTypesInPersistentRenderBlock(source),
      DELIBERATE_FALLBACK_TYPE,
    ]);

    const missing = persistentTypes.filter((t) => !handled.has(t));

    expect(
      missing,
      `PERSISTENT_TYPES contains ${JSON.stringify(missing)} with no matching ` +
        `\`tab.type === "..."\` branch in the persistentTabs.map render block ` +
        `of center-panel.tsx. Without one it silently falls into the ` +
        `"${DELIBERATE_FALLBACK_TYPE}" fallback and mounts the wrong panel ` +
        `(this is exactly how the Spaces tab regressed in 32767aff8).`,
    ).toEqual([]);
  });
});
