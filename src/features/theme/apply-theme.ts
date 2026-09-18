import type { Theme, ThemeMode } from "./lib/theme-api";
import { resolveTheme, type ResolvedTheme, type ThemeOverride } from "./resolve-theme";

const STYLE_ID = "atlas-resolved-theme";
/**
 * Where `index.html` looks for the last theme's launch colours. Read by an
 * inline script before any module — and before `tokens.css` — so the boot
 * skeleton paints in the theme the user chose instead of flashing black.
 */
const LAUNCH_CACHE_KEY = "atlas:launch-theme";
let activeTheme: ResolvedTheme | null = null;

/**
 * Cache the handful of colours the boot skeleton needs.
 *
 * Deliberately NOT the whole resolved map: this is read synchronously on the
 * critical path of every cold start, and six values is a string small enough
 * that parsing it costs nothing. Failure is silent and harmless — `index.html`
 * falls back to the literals it has always had (a blocked or full store, or a
 * private window, all land there).
 */
function cacheLaunchColors(resolved: ResolvedTheme): void {
  try {
    localStorage.setItem(
      LAUNCH_CACHE_KEY,
      JSON.stringify({
        appearance: resolved.appearance,
        background: resolved.base.background,
        chrome: resolved.base.sidebar,
        card: resolved.base.card,
        line: resolved.keys["border.subtle"],
        skeleton: resolved.keys["element.selected"],
        text: resolved.base["muted-foreground"],
      }),
    );
  } catch {
    /* an unavailable store just means the compiled-in fallbacks */
  }
}

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
export const LIGHT_APPEARANCE_ENABLED = true;

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
  cacheLaunchColors(resolved);
  window.dispatchEvent(new CustomEvent("atlas:theme-applied"));
  return resolved;
}

export function getActiveTheme(): ResolvedTheme | null {
  return activeTheme;
}
