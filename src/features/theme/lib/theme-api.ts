import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type ThemeMode = "system" | "dark" | "light";
export type ThemeAppearance = "dark" | "light";
/** The table spelling of a theme key. Rust rejects a `font_style` here:
 *  nothing between a theme key and CodeMirror, highlight.js or the markdown
 *  renderer can carry one, so accepting it would render upright in silence. */
export type ThemeKeyStyle = { color: string };
export type ThemeKeyValue = string | ThemeKeyStyle;

export interface ThemeVariant {
  base: Record<string, string>;
  palette: Record<string, string>;
  keys: Record<string, ThemeKeyValue>;
}

export interface Theme {
  schema: number;
  id: string;
  name: string;
  author: string;
  license: string;
  dark?: ThemeVariant;
  light?: ThemeVariant;
  /** Omitted by Rust when there are no forward-compatibility warnings. */
  warnings?: ThemeWarning[];
}

export interface ThemeWarning {
  key: string;
  message: string;
}

export interface ThemeSummary {
  id: string;
  name: string;
  author: string;
  license: string;
  hasDark: boolean;
  hasLight: boolean;
  builtIn: boolean;
  warnings: ThemeWarning[];
}

/** The picker's whole view of disk: what loaded, and what did not. */
export interface ThemeCatalogSummary {
  themes: ThemeSummary[];
  /** One entry per user theme file that could not be loaded at all, keyed by
   *  file name. Empty on a healthy install. */
  warnings: ThemeWarning[];
}

export const THEMES_CHANGED_EVENT = "atlas:themes-changed";

export function listThemes(): Promise<ThemeCatalogSummary> {
  return invoke("list_themes");
}

export function getTheme(id: string): Promise<Theme> {
  return invoke("get_theme", { id });
}

export function onThemesChanged(callback: () => void): Promise<UnlistenFn> {
  return listen(THEMES_CHANGED_EVENT, callback);
}
