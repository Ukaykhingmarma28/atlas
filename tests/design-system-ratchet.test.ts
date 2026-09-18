import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The design-system ratchet (decision 33) — closed at zero.
 *
 * Foundations put the type, radius, elevation, z-index and motion scales in
 * Tailwind namespaces, but the 2026-09-17 audit found the app almost entirely
 * off them: 95% of 1,427 font-size utilities were arbitrary, nearly every
 * floating layer sat at a hand-written 9999–100000, there were 686 colour
 * literals in 141 files, and 56 inline `zIndex` values. None of that compiles
 * differently, so nothing else in the toolchain can see it — a new
 * `text-[11.5px]` type-checks, lints, renders, and is invisible until someone
 * re-reads the file.
 *
 * It ran as a RATCHET through the sweep: committed counts in
 * `design-system-ratchet.baseline.json` that could only go down. **The sweep
 * finished and every count reached zero**, so the baseline is gone and this is
 * now a ban: a new violation fails, full stop.
 *
 * That only works because the exits are real ones. A value that genuinely
 * cannot come from the scale gets `EXEMPT_FILES` (a whole file that DEFINES
 * the scale, or whose colours are not Atlas's to choose) or an inline
 * `ratchet-allow: <reason>` marker at the site. Both demand prose, and both
 * are checked: an exemption with no argument next to it fails the suite too.
 * If you are reaching for one, read what the existing entries argue before
 * adding another — "it has a lot of them" is not one of the arguments.
 *
 * Scope is `src/features/**` and `src/components/**`: the app's own surfaces.
 * `src/ui` and `src/styles` are the design system itself and define these
 * values; `src/dev` is the dev-only mock backend and never ships.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCAN_ROOTS = ["src/features", "src/components"];

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
    // The `var(` escape hatch has to survive being QUOTED: an inline style in
    // TSX is a string, so `zIndex: "var(--z-popover)"` is the correct fix and
    // the first version of this rule counted it as the violation.
    pattern: /\b(?:zIndex|fontSize|boxShadow)\s*:\s*(?!["'`]?\s*var\()["'`\d]/g,
  },
];

/**
 * Whole files inside the scanned roots that are exempt, each with the reason.
 * `src/ui` and `src/styles` are excluded wholesale because they DEFINE these
 * values; the entries below are in a feature folder for a different reason each
 * time, and the reason is the entry — a path with no argument next to it is not
 * an exemption, it is a number someone gave up on.
 *
 * Two shapes qualify and nothing else does:
 *
 *  1. **The file defines the scale.** "Use a theme key instead" cannot apply to
 *     the table a theme key resolves through.
 *  2. **The colour is not Atlas's to choose.** A third party's brand mark, a
 *     palette the USER picks a value from, or a colour that has to survive
 *     being shown over content Atlas did not draw. A theme key that could
 *     restate any of those would be a theme lying about someone else's colour.
 *
 * "It has a lot of them" is not a reason. For a single site inside an ordinary
 * file, use the inline marker below instead — it keeps the rest of the file
 * scanned.
 */
const EXEMPT_FILES: Record<string, string> = {
  "src/features/theme/theme-key-registry.ts":
    "Shape 1. The one table of Atlas's per-appearance default for every theme " +
    "key, so every entry is a colour literal by construction.",
  "src/features/agents/lib/agent-brand.ts":
    "Shape 2. The first-party agents' OWN brand colours — the one kind of " +
    "colour a theme key must not be able to restate (ADR-0002, and the " +
    "2026-09-18 key-set audit that deleted the eighteen `agent.*` keys).",
  "src/components/agent-icons.tsx":
    "Shape 2. The vendors' logo marks, drawn as inline SVG. Same argument as " +
    "`agent-brand.ts`: a recoloured logo is the wrong logo.",
  "src/components/agent-icons.test.tsx": "Shape 2. Asserts the marks above are drawn as shipped.",
  "src/features/knowledge/components/cover-picker.tsx":
    "Shape 2. The page-cover palette the user picks from. These are document " +
    "content, like a highlighter colour — the chrome around the picker is themed.",
  "src/features/spaces/lib/space-wire.ts":
    "Shape 2. The sticky-note and shape palette a user picks from on a space, " +
    "and the wire format those choices persist in. Theming them would repaint " +
    "other people's notes.",
  "src/features/spaces/lib/space-wire.test.ts": "Shape 2. Fixtures for the palette above.",
  "src/features/pdf/stores/pdf-annotation-store.ts":
    "Shape 2. Highlighter and ink colours the user picks and that are written " +
    "into the annotation, i.e. into the document.",
  "src/features/pdf/components/pdf-toolbar.tsx":
    "Shape 2. Renders the swatches for the ink colours above; the swatch has " +
    "to be the colour it applies.",
  "src/features/theme/color.ts":
    "Shape 1. The colour parser/mixer the resolver is built on. Its literals " +
    "are the identity values of the operations themselves.",
  "src/features/theme/resolve-theme.test.ts":
    "Shape 1. Fixture themes. A test for the resolver has to hand it colours.",
  "src/features/terminal/lib/line-emulator.ts":
    "Not a colour: it BUILDS `rgb(r,g,b)` strings out of the numeric " +
    "parameters of an ANSI escape sequence. The rule matches the format, not a " +
    "choice anyone made.",
  "src/features/telemetry/error-boundary.tsx":
    "Shape 2, of a kind: the last-resort screen after React has unmounted the " +
    "app. It is styled entirely inline, on purpose, so that it renders when " +
    "whatever broke was the thing that paints everything else.",
};

/**
 * A single exempt site inside an otherwise ordinary file. Put
 * `ratchet-allow: <reason>` in a comment on the line itself, or anywhere in the
 * comment block directly above it, and that line stops counting — the rest of
 * the file keeps being scanned, which a whole-file entry would give up.
 *
 * The comment BLOCK, not just the previous line: a formatter decides where a
 * long value wraps, and a marker that only worked when the value happened to
 * fit on one line would be a marker that drifts back on under `oxfmt --write`.
 *
 * The reason is not decoration: a marker with fewer than 20 characters after
 * the colon fails the suite.
 */
const ALLOW_MARKER = /ratchet-allow:\s*(.*)$/;
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*)/;
const MIN_REASON = 20;

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

interface ScanResult {
  counts: Record<string, number>;
  worst: Record<string, string[]>;
  /** Sites whose `ratchet-allow:` reason is too short to be one. */
  thinReasons: string[];
}

function scan(): ScanResult {
  const files = SCAN_ROOTS.flatMap((root) => walk(path.join(REPO_ROOT, root)));
  const counts: Record<string, number> = {};
  const perFile: Record<string, Map<string, number>> = {};
  const thinReasons: string[] = [];

  for (const rule of RULES) {
    counts[rule.id] = 0;
    perFile[rule.id] = new Map();
  }

  for (const file of files) {
    const where = path.relative(REPO_ROOT, file);
    if (where in EXEMPT_FILES) continue;
    const lines = readFileSync(file, "utf8").split("\n");
    // Line by line rather than whole-file, so one allowed site does not exempt
    // its neighbours.
    const markerFor = (i: number): RegExpExecArray | null => {
      const own = ALLOW_MARKER.exec(lines[i]);
      if (own) return own;
      // Walk back over the contiguous comment block immediately above.
      for (let j = i - 1; j >= 0 && COMMENT_LINE.test(lines[j]); j--) {
        const found = ALLOW_MARKER.exec(lines[j]);
        if (found) return found;
      }
      return null;
    };
    const counted = lines
      .map((line, i) => {
        const marker = markerFor(i);
        if (!marker) return line;
        if (marker[1].trim().length < MIN_REASON) {
          thinReasons.push(`${where}:${i + 1} — "${marker[1].trim()}"`);
        }
        return "";
      })
      .join("\n");
    for (const rule of RULES) {
      const hits = counted.match(rule.pattern)?.length ?? 0;
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
  return { counts, worst, thinReasons };
}

describe("design-system ratchet", () => {
  const { counts, worst, thinReasons } = scan();

  it("every `ratchet-allow` carries a real reason", () => {
    // The marker is only worth having if writing one costs an argument.
    expect(
      thinReasons,
      [
        "A `ratchet-allow:` with no reason after it is just a suppression.",
        ...thinReasons.map((line) => `  ${line}`),
      ].join("\n"),
    ).toEqual([]);
  });

  it("every exempt file states why", () => {
    const thin = Object.entries(EXEMPT_FILES)
      .filter(([, reason]) => reason.trim().length < 40)
      .map(([file]) => file);
    expect(thin, "An exempt file with no argument next to it is a number someone gave up on.")
      .toEqual([]);
  });

  for (const rule of RULES) {
    it(`has no \`${rule.id}\``, () => {
      expect(
        counts[rule.id],
        [
          `${counts[rule.id]} \`${rule.id}\` in src/features + src/components; the target is 0.`,
          `Use instead: ${rule.instead}`,
          `Worst files: ${worst[rule.id].join(", ") || "none"}`,
          "",
          "If the value truly cannot come from the scale, put",
          "`ratchet-allow: <why>` in a comment on the line or the block above it —",
          "and make the reason an argument, because that comment is the record.",
          "",
          "The scales live in src/styles/globals.css; the reference is docs/reference/design-system.md.",
        ].join("\n"),
      ).toBe(0);
    });
  }
});
