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
 * The handful of colours the boot skeleton needs.
 *
 * Deliberately NOT the whole resolved map: this is read synchronously on the
 * critical path of every cold start, and seven values is a string small enough
 * that parsing it costs nothing.
 */
function launchColors(resolved: ResolvedTheme) {
  return {
    appearance: resolved.appearance,
    background: resolved.base.background,
    chrome: resolved.base.sidebar,
    card: resolved.base.card,
    line: resolved.keys["border.subtle"],
    skeleton: resolved.keys["element.selected"],
    text: resolved.base["muted-foreground"],
  };
}

/**
 * Cache them for the next cold start. Failure is silent and harmless —
 * `index.html` falls back to the literals it has always had (a blocked or full
 * store, or a private window, all land there).
 */
function cacheLaunchColors(colors: ReturnType<typeof launchColors>): void {
  try {
    localStorage.setItem(LAUNCH_CACHE_KEY, JSON.stringify(colors));
  } catch {
    /* an unavailable store just means the compiled-in fallbacks */
  }
}

/**
 * Re-run, against the theme being applied now, what `index.html`'s inline boot
 * script did at launch against the cached one.
 *
 * These are INLINE properties on `<html>`, set before any stylesheet loads, and
 * `index.html` binds the root `background` and — the part that matters — the
 * root `color-scheme` to them. An inline property on the element beats the
 * `:root{…}` block `applyTheme` writes into `<head>`, so leaving them alone
 * meant that after any runtime switch the page kept the PREVIOUS theme's
 * `color-scheme` and root background for the rest of the session: native
 * scrollbars, form controls, `<select>` popups and the caret all stayed on the
 * old appearance while everything Atlas draws itself had already changed.
 *
 * Kept byte-for-byte in step with the `set(…)` calls in `index.html` — the two
 * write the same property names from the same seven values, which is why both
 * go through `launchColors()`.
 */
function applyBootVars(root: HTMLElement, colors: ReturnType<typeof launchColors>): void {
  const set = (name: string, value: string | undefined) => {
    if (value) root.style.setProperty(name, value);
    else root.style.removeProperty(name);
  };
  set("--atlas-boot-bg", colors.background);
  set("--atlas-boot-chrome", colors.chrome);
  set("--atlas-boot-card", colors.card);
  set("--atlas-boot-line", colors.line);
  set("--atlas-boot-skeleton", colors.skeleton);
  set("--atlas-boot-text", colors.text);
  set("--atlas-boot-scheme", colors.appearance);
}

/**
 * Which appearance a mode resolves to.
 *
 * `system` asks the OS. It used to be forced to `dark` behind a
 * `LIGHT_APPEARANCE_ENABLED` flag while the light pass was unfinished —
 * hiding the Light button alone was not enough, because the OS decides what
 * `system` means and anyone on a light Mac was landed in the unfinished light
 * UI at boot, having never chosen it and with no visible control to get out.
 * Every folder has had its light pass now, so the flag is gone and `system`
 * means what it says.
 *
 * A theme with no light variant is NOT a reason to refuse: `resolveTheme`
 * falls back to the theme's other variant, which is the documented schema-1
 * behaviour.
 */
export function appearanceForMode(mode: ThemeMode): "dark" | "light" {
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
  const colors = launchColors(resolved);
  applyBootVars(root, colors);
  cacheLaunchColors(colors);
  window.dispatchEvent(new CustomEvent("atlas:theme-applied"));
  return resolved;
}

export function getActiveTheme(): ResolvedTheme | null {
  return activeTheme;
}
