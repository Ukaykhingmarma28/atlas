//! The half of an import that is the same whatever the source was.
//!
//! All three importers do the same three things in the same order: put whatever
//! the source said into the right Atlas slot, fill the *required* shadcn base
//! tokens the source did not have, and guess an eight-colour palette from
//! whatever ended up in `terminal.ansi.*` / `syntax.*`. Only the first step is
//! format-specific, so the other two live here and every importer gets the same
//! derivation chain — and, more to the point, the same report entries for it.
//!
//! **Why the palette matters more than it looks.** It is optional in the file
//! format, but a wide swath of the theme keys resolve through it — every
//! status colour, every ANSI colour, every diff tint; see the Source column
//! in `docs/reference/theme-keys.md` for the current set. An import that skips
//! the palette produces a theme
//! whose editor is the author's and whose chrome is Atlas's, which looks like a
//! half-finished port. Guessing it from the ANSI ramp costs nothing and is
//! right far more often than it is wrong.

use std::collections::BTreeMap;

use crate::color;
use crate::import::report::{DerivedKey, MappedKey};
use crate::{is_css_color, ThemeKeyValue, ThemeVariant, BASE_TOKENS, PALETTE_KEYS};

/// Atlas's own answer when neither the source nor another token can supply one.
const ATLAS_FONT_SANS: &str = "-apple-system, \"SF Pro Text\", system-ui, sans-serif";
const ATLAS_FONT_SERIF: &str = "ui-serif, Georgia, Cambria, \"Times New Roman\", serif";
const ATLAS_FONT_MONO: &str = "\"SF Mono\", \"Geist Mono\", \"JetBrains Mono\", monospace";

/// A variant under construction, plus the audit trail of how it got that way.
pub(crate) struct VariantDraft {
    pub appearance: &'static str,
    base: BTreeMap<String, String>,
    palette: BTreeMap<String, String>,
    keys: BTreeMap<String, ThemeKeyValue>,
    pub mapped: Vec<MappedKey>,
    pub derived: Vec<DerivedKey>,
}

impl VariantDraft {
    pub fn new(appearance: &'static str) -> Self {
        Self {
            appearance,
            base: BTreeMap::new(),
            palette: BTreeMap::new(),
            keys: BTreeMap::new(),
            mapped: Vec::new(),
            derived: Vec::new(),
        }
    }

    pub fn is_dark(&self) -> bool {
        self.appearance == "dark"
    }

    pub fn base_value(&self, token: &str) -> Option<&str> {
        self.base.get(token).map(String::as_str)
    }

    pub fn key_color(&self, key: &str) -> Option<&str> {
        self.keys.get(key).map(ThemeKeyValue::color)
    }

    /// First writer wins, so an importer can list its preferred source first
    /// and fall through to weaker ones without re-checking.
    pub fn map_base(&mut self, token: &str, source: &str, value: &str) -> bool {
        if self.base.contains_key(token) || !is_css_value(token, value) {
            return false;
        }
        self.base.insert(token.to_string(), value.to_string());
        self.mapped.push(MappedKey {
            target: format!("{}.base.{token}", self.appearance),
            source: source.to_string(),
            value: value.to_string(),
        });
        true
    }

    pub fn map_key(&mut self, key: &str, source: &str, value: ThemeKeyValue) -> bool {
        if self.keys.contains_key(key) || !is_css_color(value.color()) {
            return false;
        }
        let rendered = value.color().to_string();
        self.keys.insert(key.to_string(), value);
        self.mapped.push(MappedKey {
            target: format!("{}.keys.{key}", self.appearance),
            source: source.to_string(),
            value: rendered,
        });
        true
    }

    pub fn map_color_key(&mut self, key: &str, source: &str, value: &str) -> bool {
        self.map_key(key, source, ThemeKeyValue::Color(value.to_string()))
    }

    fn derive_base(&mut self, token: &str, from: &str, value: &str) {
        if self.base.contains_key(token) {
            return;
        }
        self.base.insert(token.to_string(), value.to_string());
        self.derived.push(DerivedKey {
            target: format!("{}.base.{token}", self.appearance),
            from: from.to_string(),
            value: value.to_string(),
        });
    }

    fn derive_palette(&mut self, name: &str, from: &str, value: &str) {
        if self.palette.contains_key(name) || !is_css_color(value) {
            return;
        }
        self.palette.insert(name.to_string(), value.to_string());
        self.derived.push(DerivedKey {
            target: format!("{}.palette.{name}", self.appearance),
            from: from.to_string(),
            value: value.to_string(),
        });
    }

    /// Fill every required shadcn base token the source did not provide.
    ///
    /// The chains lean on tokens this same pass has already filled, so the
    /// order of the match arms is load-bearing: `popover` may fall back to
    /// `card`, which itself may have fallen back to `background`.
    pub fn fill_required_base(&mut self) {
        let dark = self.is_dark();
        for token in BASE_TOKENS {
            if self.base.contains_key(*token) {
                continue;
            }
            let (from, value) = self.fallback_for(token, dark);
            self.derive_base(token, &from, &value);
        }
    }

    fn fallback_for(&self, token: &str, dark: bool) -> (String, String) {
        // A chain of other base tokens, tried in order.
        let chain: &[&str] = match token {
            "card" | "secondary" | "muted" | "sidebar" => &["background"],
            "popover" => &["card", "background"],
            "card-foreground" | "popover-foreground" | "accent-foreground"
            | "secondary-foreground" | "sidebar-foreground" => &["foreground"],
            "primary" => &["ring", "foreground"],
            "accent" => &["muted", "card", "background"],
            "border" => &["muted", "card"],
            "input" => &["border"],
            "ring" => &["primary", "foreground"],
            "chart-1" => &["primary"],
            "chart-2" => &["accent-foreground", "primary"],
            "chart-3" => &["destructive"],
            "chart-4" => &["muted-foreground"],
            "chart-5" => &["secondary-foreground", "primary"],
            "sidebar-primary" => &["primary"],
            "sidebar-primary-foreground" => &["primary-foreground"],
            "sidebar-accent" => &["accent"],
            "sidebar-accent-foreground" => &["accent-foreground"],
            "sidebar-border" => &["border"],
            "sidebar-ring" => &["ring"],
            _ => &[],
        };
        // The palette is a better source for the chart ramp than a chain of
        // near-identical greys, so it gets first refusal.
        if let Some(name) = match token {
            "chart-1" => Some("blue"),
            "chart-2" => Some("green"),
            "chart-3" => Some("yellow"),
            "chart-4" => Some("purple"),
            "chart-5" => Some("red"),
            _ => None,
        } {
            if let Some(value) = self.palette.get(name) {
                return (format!("palette.{name}"), value.clone());
            }
        }
        for candidate in chain {
            if let Some(value) = self.base.get(*candidate) {
                return ((*candidate).to_string(), value.clone());
            }
        }
        // A foreground for a coloured surface is a contrast question, not a
        // chain: a light `primary` wants a dark `primary-foreground` whatever
        // the appearance is.
        if let Some(surface) = match token {
            "primary-foreground" => Some("primary"),
            "destructive-foreground" => Some("destructive"),
            _ => None,
        } {
            if let Some(against) = self.base.get(surface) {
                let (light, dark_side) = (light_default(), dark_default());
                let pick = color::better_contrast(against, light, dark_side);
                return (format!("contrast with {surface}"), pick.to_string());
            }
        }
        ("atlas default".to_string(), atlas_default(token, dark).to_string())
    }

    /// Guess the eight palette colours from what the source already gave us.
    ///
    /// Only ever *adds*: an importer that found a real palette (nothing does
    /// today, but a future format might) keeps it.
    pub fn fill_palette(&mut self) {
        // (palette name, candidate theme keys in order, candidate base tokens)
        const SOURCES: &[(&str, &[&str], &[&str])] = &[
            ("red", &["terminal.ansi.red", "syntax.tag", "status.error.foreground"], &["destructive"]),
            ("green", &["terminal.ansi.green", "syntax.string", "status.success.foreground"], &[]),
            ("yellow", &["terminal.ansi.yellow", "syntax.attribute", "status.warning.foreground"], &[]),
            ("blue", &["terminal.ansi.blue", "syntax.function", "status.info.foreground"], &["primary"]),
            ("cyan", &["terminal.ansi.cyan", "syntax.type"], &[]),
            ("purple", &["terminal.ansi.magenta", "syntax.keyword"], &[]),
            ("orange", &["syntax.number", "terminal.ansi.bright_red"], &[]),
            ("pink", &["syntax.escape", "terminal.ansi.bright_magenta", "syntax.regexp"], &[]),
        ];
        for (name, keys, tokens) in SOURCES {
            let found = keys
                .iter()
                .find_map(|key| self.key_color(key).map(|value| (format!("keys.{key}"), value.to_string())))
                .or_else(|| {
                    tokens.iter().find_map(|token| {
                        self.base_value(token).map(|value| (format!("base.{token}"), value.to_string()))
                    })
                });
            if let Some((from, value)) = found {
                self.derive_palette(name, &from, &value);
            }
        }
        debug_assert!(self.palette.keys().all(|name| PALETTE_KEYS.contains(&name.as_str())));
    }

    pub fn finish(self) -> (ThemeVariant, Vec<MappedKey>, Vec<DerivedKey>) {
        (
            ThemeVariant { base: self.base, palette: self.palette, keys: self.keys },
            self.mapped,
            self.derived,
        )
    }
}

/// Non-colour base tokens (`radius`, the font stacks, the shadow ramp) are free
/// text, so only the colour ones are syntax-checked on the way in.
fn is_css_value(token: &str, value: &str) -> bool {
    if crate::NON_COLOR_BASE_TOKENS.contains(&token) {
        !value.trim().is_empty()
    } else {
        is_css_color(value)
    }
}

fn light_default() -> &'static str {
    "#ffffff"
}

fn dark_default() -> &'static str {
    "#0a0a0a"
}

/// Atlas's own value for a token nothing in the source or the chain could fill.
///
/// The shadow ramp is appearance-aware on purpose: copying a dark theme's
/// `0 8px 24px rgba(0,0,0,0.75)` onto a cream background is the exact defect
/// the review found in the built-in light variants, and an importer that can
/// produce a light variant from a `:root` block should not reproduce it.
fn atlas_default(token: &str, dark: bool) -> &'static str {
    match token {
        "background" => if dark { "#000000" } else { "#ffffff" },
        "foreground" => if dark { "#ffffff" } else { "#18181b" },
        "muted-foreground" => if dark { "#8a8a8a" } else { "#71717a" },
        "destructive" => if dark { "#e5484d" } else { "#dc2626" },
        "radius" => "8px",
        "font-sans" => ATLAS_FONT_SANS,
        "font-serif" => ATLAS_FONT_SERIF,
        "font-mono" => ATLAS_FONT_MONO,
        "tracking-normal" => "0em",
        "spacing" => "0.25rem",
        "shadow-2xs" => if dark { "0 1px 2px rgba(0, 0, 0, 0.35)" } else { "0 1px 2px rgba(0, 0, 0, 0.04)" },
        "shadow-xs" => if dark { "0 1px 2px rgba(0, 0, 0, 0.45)" } else { "0 1px 2px rgba(0, 0, 0, 0.06)" },
        "shadow-sm" => if dark { "0 1px 3px rgba(0, 0, 0, 0.55)" } else { "0 1px 3px rgba(0, 0, 0, 0.08)" },
        "shadow-md" => if dark { "0 4px 12px rgba(0, 0, 0, 0.65)" } else { "0 4px 12px rgba(0, 0, 0, 0.10)" },
        "shadow-lg" => if dark { "0 8px 24px rgba(0, 0, 0, 0.75)" } else { "0 8px 24px rgba(0, 0, 0, 0.12)" },
        "shadow-xl" => if dark { "0 12px 36px rgba(0, 0, 0, 0.82)" } else { "0 12px 36px rgba(0, 0, 0, 0.14)" },
        "shadow-2xl" => if dark { "0 16px 48px rgba(0, 0, 0, 0.9)" } else { "0 16px 48px rgba(0, 0, 0, 0.18)" },
        _ => if dark { "#1a1a1a" } else { "#f4f4f5" },
    }
}
