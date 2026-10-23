import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TAB_PLACEMENT, TAB_TYPES, type Placement, type TabType } from "@/lib/constants";
import { LAYOUT_TEMPLATES } from "@/features/layout/templates";

/**
 * Guards ADR-0024: surfaces sit beside the session, destinations take the
 * window.
 *
 * `TAB_PLACEMENT` is a `Record<TabType, …>`, so `tsc` already refuses a tab
 * type without a placement, and the destination screen's `switch` refuses a
 * destination without a page. What it cannot see is a destination being
 * offered somewhere that would put it in a column anyway: the ⌘T list, a
 * layout template, zen, or the column renderer's keep-mounted list. Each of
 * those lives in its own file, so this suite reads them.
 *
 * A full page squeezed into a column is what this ADR exists to stop. If you
 * need a destination beside the session, the answer is a peek (a compact
 * view designed for a column), not an entry in one of these lists.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf-8");

const placement = (type: TabType): Placement => TAB_PLACEMENT[type];
const DESTINATIONS = TAB_TYPES.filter((t) => placement(t).kind === "destination");
const SURFACES_ = TAB_TYPES.filter((t) => placement(t).kind === "surface");

describe("tab placement (ADR-0024)", () => {
  it("has a non-trivial set of each kind (parser smoke test)", () => {
    expect(DESTINATIONS.length).toBeGreaterThan(3);
    expect(SURFACES_.length).toBeGreaterThan(3);
    expect(TAB_TYPES.filter((t) => placement(t).kind === "session")).toEqual(["chat"]);
  });

  it("every surface declares a believable minimum width", () => {
    for (const type of SURFACES_) {
      const p = placement(type);
      if (p.kind !== "surface") continue;
      // Below 200px nothing lays out; above 600px it is not a column tool.
      expect(p.minWidth, type).toBeGreaterThanOrEqual(200);
      expect(p.minWidth, type).toBeLessThanOrEqual(600);
    }
  });

  it("the ⌘T list offers surfaces only", () => {
    const source = read("src/features/layout/lib/surfaces.ts");
    const block = source.slice(source.indexOf("export const SURFACES"));
    const offered = [...block.matchAll(/type: "([a-z-]+)"/g)].map((m) => m[1] as TabType);
    expect(offered.length).toBeGreaterThan(3);
    for (const type of offered) expect(placement(type).kind, type).not.toBe("destination");
  });

  it("no layout template puts a destination in a column, and each starts with the session", () => {
    for (const template of LAYOUT_TEMPLATES) {
      expect(template.columns[0]?.type, template.id).toBe("chat");
      for (const col of template.columns) {
        expect(placement(col.type).kind, `${template.id}: ${col.type}`).not.toBe("destination");
      }
    }
  });

  it("zen builds its columns from surfaces only", () => {
    const source = read("src/features/layout/stores/layout-store.ts");
    // The action, not its declaration in the actions interface.
    const zen = source.slice(source.indexOf("toggleZenMode: () =>\n"));
    const body = zen.slice(0, zen.indexOf("applyLayoutTemplate: (template) =>"));
    const ensured = [...body.matchAll(/ensure\("([a-z-]+)"/g)];
    expect(ensured.length).toBeGreaterThan(0);
    for (const [, type] of ensured) {
      expect(placement(type as TabType).kind, type).not.toBe("destination");
    }
  });

  it("the column renderer keeps no destination mounted", () => {
    const source = read("src/features/layout/components/center-panel.tsx");
    const match = source.match(/const PERSISTENT_TYPES_LIST = \[([\s\S]*?)\] as const/);
    expect(match).not.toBeNull();
    const kept = [...match![1].matchAll(/^\s*"([a-z-]+)",/gm)].map((m) => m[1] as TabType);
    for (const type of kept) expect(placement(type).kind, type).not.toBe("destination");
  });
});
