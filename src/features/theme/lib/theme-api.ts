import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type ThemeMode = "system" | "dark" | "light";
export type ThemeAppearance = "dark" | "light";
export type ThemeKeyStyle = { color: string; font_style?: string };
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

export const THEMES_CHANGED_EVENT = "atlas:themes-changed";

export function listThemes(): Promise<ThemeSummary[]> {
  return invoke("list_themes");
}

export function getTheme(id: string): Promise<Theme> {
  return invoke("get_theme", { id });
}

export function onThemesChanged(callback: () => void): Promise<UnlistenFn> {
  return listen(THEMES_CHANGED_EVENT, callback);
}
