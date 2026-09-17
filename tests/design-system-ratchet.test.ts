import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The design-system ratchet (decision 33).
 *
 * Foundations put the type, radius, elevation, z-index and motion scales in
 * Tailwind namespaces, but the 2026-09-17 audit found the app almost entirely
 * off them: 95% of 1,427 font-size utilities are arbitrary, nearly every
 * floating layer sits at a hand-written 9999–100000, there are 686 colour
 * literals in 141 files, and 56 inline `zIndex` values. None of that compiles
 * differently, so nothing in the toolchain can see it — a new `text-[11.5px]`
 * type-checks, lints, renders, and is invisible until someone re-reads the
 * file.
 *
 * So this is a RATCHET, not a ban. The counts below are committed as a
 * baseline in `design-system-ratchet.baseline.json`, and the suite fails when
 * one goes UP. It also fails when one goes DOWN without the baseline being
 * re-committed — that is what makes each improvement permanent rather than
 * something the next commit can quietly spend.
 *
 * **The sweep (PR 4) drives every one of these to zero.** When it does, delete
 * the baseline file and turn the `<=` assertions into `=== 0` with whatever
 * allowlist survives. Until then: do not "fix" a violation you happen to walk
 * past as a side errand — the sweep does it per feature folder, with visual
 * checks on `?scenario=design-system`, and a scattered half-migration is
 * harder to review than the whole thing at once.
 *
 * Scope is `src/features/**` and `src/components/**`: the app's own surfaces.
 * `src/ui` and `src/styles` are the design system itself and define these
 * values; `src/dev` is the dev-only mock backend and never ships.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCAN_ROOTS = ["src/features", "src/components"];
const BASELINE_PATH = path.join(REPO_ROOT, "tests", "design-system-ratchet.baseline.json");

/** `UPDATE_RATCHET_BASELINE=1 bun run test` rewrites the committed counts. */
const UPDATING = process.env.UPDATE_RATCHET_BASELINE === "1";

interface Rule {
  id: string;
  /** What to write instead. Printed on failure, so keep it actionable. */
  instead: string;
  pattern: RegExp;
}

const RULES: Rule[] = [
  {
    id: "arbitrary-text-size",
    instead: "text-3xs … text-2xl (decision 24). Half-pixel sizes round UP.",
    pattern: /\btext-\[-?\d*\.?\d+(?:px|rem|em|pt)\]/g,
  },
  {
    id: "arbitrary-z-index",
    instead:
      "z-panel / z-titlebar / z-overlay / z-modal / z-popover / z-toast / z-tooltip / z-drag (decision 28).",
    pattern: /\bz-\[[^\]]+\]/g,
  },
  {
    id: "arbitrary-shadow",
    instead:
      "shadow-sm (raised) / shadow-md (menus) / shadow-lg (dialogs), plus inset-highlight (decision 27).",
    pattern: /\bshadow-\[[^\]]+\]/g,
  },
  {
    id: "arbitrary-radius",
    instead: "rounded (= sm) / rounded-md / rounded-lg / rounded-xl / rounded-full (decision 26).",
    pattern: /\brounded(?:-(?:t|r|b|l|tl|tr|br|bl|s|e|ss|se|es|ee))?-\[[^\]]+\]/g,
  },
  {
    id: "colour-literal",
    instead: "a base token or an --atlas-* theme key; see docs/reference/theme-keys.md.",
    pattern: /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/g,
  },
  {
    id: "bg-white-black",
    instead: "bg-background / bg-card / bg-bg-elevated — white and black are not theme-neutral.",
    pattern: /\bbg-(?:white|black)(?:\/\d+)?\b/g,
  },
  {
    id: "inline-numeric-style",
    instead: "a class from the scale; an inline style cannot be swept and cannot be themed.",
    pattern: /\b(?:zIndex|fontSize|boxShadow)\s*:\s*(?!\s*var\()["'`\d]/g,
  },
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(full));
    } else if (/\.(ts|tsx|css)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function scan(): { counts: Record<string, number>; worst: Record<string, string[]> } {
  const files = SCAN_ROOTS.flatMap((root) => walk(path.join(REPO_ROOT, root)));
  const counts: Record<string, number> = {};
  const perFile: Record<string, Map<string, number>> = {};

  for (const rule of RULES) {
    counts[rule.id] = 0;
    perFile[rule.id] = new Map();
  }

  for (const file of files) {
    const source = readFileSync(file, "utf8");
    const where = path.relative(REPO_ROOT, file);
    for (const rule of RULES) {
      const hits = source.match(rule.pattern)?.length ?? 0;
      if (hits === 0) continue;
      counts[rule.id] += hits;
      perFile[rule.id].set(where, hits);
    }
  }

  const worst: Record<string, string[]> = {};
  for (const rule of RULES) {
    worst[rule.id] = [...perFile[rule.id].entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([file, n]) => `${file} (${n})`);
  }
  return { counts, worst };
}

function readBaseline(): Record<string, number> {
  return JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Record<string, number>;
}

describe("design-system ratchet", () => {
  const { counts, worst } = scan();

  if (UPDATING) {
    it("rewrites the baseline", () => {
      writeFileSync(BASELINE_PATH, `${JSON.stringify(counts, null, 2)}\n`);
      expect(Object.keys(counts).length).toBe(RULES.length);
    });
    return;
  }

  const baseline = readBaseline();

  it("has a baseline entry for every rule", () => {
    // A rule added without a baseline would otherwise pass vacuously.
    expect(Object.keys(baseline).sort()).toEqual(RULES.map((r) => r.id).sort());
  });

  for (const rule of RULES) {
    it(`does not add a new \`${rule.id}\``, () => {
      const allowed = baseline[rule.id];
      expect(
        counts[rule.id],
        [
          `${counts[rule.id]} \`${rule.id}\` in src/features + src/components, baseline ${allowed}.`,
          `Use instead: ${rule.instead}`,
          `Worst files: ${worst[rule.id].join(", ") || "none"}`,
          "",
          "The scales live in src/styles/globals.css; the reference is docs/reference/design-system.md.",
        ].join("\n"),
      ).toBeLessThanOrEqual(allowed);
    });
  }

  it("has a baseline that is not stale", () => {
    const lowered = RULES.filter((rule) => counts[rule.id] < baseline[rule.id]).map(
      (rule) => `${rule.id}: ${baseline[rule.id]} → ${counts[rule.id]}`,
    );
    expect(
      lowered,
      [
        "The ratchet only tightens if the win is committed. Counts dropped:",
        ...lowered.map((line) => `  ${line}`),
        "",
        "Re-commit the baseline: UPDATE_RATCHET_BASELINE=1 bun run test",
      ].join("\n"),
    ).toEqual([]);
  });
});
