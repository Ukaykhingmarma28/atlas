import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import builtinThemes from "@/dev/mock-backend/fixtures/builtin-themes.json";
import { parseColor } from "./color";
import { resolveTheme } from "./resolve-theme";
import { THEME_KEY_REGISTRY } from "./theme-key-registry";
import type { Theme } from "./lib/theme-api";

const themes = builtinThemes as Theme[];
const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

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
  "--atlas-pulse-color": "component-local animation colour",
  "--atlas-beam-travel": "component-local animation distance",
};

describe("theme resolution", () => {
  it.each(
    themes.flatMap((theme) =>
      (["dark", "light"] as const).map(
        (appearance) => [`${theme.id}/${appearance}`, theme, appearance] as const,
      ),
    ),
  )("resolves every key for %s", (_name, theme, appearance) => {
    const resolved = resolveTheme(theme, appearance);

    expect(Object.keys(resolved.keys)).toHaveLength(THEME_KEY_REGISTRY.length);
    for (const [key, value] of Object.entries(resolved.keys)) {
      expect(parseColor(value), `${theme.id}/${appearance}: ${key} = ${value}`).not.toBeNull();
    }
  });

  it("applies base, palette, and key overrides after the theme", () => {
    const resolved = resolveTheme(themes[0], "dark", {
      base: { foreground: "#123456" },
      palette: { red: "#654321" },
      keys: { "syntax.keyword": "#abcdef" },
    });

    expect(resolved.base.foreground).toBe("#123456");
    expect(resolved.keys["terminal.ansi.red"]).toBe("#654321");
    expect(resolved.keys["syntax.keyword"]).toBe("#abcdef");
  });

  it("covers every CSS custom property referenced under src", () => {
    const files = walk(sourceRoot);
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
