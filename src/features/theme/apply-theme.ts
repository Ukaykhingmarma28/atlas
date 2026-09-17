import type { Theme, ThemeMode } from "./lib/theme-api";
import { resolveTheme, type ResolvedTheme, type ThemeOverride } from "./resolve-theme";

const STYLE_ID = "atlas-resolved-theme";
let activeTheme: ResolvedTheme | null = null;

/**
 * The one switch for the light appearance. Flip it to `true` when the
 * app-wide light sweep is finished, and nothing else needs to change: the
 * Light button appears in the theme picker and `system` starts honouring the
 * OS again.
 *
 * While it is `false`, `system` must resolve to `dark`. Hiding the Light
 * button alone was not enough — the OS decides what `system` means, so anyone
 * on a light Mac was landed in the unfinished light UI at boot, having never
 * chosen it and with no visible control to get out.
 */
export const LIGHT_APPEARANCE_ENABLED = false;

export function appearanceForMode(mode: ThemeMode): "dark" | "light" {
  if (!LIGHT_APPEARANCE_ENABLED) return "dark";
  if (mode !== "system") return mode;
  if (typeof matchMedia === "undefined") return "dark";
  return matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export function applyTheme(
  theme: Theme,
  mode: ThemeMode,
  themeOverride: ThemeOverride = {},
): ResolvedTheme {
  const resolved = resolveTheme(theme, appearanceForMode(mode), themeOverride);
  activeTheme = resolved;
  if (typeof document === "undefined") return resolved;

  const root = document.documentElement;
  root.classList.toggle("dark", resolved.appearance === "dark");
  root.dataset.theme = theme.id;
  root.dataset.themeAppearance = resolved.appearance;

  let style = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement("style");
    style.id = STYLE_ID;
    document.head.append(style);
  }
  const declarations = Object.entries(resolved.cssVars)
    .map(([name, value]) => `${name}:${value}`)
    .join(";");
  style.textContent = `:root{${declarations}}`;
  window.dispatchEvent(new CustomEvent("atlas:theme-applied"));
  return resolved;
}

export function getActiveTheme(): ResolvedTheme | null {
  return activeTheme;
}
