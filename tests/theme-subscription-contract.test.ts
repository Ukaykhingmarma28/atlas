import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Every consumer that reads a RESOLVED theme colour must have a way to hear
 * that the theme changed.
 *
 * Most of Atlas recolours for free, because a CSS rule naming `var(--atlas-…)`
 * is late-bound: `applyTheme` rewrites the `:root` block and the next paint is
 * the new theme. The exceptions are the subsystems that cannot use a custom
 * property — a canvas, a WebGL scene, an xterm `ITheme`, a recharts `fill`, a
 * CodeMirror extension, a mermaid `themeVariables` — and they take a colour as
 * a VALUE, snapshotted at the moment they ask for it.
 *
 * A snapshot taken at construction and never refreshed is invisible in every
 * check that mounts the tree under the theme it is testing, which is how every
 * review of this work had been done. It only shows as "the terminal kept One
 * Dark's palette after I switched" once the app has been running a while. So
 * the invariant is enforced structurally: if a file calls a resolved-value
 * reader, it must also carry a subscription — or say, in a
 * `theme-subscription-allow:` comment, why it does not need one.
 *
 * The three ways to hear about it, all of them the same
 * `atlas:theme-applied` event that `applyTheme` dispatches:
 *
 *   `onThemeApplied(cb)`   imperative owners (xterm, the two pixi scenes)
 *   `useThemeVersion()`    React (recharts, mermaid, the dither field)
 *   a raw `window.addEventListener(THEME_APPLIED_EVENT, …)` (CodeMirror,
 *                          which reconfigures a compartment rather than
 *                          re-rendering)
 *
 * The browser pass of 2026-09-18 confirmed all seven subsystems repaint on a
 * switch-while-mounted; this is what keeps them that way.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(REPO_ROOT, "src");

/** Reading any of these hands back a colour VALUE, not a `var()` reference. */
const READER = /\b(?:themeColor|themeBase|themeDerived|themeHex|getActiveTheme)\s*\(/;

/** Any of these means the file is told when the theme changed. */
const SUBSCRIBER =
  /\b(?:onThemeApplied|useThemeVersion)\s*\(|THEME_APPLIED_EVENT|atlas:theme-applied/;

const ALLOW_MARKER = /theme-subscription-allow:\s*(.*)$/m;
const MIN_REASON = 40;

/**
 * Files that read a resolved value and legitimately do not subscribe. The
 * reason is the entry — this list is short on purpose, and every addition is a
 * claim someone has to be able to check.
 */
const EXEMPT: Record<string, string> = {
  "src/features/theme/apply-theme.ts":
    "It IS the applier. It reads the resolved theme because it just produced it, and it is what dispatches the event everything else listens to.",
  "src/features/theme/theme-values.ts":
    "It IS the reader, and the subscription machinery — `onThemeApplied` and `useThemeVersion` are defined here.",
  "src/features/editor/themes/build-cm-theme.ts":
    "A pure builder: it turns a `ResolvedTheme` into CodeMirror extensions and holds nothing. Its two callers (`editor-panel.tsx`, `draft-editor.tsx`) subscribe and re-run it, which is the only place a subscription could do any good.",
  "src/features/terminal/lib/terminal-theme.ts":
    "A pure builder for xterm's `ITheme`. `terminal-session.ts` subscribes once for every session and calls this from `retheme()`.",
  "src/components/graph-palette.ts":
    "A pure builder for the two pixi scenes. Each scene subscribes and swaps the palette object it returns.",
  "src/features/canvas/lib/canvas-export.ts":
    "Runs once, on an explicit export. There is no live surface to keep in step — the colours are baked into a file the user asked for.",
  "src/features/mission-control/lib/export.ts": "Same as `canvas-export.ts`: a one-shot export.",
};

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

interface Reader {
  where: string;
  subscribes: boolean;
  allowReason: string | null;
}

const readers: Reader[] = walk(SRC).flatMap((file) => {
  const text = readFileSync(file, "utf8");
  if (!READER.test(text)) return [];
  const marker = ALLOW_MARKER.exec(text);
  return [
    {
      where: path.relative(REPO_ROOT, file),
      subscribes: SUBSCRIBER.test(text),
      allowReason: marker ? marker[1].trim() : null,
    },
  ];
});

describe("theme subscription contract", () => {
  it("finds the readers at all (no vacuous pass)", () => {
    // Well under the real count (13 at the time of writing): a smoke alarm for
    // "the regex stopped matching", not a coverage target.
    expect(readers.length).toBeGreaterThanOrEqual(8);
    // And the seven subsystems the 2026-09-18 review named as the risk are all
    // still in the set, by the path they live at.
    for (const file of [
      "src/features/terminal/lib/terminal-theme.ts", // xterm
      "src/components/graph-palette.ts", // both pixi graphs
      "src/features/mission-control/lib/chart-theme.ts", // recharts
      "src/features/editor/themes/build-cm-theme.ts", // CodeMirror
      "src/components/mermaid-block.tsx", // mermaid
    ]) {
      expect(
        readers.map((r) => r.where),
        `${file} no longer reads a resolved theme value — has it moved?`,
      ).toContain(file);
    }
  });

  it("every resolved-value reader hears about a theme change", () => {
    const deaf = readers
      .filter((r) => !r.subscribes && !(r.where in EXEMPT) && r.allowReason === null)
      .map((r) => r.where);
    expect(
      deaf,
      [
        "These read a RESOLVED theme colour and would keep the palette they were",
        "constructed with after a switch — the failure a freshly-mounted check",
        "cannot see. Subscribe with `onThemeApplied` / `useThemeVersion` / a",
        "`THEME_APPLIED_EVENT` listener, or add a `theme-subscription-allow:`",
        "comment saying why the value cannot go stale.",
        ...deaf.map((f) => `  ${f}`),
      ].join("\n"),
    ).toEqual([]);
  });

  it("every exemption is real and still earning it", () => {
    const thin = Object.entries(EXEMPT)
      .filter(([, reason]) => reason.trim().length < MIN_REASON)
      .map(([file]) => file);
    expect(thin, "An exemption with no argument next to it is a suppression.").toEqual([]);

    const gone = Object.keys(EXEMPT).filter((f) => !readers.some((r) => r.where === f));
    expect(gone, "These exempt files no longer read a resolved value. Delete the entry.").toEqual(
      [],
    );

    const inline = readers.filter(
      (r) => r.allowReason !== null && r.allowReason.length < MIN_REASON,
    );
    expect(
      inline.map((r) => r.where),
      "A `theme-subscription-allow:` with no reason after it is a suppression.",
    ).toEqual([]);
  });

  /**
   * The other half of the pair: the subsystems that subscribe must still be
   * reading a resolved value somewhere in their own module or a builder they
   * call. A subscription with nothing to refresh is dead code that reads as
   * coverage.
   */
  it("names the owner that subscribes for each builder", () => {
    const owns: Record<string, string[]> = {
      "src/features/terminal/lib/terminal-theme.ts": [
        "src/features/terminal/lib/terminal-session.ts",
      ],
      "src/components/graph-palette.ts": [
        "src/features/knowledge/components/knowledge-graph.tsx",
        "src/features/memory/components/memory-graph-canvas.tsx",
      ],
      "src/features/editor/themes/build-cm-theme.ts": [
        "src/features/editor/components/editor-panel.tsx",
        "src/features/comms/components/draft-editor.tsx",
      ],
    };
    for (const [builder, owners] of Object.entries(owns)) {
      for (const owner of owners) {
        const text = readFileSync(path.join(REPO_ROOT, owner), "utf8");
        expect(SUBSCRIBER.test(text), `${owner} stopped subscribing for ${builder}`).toBe(true);
      }
    }
  });
});
