// Generated from crates/atlas-theme/keys.toml — do not edit.
// Run `bun run theme:keys` after editing that file.

import { withAlpha, lighten, mix } from "./color";

export const PALETTE_KEYS = [
  "red",
  "orange",
  "yellow",
  "green",
  "cyan",
  "blue",
  "purple",
  "pink",
] as const;

export type PaletteKey = (typeof PALETTE_KEYS)[number];
export type Appearance = "dark" | "light";
export type ColorTransform = (color: string, context: DerivationContext) => string;

export interface DerivationContext {
  base: Record<string, string>;
  palette: Record<string, string>;
  appearance: Appearance;
}

export interface ThemeKeyRule {
  /** First derivation source after an explicit theme key. */
  palette?: PaletteKey;
  /** Second derivation source after the palette. */
  base?: string;
  /** Per-appearance Atlas default, used only when both sources are absent. */
  atlasDefault: Record<Appearance, string>;
  transform?: ColorTransform;
  description: string;
}

export interface ThemeKeyDefinition<Key extends string = string> {
  key: Key;
  cssVar: `--atlas-${string}`;
  rule: ThemeKeyRule;
}

const alpha =
  (amount: number): ColorTransform =>
  (color) =>
    withAlpha(color, amount);
const lighter =
  (amount: number): ColorTransform =>
  (color) =>
    lighten(color, amount);
const towardBackground =
  (amount: number): ColorTransform =>
  (color, { base }) =>
    mix(color, base.background ?? "#000000", amount);

function define<const Key extends string>(
  key: Key,
  rule: Omit<ThemeKeyRule, "atlasDefault"> & {
    dark: string;
    light?: string;
  },
): ThemeKeyDefinition<Key> {
  const { dark, light = dark, ...rest } = rule;
  return {
    key,
    cssVar: `--atlas-${key.replaceAll(".", "-").replaceAll("_", "-")}`,
    rule: { ...rest, atlasDefault: { dark, light } },
  };
}

/**
 * The public schema-1 theme-key registry. Every key appears once and carries
 * exactly one explicit → palette → base → Atlas-default derivation rule.
 */
export const THEME_KEY_REGISTRY = [
  define("border.subtle", {
    base: "sidebar-border",
    dark: "#141414",
    light: "#ebe5de",
    description: "Low-emphasis separator.",
  }),
  /**
   * Sourced from `border`, not `ring`. It used to be `ring`, and decision 31 then
   * made `ring` a real accent — so a theme that set `ring` and left this alone got
   * a brand-coloured hairline everywhere it wanted a strong grey one. The two roles
   * are genuinely different: `ring` is the focus RING, this is the strongest
   * BORDER, and a focused control's border is this rather than a third key.
   */
  define("border.strong", {
    base: "border",
    dark: "#3d3d3d",
    light: "#b8b1aa",
    description: "High-emphasis border, including a focused control's.",
  }),

  define("element.hover", {
    base: "foreground",
    transform: alpha(0.04),
    dark: "rgba(255,255,255,0.04)",
    light: "rgba(0,0,0,0.04)",
    description: "Hover overlay for ordinary elements.",
  }),
  define("element.selected", {
    base: "foreground",
    transform: alpha(0.06),
    dark: "rgba(255,255,255,0.06)",
    light: "rgba(0,0,0,0.06)",
    description: "Selected overlay for ordinary elements.",
  }),
  define("element.active", {
    base: "foreground",
    transform: alpha(0.08),
    dark: "rgba(255,255,255,0.08)",
    light: "rgba(0,0,0,0.08)",
    description: "Pressed overlay for ordinary elements.",
  }),
  /**
   * The 1px top edge on raised glass — `inset-highlight` in globals.css. It is
   * the theme's own foreground at 6%, so a light variant gets a dark edge
   * instead of the white-on-white one a hardcoded highlight would give it.
   */
  define("element.highlight", {
    base: "foreground",
    transform: alpha(0.06),
    dark: "rgba(255,255,255,0.06)",
    light: "rgba(0,0,0,0.06)",
    description: "Top-edge highlight on a raised surface.",
  }),
  define("primary.hover", {
    base: "primary",
    transform: lighter(0.15),
    dark: "#cccccc",
    light: "#a290b5",
    description: "Hovered primary-brand fill.",
  }),
  define("primary.muted", {
    base: "primary",
    transform: alpha(0.06),
    dark: "rgba(255,255,255,0.06)",
    light: "rgba(144,122,169,0.08)",
    description: "Muted primary-brand fill.",
  }),

  define("text.disabled", {
    base: "muted-foreground",
    transform: towardBackground(0.35),
    dark: "#333333",
    light: "#b8b1aa",
    description: "Disabled and unavailable text.",
  }),

  define("status.success.foreground", {
    palette: "green",
    dark: "#3fb950",
    light: "#286983",
    description: "Success status foreground, and the live-capture indicator.",
  }),
  define("status.warning.foreground", {
    palette: "yellow",
    dark: "#cd9731",
    light: "#ea9d34",
    description: "Warning status foreground.",
  }),
  define("status.error.foreground", {
    palette: "red",
    base: "destructive",
    dark: "#f44747",
    light: "#b4637a",
    description: "Error status foreground.",
  }),
  define("status.info.foreground", {
    palette: "blue",
    dark: "#6796e6",
    light: "#56949f",
    description: "Informational status foreground.",
  }),

  define("selection.background", {
    base: "primary",
    transform: alpha(0.18),
    dark: "rgba(255,255,255,0.18)",
    light: "rgba(144,122,169,0.18)",
    description: "Document text selection.",
  }),

  define("terminal.foreground", {
    base: "foreground",
    dark: "#d4d4d4",
    light: "#575279",
    description: "Terminal default foreground.",
  }),
  define("terminal.background", {
    base: "background",
    dark: "#000000",
    light: "#faf4ed",
    description: "Terminal background.",
  }),
  define("terminal.cursor", {
    base: "foreground",
    dark: "#d4d4d4",
    light: "#575279",
    description: "Terminal cursor.",
  }),
  define("terminal.ansi.black", {
    base: "background",
    transform: lighter(0.12),
    dark: "#1e1e1e",
    light: "#575279",
    description: "ANSI black.",
  }),
  define("terminal.ansi.red", {
    palette: "red",
    dark: "#f44747",
    light: "#b4637a",
    description: "ANSI red.",
  }),
  define("terminal.ansi.green", {
    palette: "green",
    dark: "#98c379",
    light: "#286983",
    description: "ANSI green.",
  }),
  define("terminal.ansi.yellow", {
    palette: "yellow",
    dark: "#e5c07b",
    light: "#ea9d34",
    description: "ANSI yellow.",
  }),
  define("terminal.ansi.blue", {
    palette: "blue",
    dark: "#61afef",
    light: "#56949f",
    description: "ANSI blue.",
  }),
  define("terminal.ansi.magenta", {
    palette: "purple",
    dark: "#c678dd",
    light: "#907aa9",
    description: "ANSI magenta.",
  }),
  define("terminal.ansi.cyan", {
    palette: "cyan",
    dark: "#56b6c2",
    light: "#d7827e",
    description: "ANSI cyan.",
  }),
  define("terminal.ansi.white", {
    base: "foreground",
    dark: "#d4d4d4",
    light: "#575279",
    description: "ANSI white.",
  }),
  define("terminal.ansi.bright_black", {
    base: "muted-foreground",
    dark: "#666666",
    light: "#9893a5",
    description: "ANSI bright black.",
  }),
  define("terminal.ansi.bright_red", {
    palette: "red",
    transform: lighter(0.15),
    dark: "#ff6b6b",
    light: "#c97991",
    description: "ANSI bright red.",
  }),
  define("terminal.ansi.bright_green", {
    palette: "green",
    transform: lighter(0.15),
    dark: "#b2d89a",
    light: "#4d8399",
    description: "ANSI bright green.",
  }),
  define("terminal.ansi.bright_yellow", {
    palette: "yellow",
    transform: lighter(0.15),
    dark: "#f2d28c",
    light: "#edae52",
    description: "ANSI bright yellow.",
  }),
  define("terminal.ansi.bright_blue", {
    palette: "blue",
    transform: lighter(0.15),
    dark: "#82c0f3",
    light: "#73a5ae",
    description: "ANSI bright blue.",
  }),
  define("terminal.ansi.bright_magenta", {
    palette: "purple",
    transform: lighter(0.15),
    dark: "#d493e5",
    light: "#a290b5",
    description: "ANSI bright magenta.",
  }),
  define("terminal.ansi.bright_cyan", {
    palette: "cyan",
    transform: lighter(0.15),
    dark: "#78c7d0",
    light: "#dd9794",
    description: "ANSI bright cyan.",
  }),
  define("terminal.ansi.bright_white", {
    base: "foreground",
    transform: lighter(0.18),
    dark: "#ffffff",
    light: "#464261",
    description: "ANSI bright white.",
  }),

  define("syntax.comment", {
    base: "muted-foreground",
    dark: "#8f8f8f",
    light: "#9893a5",
    description: "Comments and prose quotes.",
  }),
  define("syntax.keyword", {
    palette: "purple",
    dark: "#c9a2f5",
    light: "#286983",
    description: "Keywords and control flow.",
  }),
  define("syntax.string", {
    palette: "green",
    dark: "#9ecf8a",
    light: "#ea9d34",
    description: "Strings.",
  }),
  define("syntax.number", {
    palette: "orange",
    dark: "#e0b070",
    light: "#ea9d34",
    description: "Numbers.",
  }),
  define("syntax.type", {
    palette: "cyan",
    dark: "#7fd1e8",
    light: "#56949f",
    description: "Types, classes, and namespaces.",
  }),
  define("syntax.function", {
    palette: "blue",
    base: "primary",
    dark: "#ffff00",
    light: "#286983",
    description: "Functions and headings.",
  }),
  define("syntax.variable", {
    base: "foreground",
    dark: "#eaeaea",
    light: "#575279",
    description: "Variables.",
  }),
  define("syntax.operator", {
    palette: "cyan",
    dark: "#9a9a9a",
    light: "#797593",
    description: "Operators.",
  }),
  define("syntax.tag", {
    palette: "red",
    dark: "#7fd1e8",
    light: "#b4637a",
    description: "Markup tags.",
  }),
  define("syntax.attribute", {
    palette: "yellow",
    dark: "#d9b47a",
    light: "#907aa9",
    description: "Markup attributes.",
  }),
  define("syntax.constant", {
    palette: "orange",
    dark: "#e0b070",
    light: "#d7827e",
    description: "Constants and atoms.",
  }),
  define("syntax.regexp", {
    palette: "red",
    dark: "#e59a72",
    light: "#b4637a",
    description: "Regular expressions.",
  }),
  define("syntax.escape", {
    palette: "pink",
    dark: "#e59a72",
    light: "#d7827e",
    description: "Escape sequences.",
  }),
  define("syntax.definition", {
    base: "foreground",
    dark: "#ffffff",
    light: "#464261",
    description: "Definitions and strong prose.",
  }),
  define("syntax.property", {
    palette: "cyan",
    dark: "#c8c8c8",
    light: "#56949f",
    description: "Properties and object keys.",
  }),

  define("editor.background", {
    base: "background",
    dark: "#000000",
    light: "#faf4ed",
    description: "Code editor background.",
  }),
  define("editor.foreground", {
    base: "foreground",
    dark: "#d4d4d4",
    light: "#575279",
    description: "Code editor foreground.",
  }),
  define("editor.caret", {
    base: "foreground",
    dark: "#d4d4d4",
    light: "#575279",
    description: "Code editor caret.",
  }),
  define("editor.gutter.background", {
    base: "background",
    dark: "#000000",
    light: "#faf4ed",
    description: "Code editor gutter background.",
  }),
  define("editor.gutter.foreground", {
    base: "muted-foreground",
    dark: "#666666",
    light: "#9893a5",
    description: "Code editor line numbers.",
  }),
  define("editor.active_line.background", {
    base: "foreground",
    transform: alpha(0.04),
    dark: "rgba(255,255,255,0.04)",
    light: "rgba(0,0,0,0.04)",
    description: "Active editor line.",
  }),
  define("editor.active_line.gutter_foreground", {
    base: "foreground",
    dark: "#d4d4d4",
    light: "#575279",
    description: "Active line number.",
  }),
  define("editor.selection.background", {
    base: "primary",
    transform: alpha(0.24),
    dark: "#303030",
    light: "#dfdad9",
    description: "Editor selection.",
  }),
  define("editor.match_bracket.background", {
    base: "accent",
    dark: "#2d2d2d",
    light: "#dfdad9",
    description: "Matching bracket background.",
  }),
  define("editor.match_bracket.border", {
    base: "ring",
    dark: "#3d3d3d",
    light: "#907aa9",
    description: "Matching bracket outline.",
  }),

  define("scrollbar.thumb.background", {
    base: "foreground",
    transform: alpha(0.16),
    dark: "rgba(255,255,255,0.16)",
    light: "rgba(0,0,0,0.16)",
    description: "Scrollbar thumb.",
  }),
  define("scrollbar.thumb.hover", {
    base: "foreground",
    transform: alpha(0.26),
    dark: "rgba(255,255,255,0.26)",
    light: "rgba(0,0,0,0.26)",
    description: "Hovered scrollbar thumb.",
  }),
  define("panel.background", {
    base: "sidebar",
    dark: "#060706",
    light: "#fffaf3",
    description: "Panel background.",
  }),
  define("panel.input.background", {
    base: "background",
    dark: "#0a0a0a",
    light: "#fffaf3",
    description: "Panel input background.",
  }),

  define("diff.added.background", {
    palette: "green",
    transform: alpha(0.13),
    dark: "#0d2211",
    light: "rgba(40,105,131,0.13)",
    description: "Added line or hunk.",
  }),
  define("diff.added.emphasis", {
    palette: "green",
    transform: alpha(0.34),
    dark: "rgba(52,211,153,0.34)",
    light: "rgba(40,105,131,0.34)",
    description: "Changed words inside an added line.",
  }),
  define("diff.added.text", {
    palette: "green",
    dark: "#3fb950",
    light: "#286983",
    description: "Added diff text, and the +N line statistic.",
  }),
  define("diff.removed.background", {
    palette: "red",
    transform: alpha(0.13),
    dark: "#220d0d",
    light: "rgba(180,99,122,0.13)",
    description: "Removed line or hunk.",
  }),
  define("diff.removed.emphasis", {
    palette: "red",
    transform: alpha(0.34),
    dark: "rgba(244,63,63,0.34)",
    light: "rgba(180,99,122,0.34)",
    description: "Changed words inside a removed line.",
  }),
  define("diff.removed.text", {
    palette: "red",
    dark: "#f85149",
    light: "#b4637a",
    description: "Removed diff text, and the -N line statistic.",
  }),
  define("diff.context.background", {
    base: "background",
    dark: "#0a0a0a",
    light: "#faf4ed",
    description: "Unchanged diff context.",
  }),

  define("agent.claude.foreground", {
    palette: "orange",
    dark: "#c98263",
    light: "#b4637a",
    description: "Claude identity chip.",
  }),
  define("agent.claude.background", {
    palette: "orange",
    transform: alpha(0.1),
    dark: "rgba(201,130,99,0.1)",
    light: "rgba(180,99,122,0.1)",
    description: "Claude identity background.",
  }),
  define("agent.gpt.foreground", {
    palette: "green",
    dark: "#5fb39a",
    light: "#286983",
    description: "GPT identity chip.",
  }),
  define("agent.gpt.background", {
    palette: "green",
    transform: alpha(0.1),
    dark: "rgba(95,179,154,0.1)",
    light: "rgba(40,105,131,0.1)",
    description: "GPT identity background.",
  }),
  define("agent.gemini.foreground", {
    palette: "blue",
    dark: "#7aa7e8",
    light: "#56949f",
    description: "Gemini identity chip.",
  }),
  define("agent.gemini.background", {
    palette: "blue",
    transform: alpha(0.1),
    dark: "rgba(122,167,232,0.1)",
    light: "rgba(86,148,159,0.1)",
    description: "Gemini identity background.",
  }),
  define("agent.local.foreground", {
    palette: "purple",
    dark: "#b8a3df",
    light: "#907aa9",
    description: "Local-agent identity chip.",
  }),
  define("agent.local.background", {
    palette: "purple",
    transform: alpha(0.1),
    dark: "rgba(184,163,223,0.1)",
    light: "rgba(144,122,169,0.1)",
    description: "Local-agent identity background.",
  }),
  define("agent.cursor.foreground", {
    palette: "yellow",
    dark: "#d9b56e",
    light: "#ea9d34",
    description: "Cursor identity chip.",
  }),
  define("agent.cursor.background", {
    palette: "yellow",
    transform: alpha(0.1),
    dark: "rgba(217,181,110,0.1)",
    light: "rgba(234,157,52,0.1)",
    description: "Cursor identity background.",
  }),
  define("agent.amp.foreground", {
    palette: "pink",
    dark: "#d68aae",
    light: "#d7827e",
    description: "Amp identity chip.",
  }),
  define("agent.amp.background", {
    palette: "pink",
    transform: alpha(0.1),
    dark: "rgba(214,138,174,0.1)",
    light: "rgba(215,130,126,0.1)",
    description: "Amp identity background.",
  }),
  define("agent.codex.foreground", {
    palette: "green",
    dark: "#10a37f",
    light: "#286983",
    description: "Codex identity chip.",
  }),
  define("agent.codex.background", {
    palette: "green",
    transform: alpha(0.1),
    dark: "rgba(16,163,127,0.1)",
    light: "rgba(40,105,131,0.1)",
    description: "Codex identity background.",
  }),
  define("agent.opencode.foreground", {
    base: "muted-foreground",
    dark: "#9ca3af",
    light: "#797593",
    description: "OpenCode identity chip.",
  }),
  define("agent.opencode.background", {
    base: "muted-foreground",
    transform: alpha(0.1),
    dark: "rgba(156,163,175,0.1)",
    light: "rgba(121,117,147,0.1)",
    description: "OpenCode identity background.",
  }),
  define("agent.kilo.foreground", {
    palette: "yellow",
    dark: "#f0c53d",
    light: "#ea9d34",
    description: "Kilo identity chip.",
  }),
  define("agent.kilo.background", {
    palette: "yellow",
    transform: alpha(0.1),
    dark: "rgba(240,197,61,0.1)",
    light: "rgba(234,157,52,0.1)",
    description: "Kilo identity background.",
  }),
] as const;

export type ThemeKey = (typeof THEME_KEY_REGISTRY)[number]["key"];

export const THEME_KEY_DEFINITION_BY_KEY = Object.fromEntries(
  THEME_KEY_REGISTRY.map((definition) => [definition.key, definition]),
) as Record<ThemeKey, (typeof THEME_KEY_REGISTRY)[number]>;

export interface DerivedVarDefinition<Name extends string = string> {
  name: Name;
  cssVar: `--atlas-${string}`;
  /** The settable key this transforms, or null when it transforms a base token. */
  from: ThemeKey | null;
  /** The base token this transforms, or null when it transforms a key. */
  base: string | null;
  transform: ColorTransform;
  description: string;
}

function derive<const Name extends string>(
  name: Name,
  rule: Omit<DerivedVarDefinition<Name>, "name" | "cssVar">,
): DerivedVarDefinition<Name> {
  return {
    name,
    cssVar: `--atlas-${name.replaceAll(".", "-").replaceAll("_", "-")}`,
    ...rule,
  };
}

/**
 * Colours Atlas still writes as `--atlas-…` custom properties, but that no
 * theme may set: each is a pure transform of a key that IS settable, so a
 * theme author steers it through that key and never restates it. They are
 * deliberately absent from `theme-keys.txt` and from the JSON Schema, which is
 * what makes writing one in a theme file an unknown-key warning.
 */
export const DERIVED_VAR_REGISTRY = [
  derive("status.success.background", {
    from: "status.success.foreground",
    base: null,
    transform: alpha(0.12),
    description: "Tinted fill behind a success foreground.",
  }),
  derive("status.warning.background", {
    from: "status.warning.foreground",
    base: null,
    transform: alpha(0.12),
    description: "Tinted fill behind a warning foreground.",
  }),
  derive("status.error.background", {
    from: "status.error.foreground",
    base: null,
    transform: alpha(0.12),
    description: "Tinted fill behind an error foreground.",
  }),
  derive("status.info.background", {
    from: "status.info.foreground",
    base: null,
    transform: alpha(0.12),
    description: "Tinted fill behind an informational foreground.",
  }),
  derive("element.emphasis", {
    from: null,
    base: "foreground",
    transform: alpha(0.16),
    description: "The strongest neutral overlay — a chat mention addressed to you.",
  }),
  derive("terminal.selection", {
    from: null,
    base: "primary",
    transform: alpha(0.3),
    description: "Terminal selection.",
  }),
] as const;

export type DerivedVar = (typeof DERIVED_VAR_REGISTRY)[number]["name"];

export function describeDerivation(definition: ThemeKeyDefinition): string {
  const sources = [
    definition.rule.palette ? `palette.${definition.rule.palette}` : null,
    definition.rule.base ? `base.${definition.rule.base}` : null,
    "Atlas appearance default",
  ].filter(Boolean);
  return sources.join(" → ");
}
