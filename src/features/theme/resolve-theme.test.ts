import { describe, expect, it } from "vitest";
import builtinThemes from "@/dev/mock-backend/fixtures/builtin-themes.json";
import { parseColor } from "./color";
import { resolveTheme } from "./resolve-theme";
import { THEME_KEY_REGISTRY } from "./theme-key-registry";
import type { Theme } from "./lib/theme-api";

const themes = builtinThemes as Theme[];

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
});
