import { mix } from "./color";
import type { Theme, ThemeAppearance, ThemeKeyValue, ThemeVariant } from "./lib/theme-api";
import {
  BASE_RULE_REGISTRY,
  DERIVED_VAR_REGISTRY,
  THEME_KEY_REGISTRY,
  type Appearance,
  type DerivedVar,
  type PaletteKey,
  type ThemeKey,
} from "./theme-key-registry";

export interface ThemeOverride {
  base?: Record<string, string>;
  palette?: Partial<Record<PaletteKey, string>>;
  keys?: Partial<Record<ThemeKey, ThemeKeyValue>> & Record<string, ThemeKeyValue | undefined>;
}

export interface ResolvedTheme {
  id: string;
  appearance: Appearance;
  base: Record<string, string>;
  palette: Record<string, string>;
  keys: Record<ThemeKey, string>;
  /** Colours Atlas derives from a key; see `DERIVED_VAR_REGISTRY`. */
  derived: Record<DerivedVar, string>;
  cssVars: Record<`--${string}`, string>;
}

function colorOf(value: ThemeKeyValue | undefined): string | undefined {
  return typeof value === "string" ? value : value?.color;
}

function chooseVariant(theme: Theme, requested: ThemeAppearance): [Appearance, ThemeVariant] {
  const preferred = theme[requested];
  if (preferred) return [requested, preferred];
  if (requested === "light" && theme.dark) return ["dark", theme.dark];
  if (theme.light) return ["light", theme.light];
  if (theme.dark) return ["dark", theme.dark];
  throw new Error(`Theme "${theme.id}" has no variant`);
}

/**
 * Every shadcn base token, from the ones a theme wrote (ADR-0022): a written
 * value is taken as is, and each one left out follows its rule in
 * `keys.toml` — palette, then an earlier token, then the Atlas default — so a
 * theme that names only `background` and `primary` still sets the whole set.
 * Tokens with no rule (the optional fonts) pass through untouched.
 */
export function resolveBase(
  written: Record<string, string>,
  palette: Record<string, string>,
  appearance: Appearance,
): Record<string, string> {
  const base: Record<string, string> = { ...written };
  const context = { base, palette, appearance };
  for (const rule of BASE_RULE_REGISTRY) {
    if (written[rule.token]) continue;
    let value = rule.palette ? palette[rule.palette] : undefined;
    if (!value && rule.base) value = base[rule.base];
    if (!value) value = rule.atlasDefault?.[appearance];
    if (!value) continue;
    base[rule.token] = rule.transform ? rule.transform(value, context) : value;
  }
  return base;
}

/** What `interfaceContrast` moves: the borders and the secondary text. */
const CONTRAST_BASE = ["border", "input", "sidebar-border", "muted-foreground"] as const;
const CONTRAST_KEYS = ["border.subtle", "border.strong", "text.disabled"] as const;

/** At 200%, how far toward the text colour; at 50%, how far toward the
 *  background. Halfway at most either way, so a border never becomes text and
 *  secondary text never disappears. */
const CONTRAST_REACH = { up: 0.5, down: 0.5 };

export function resolveTheme(
  theme: Theme,
  requested: ThemeAppearance,
  themeOverride: ThemeOverride = {},
  /** `interfaceContrast`, in percent: 100 is the theme as written. */
  contrast = 100,
): ResolvedTheme {
  const [appearance, variant] = chooseVariant(theme, requested);
  const palette = { ...variant.palette, ...themeOverride.palette };
  const base = resolveBase({ ...variant.base, ...themeOverride.base }, palette, appearance);
  const explicit = { ...variant.keys, ...themeOverride.keys };
  const context = { base, palette, appearance };
  const keys = {} as Record<ThemeKey, string>;
  const cssVars: Record<`--${string}`, string> = {};

  for (const [name, value] of Object.entries(base)) cssVars[`--${name}`] = value;

  for (const definition of THEME_KEY_REGISTRY) {
    const { key, rule } = definition;
    let color = colorOf(explicit[key]);
    if (!color && rule.palette) color = palette[rule.palette];
    if (!color && rule.base) color = base[rule.base];
    if (!color) color = rule.atlasDefault[appearance];
    if (rule.transform && !colorOf(explicit[key])) color = rule.transform(color, context);
    keys[key] = color;
    cssVars[definition.cssVar] = color;
  }

  // After the keys, because a derived variable may transform a resolved one.
  const derived = {} as Record<DerivedVar, string>;
  for (const definition of DERIVED_VAR_REGISTRY) {
    // `resolveBase` has filled every token by now, so the `??` is only there
    // to keep `withAlpha` total.
    const source = definition.from ? keys[definition.from] : (base[definition.base ?? ""] ?? "");
    const color = definition.transform(source, context);
    derived[definition.name] = color;
    cssVars[definition.cssVar] = color;
  }

  // Last, so the change lands on the final colours — including ones a key
  // derived from a base token — and on the typed records xterm and the charts
  // read, not just on the CSS.
  if (contrast !== 100) {
    const up = contrast > 100;
    const toward = up ? base.foreground : base.background;
    const amount = up
      ? ((contrast - 100) / 100) * CONTRAST_REACH.up
      : ((100 - contrast) / 50) * CONTRAST_REACH.down;
    if (toward) {
      for (const name of CONTRAST_BASE) {
        if (!base[name]) continue;
        base[name] = mix(base[name], toward, amount);
        cssVars[`--${name}`] = base[name];
      }
      for (const key of CONTRAST_KEYS) {
        keys[key] = mix(keys[key], toward, amount);
        cssVars[cssVarOf(key)] = keys[key];
      }
    }
  }

  return { id: theme.id, appearance, base, palette, keys, derived, cssVars };
}

function cssVarOf(key: ThemeKey): `--${string}` {
  return THEME_KEY_REGISTRY.find((definition) => definition.key === key)!.cssVar;
}
