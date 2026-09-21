import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import builtinThemes from "@/dev/mock-backend/fixtures/builtin-themes.json";
import { resolveTheme } from "@/features/theme/resolve-theme";
import type { Theme } from "@/features/theme/lib/theme-api";

/**
 * Every CSS custom property `src/` reads must be one something defines.
 *
 * A `var(--name)` with no definition is not an error anywhere: the browser
 * drops the declaration to the inherited or initial value, silently. The
 * theme is where almost every
 * variable comes from, so a key renamed or dropped from the theme leaves every
 * rule that named it painting nothing. A variable counts as defined when the
 * resolved theme produces it, when a stylesheet or inline style under `src/`
 * declares it, or when it is on the allowlist below with the reason.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(REPO_ROOT, "src");
const themes = builtinThemes as Theme[];

function walk(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return walk(target);
    return /\.(?:css|ts|tsx)$/.test(entry.name) ? [target] : [];
  });
}

/** CSS engine variables are supplied by the popup engine at runtime, not Atlas. */
const CSS_VAR_ALLOWLIST: Record<string, string> = {
  "--transform-origin": "Base UI runtime positioning",
  "--anchor-width": "Base UI runtime positioning",
  "--available-height": "Base UI runtime positioning",
  "--available-width": "Base UI runtime positioning",
  "--fg": "component-local gradient foreground",
  "--diff-sx": "component-local diff transform",
  "--i": "component-local animation index",
  "--x": "component-local chart-tooltip offset",
  "--atlas-pulse-color": "component-local animation colour",
  "--atlas-ants-color": "component-local animation colour",
  "--atlas-beam-travel": "component-local animation distance",
};

describe("CSS custom properties", () => {
  it("covers every CSS custom property referenced under src", () => {
    const files = walk(SRC);
    const text = files.map((file) => readFileSync(file, "utf8")).join("\n");
    const references = new Set(
      [...text.matchAll(/var\((--[A-Za-z0-9_-]+)/g)].map((match) => match[1]),
    );
    const declared = new Set(
      [...text.matchAll(/(--[A-Za-z0-9_-]+)\s*:/g)].map((match) => match[1]),
    );
    const produced = new Set<string>([
      ...Object.keys(resolveTheme(themes[0], "dark").cssVars),
      ...Object.keys(themes[0].dark!.base).map((key) => `--${key}`),
    ]);

    const missing = [...references]
      .filter((variable) => !produced.has(variable) && !declared.has(variable))
      .filter((variable) => !(variable in CSS_VAR_ALLOWLIST));
    expect(missing).toEqual([]);
  });
});
