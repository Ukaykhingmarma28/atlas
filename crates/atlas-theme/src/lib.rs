//! Atlas theme schema, validation, built-in assets, and user-theme I/O.
//!
//! Rust owns theme files. Callers receive validated JSON-ready values and do
//! not need to know whether a theme came from `include_str!` or the user's
//! `~/.config/atlas/themes` directory.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use schemars::{schema_for, JsonSchema};
use serde::{Deserialize, Serialize};
use thiserror::Error;

pub const THEME_SCHEMA_VERSION: u32 = 1;
pub const DEFAULT_THEME_ID: &str = "atlas";

const THEME_KEYS: &str = include_str!("../theme-keys.txt");

const BASE_TOKENS: &[&str] = &[
    "background",
    "foreground",
    "card",
    "card-foreground",
    "popover",
    "popover-foreground",
    "primary",
    "primary-foreground",
    "secondary",
    "secondary-foreground",
    "muted",
    "muted-foreground",
    "accent",
    "accent-foreground",
    "destructive",
    "destructive-foreground",
    "border",
    "input",
    "ring",
    "chart-1",
    "chart-2",
    "chart-3",
    "chart-4",
    "chart-5",
    "sidebar",
    "sidebar-foreground",
    "sidebar-primary",
    "sidebar-primary-foreground",
    "sidebar-accent",
    "sidebar-accent-foreground",
    "sidebar-border",
    "sidebar-ring",
    "radius",
    "font-sans",
    "font-serif",
    "font-mono",
    "tracking-normal",
    "spacing",
    "shadow-2xs",
    "shadow-xs",
    "shadow-sm",
    "shadow-md",
    "shadow-lg",
    "shadow-xl",
    "shadow-2xl",
];

const NON_COLOR_BASE_TOKENS: &[&str] = &[
    "radius",
    "font-sans",
    "font-serif",
    "font-mono",
    "tracking-normal",
    "spacing",
    "shadow-2xs",
    "shadow-xs",
    "shadow-sm",
    "shadow-md",
    "shadow-lg",
    "shadow-xl",
    "shadow-2xl",
];

const PALETTE_KEYS: &[&str] =
    &["red", "orange", "yellow", "green", "cyan", "blue", "purple", "pink"];

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Theme {
    pub schema: u32,
    pub id: String,
    pub name: String,
    pub author: String,
    pub license: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dark: Option<ThemeVariant>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub light: Option<ThemeVariant>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<ThemeWarning>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ThemeVariant {
    pub base: BTreeMap<String, String>,
    #[serde(default)]
    pub palette: BTreeMap<String, String>,
    #[serde(default)]
    pub keys: BTreeMap<String, ThemeKeyValue>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum ThemeKeyValue {
    Color(String),
    Styled(ThemeKeyStyle),
}

impl ThemeKeyValue {
    pub fn color(&self) -> &str {
        match self {
            Self::Color(color) => color,
            Self::Styled(style) => &style.color,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ThemeKeyStyle {
    pub color: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub font_style: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThemeWarning {
    pub key: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThemeSummary {
    pub id: String,
    pub name: String,
    pub author: String,
    pub license: String,
    pub has_dark: bool,
    pub has_light: bool,
    pub built_in: bool,
    pub warnings: Vec<ThemeWarning>,
}

impl Theme {
    pub fn summary(&self, built_in: bool) -> ThemeSummary {
        ThemeSummary {
            id: self.id.clone(),
            name: self.name.clone(),
            author: self.author.clone(),
            license: self.license.clone(),
            has_dark: self.dark.is_some(),
            has_light: self.light.is_some(),
            built_in,
            warnings: self.warnings.clone(),
        }
    }
}

#[derive(Debug, Error)]
pub enum ThemeError {
    #[error("failed to read {path}: {source}")]
    Read { path: PathBuf, source: std::io::Error },
    #[error("invalid TOML in {origin}: {source}")]
    Toml { origin: String, source: toml::de::Error },
    #[error("invalid theme in {origin}: {message}")]
    Validation { origin: String, message: String },
    #[error("theme '{0}' was not found")]
    NotFound(String),
    #[error("theme watcher error: {0}")]
    Watch(#[from] notify::Error),
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawTheme {
    schema: u32,
    id: String,
    name: String,
    author: String,
    license: String,
    #[serde(default)]
    dark: Option<toml::Value>,
    #[serde(default)]
    light: Option<toml::Value>,
}

const BUILT_INS: &[(&str, &str)] = &[
    ("atlas.toml", include_str!("../themes/atlas.toml")),
    ("atlas-mono.toml", include_str!("../themes/atlas-mono.toml")),
    ("chyral.toml", include_str!("../themes/chyral.toml")),
    ("mirage.toml", include_str!("../themes/mirage.toml")),
    ("rose-pine.toml", include_str!("../themes/rose-pine.toml")),
    ("rose-pine-moon.toml", include_str!("../themes/rose-pine-moon.toml")),
    ("one-dark.toml", include_str!("../themes/one-dark.toml")),
    ("phosphor.toml", include_str!("../themes/phosphor.toml")),
    ("dracula.toml", include_str!("../themes/dracula.toml")),
    ("monokai.toml", include_str!("../themes/monokai.toml")),
    ("tokyo-night.toml", include_str!("../themes/tokyo-night.toml")),
    ("catppuccin-frappe.toml", include_str!("../themes/catppuccin-frappe.toml")),
    ("catppuccin-macchiato.toml", include_str!("../themes/catppuccin-macchiato.toml")),
    ("catppuccin-mocha.toml", include_str!("../themes/catppuccin-mocha.toml")),
    ("vesper.toml", include_str!("../themes/vesper.toml")),
];

pub fn parse_theme(source: &str, origin: impl Into<String>) -> Result<Theme, ThemeError> {
    let origin = origin.into();
    let raw: RawTheme = toml::from_str(source).map_err(|source| ThemeError::Toml {
        origin: origin.clone(),
        source,
    })?;
    if raw.schema != THEME_SCHEMA_VERSION {
        return Err(validation(&origin, format!("unsupported schema {}; expected 1", raw.schema)));
    }
    if raw.id.trim().is_empty() || raw.name.trim().is_empty() {
        return Err(validation(&origin, "id and name must not be empty"));
    }
    let dark = raw.dark.map(|value| parse_variant(value, &origin, "dark")).transpose()?;
    let light = raw.light.map(|value| parse_variant(value, &origin, "light")).transpose()?;
    if dark.is_none() && light.is_none() {
        return Err(validation(&origin, "at least one of [dark] or [light] is required"));
    }
    let mut theme = Theme {
        schema: raw.schema,
        id: raw.id,
        name: raw.name,
        author: raw.author,
        license: raw.license,
        dark,
        light,
        warnings: Vec::new(),
    };
    collect_warnings(&mut theme);
    Ok(theme)
}

pub fn load_theme_file(path: &Path) -> Result<Theme, ThemeError> {
    let source = fs::read_to_string(path).map_err(|source| ThemeError::Read {
        path: path.to_path_buf(),
        source,
    })?;
    parse_theme(&source, path.display().to_string())
}

pub fn built_in_themes() -> Result<Vec<Theme>, ThemeError> {
    BUILT_INS.iter().map(|(name, source)| parse_theme(source, *name)).collect()
}

pub fn user_theme_dir() -> Option<PathBuf> {
    dirs::config_dir().map(|dir| dir.join("atlas").join("themes"))
}

pub fn load_user_themes_from(dir: &Path) -> Result<Vec<Theme>, ThemeError> {
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut paths = fs::read_dir(dir)
        .map_err(|source| ThemeError::Read { path: dir.to_path_buf(), source })?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.extension().and_then(|ext| ext.to_str()) == Some("toml"))
        .collect::<Vec<_>>();
    paths.sort();
    paths.iter().map(|path| load_theme_file(path)).collect()
}

pub fn all_themes() -> Result<Vec<(Theme, bool)>, ThemeError> {
    let mut by_id = built_in_themes()?
        .into_iter()
        .map(|theme| (theme.id.clone(), (theme, true)))
        .collect::<BTreeMap<_, _>>();
    if let Some(dir) = user_theme_dir() {
        for theme in load_user_themes_from(&dir)? {
            by_id.insert(theme.id.clone(), (theme, false));
        }
    }
    Ok(by_id.into_values().collect())
}

pub fn list_themes() -> Result<Vec<ThemeSummary>, ThemeError> {
    all_themes().map(|themes| themes.into_iter().map(|(theme, built_in)| theme.summary(built_in)).collect())
}

pub fn get_theme(id: &str) -> Result<Theme, ThemeError> {
    all_themes()?
        .into_iter()
        .map(|(theme, _)| theme)
        .find(|theme| theme.id == id)
        .ok_or_else(|| ThemeError::NotFound(id.to_string()))
}

pub fn watch_user_themes<F>(mut on_change: F) -> Result<RecommendedWatcher, ThemeError>
where
    F: FnMut() + Send + 'static,
{
    let dir = user_theme_dir().ok_or_else(|| validation("themes", "could not resolve config directory"))?;
    fs::create_dir_all(&dir).map_err(|source| ThemeError::Read { path: dir.clone(), source })?;
    let mut watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        if let Ok(event) = event {
            if event.paths.iter().any(|path| path.extension().and_then(|ext| ext.to_str()) == Some("toml")) {
                on_change();
            }
        }
    })?;
    watcher.watch(&dir, RecursiveMode::NonRecursive)?;
    Ok(watcher)
}

pub fn json_schema() -> serde_json::Value {
    serde_json::to_value(schema_for!(Theme)).expect("Theme JSON schema serializes")
}

fn parse_variant(value: toml::Value, origin: &str, appearance: &str) -> Result<ThemeVariant, ThemeError> {
    let table = value.as_table().ok_or_else(|| validation(origin, format!("[{appearance}] must be a table")))?;
    let unknown = table.keys().filter(|key| !matches!(key.as_str(), "base" | "palette" | "keys")).cloned().collect::<Vec<_>>();
    if !unknown.is_empty() {
        return Err(validation(origin, format!("unknown {appearance} field(s): {}", unknown.join(", "))));
    }
    let base = flatten_string_table(table.get("base"), origin, &format!("{appearance}.base"))?;
    let palette = flatten_string_table(table.get("palette"), origin, &format!("{appearance}.palette"))?;
    let keys = flatten_key_table(table.get("keys"), origin, &format!("{appearance}.keys"))?;
    validate_variant(&base, &palette, &keys, origin, appearance)?;
    Ok(ThemeVariant { base, palette, keys })
}

fn flatten_string_table(
    value: Option<&toml::Value>,
    origin: &str,
    field: &str,
) -> Result<BTreeMap<String, String>, ThemeError> {
    let Some(value) = value else {
        return if field.ends_with(".base") {
            Err(validation(origin, format!("[{field}] is required")))
        } else {
            Ok(BTreeMap::new())
        };
    };
    let mut out = BTreeMap::new();
    flatten_strings(value, "", &mut out, origin, field)?;
    Ok(out)
}

fn flatten_key_table(
    value: Option<&toml::Value>,
    origin: &str,
    field: &str,
) -> Result<BTreeMap<String, ThemeKeyValue>, ThemeError> {
    let Some(value) = value else { return Ok(BTreeMap::new()) };
    let mut out = BTreeMap::new();
    flatten_keys(value, "", &mut out, origin, field)?;
    Ok(out)
}

fn flatten_strings(
    value: &toml::Value,
    prefix: &str,
    out: &mut BTreeMap<String, String>,
    origin: &str,
    field: &str,
) -> Result<(), ThemeError> {
    let table = value.as_table().ok_or_else(|| validation(origin, format!("[{field}] must contain string leaves")))?;
    for (key, value) in table {
        let dotted = if prefix.is_empty() { key.clone() } else { format!("{prefix}.{key}") };
        if let Some(string) = value.as_str() {
            insert_leaf(out, dotted, string.to_string(), origin)?;
        } else if value.is_table() {
            flatten_strings(value, &dotted, out, origin, field)?;
        } else {
            return Err(validation(origin, format!("{field}.{dotted} must be a string")));
        }
    }
    Ok(())
}

fn flatten_keys(
    value: &toml::Value,
    prefix: &str,
    out: &mut BTreeMap<String, ThemeKeyValue>,
    origin: &str,
    field: &str,
) -> Result<(), ThemeError> {
    let table = value.as_table().ok_or_else(|| validation(origin, format!("[{field}] must be a table")))?;
    for (key, value) in table {
        let dotted = if prefix.is_empty() { key.clone() } else { format!("{prefix}.{key}") };
        if let Some(string) = value.as_str() {
            insert_leaf(out, dotted, ThemeKeyValue::Color(string.to_string()), origin)?;
        } else if let Some(style) = parse_style(value) {
            insert_leaf(out, dotted, ThemeKeyValue::Styled(style), origin)?;
        } else if value.is_table() {
            flatten_keys(value, &dotted, out, origin, field)?;
        } else {
            return Err(validation(origin, format!("{field}.{dotted} must be a colour or style")));
        }
    }
    Ok(())
}

fn parse_style(value: &toml::Value) -> Option<ThemeKeyStyle> {
    let table = value.as_table()?;
    let color = table.get("color")?.as_str()?.to_string();
    if table.keys().any(|key| !matches!(key.as_str(), "color" | "font_style")) {
        return None;
    }
    let font_style = table.get("font_style").and_then(toml::Value::as_str).map(ToOwned::to_owned);
    Some(ThemeKeyStyle { color, font_style })
}

fn insert_leaf<T>(
    out: &mut BTreeMap<String, T>,
    key: String,
    value: T,
    origin: &str,
) -> Result<(), ThemeError> {
    if out.keys().any(|existing| is_leaf_prefix(existing, &key) || is_leaf_prefix(&key, existing)) {
        return Err(validation(origin, format!("'{key}' is both a leaf and a prefix")));
    }
    out.insert(key, value);
    Ok(())
}

fn is_leaf_prefix(leaf: &str, key: &str) -> bool {
    key.strip_prefix(leaf).is_some_and(|rest| rest.starts_with('.'))
}

fn validate_variant(
    base: &BTreeMap<String, String>,
    palette: &BTreeMap<String, String>,
    keys: &BTreeMap<String, ThemeKeyValue>,
    origin: &str,
    appearance: &str,
) -> Result<(), ThemeError> {
    let allowed_base = BASE_TOKENS.iter().copied().collect::<BTreeSet<_>>();
    if let Some(key) = base.keys().find(|key| !allowed_base.contains(key.as_str())) {
        return Err(validation(origin, format!("unknown base token '{key}' in {appearance}")));
    }
    let missing = BASE_TOKENS.iter().filter(|key| !base.contains_key(**key)).copied().collect::<Vec<_>>();
    if !missing.is_empty() {
        return Err(validation(origin, format!("missing base token(s) in {appearance}: {}", missing.join(", "))));
    }
    let palette_keys = PALETTE_KEYS.iter().copied().collect::<BTreeSet<_>>();
    if let Some(key) = palette.keys().find(|key| !palette_keys.contains(key.as_str())) {
        return Err(validation(origin, format!("unknown palette colour '{key}' in {appearance}")));
    }
    for (key, value) in base {
        if !NON_COLOR_BASE_TOKENS.contains(&key.as_str()) && !is_css_color(value) {
            return Err(validation(origin, format!("{appearance}.base.{key} is not a CSS colour")));
        }
    }
    for (key, value) in palette {
        if !is_css_color(value) {
            return Err(validation(origin, format!("{appearance}.palette.{key} is not a CSS colour")));
        }
    }
    for (key, value) in keys {
        if !is_css_color(value.color()) {
            return Err(validation(origin, format!("{appearance}.keys.{key} is not a CSS colour")));
        }
    }
    Ok(())
}

fn collect_warnings(theme: &mut Theme) {
    let known = THEME_KEYS.lines().collect::<BTreeSet<_>>();
    for (appearance, variant) in [("dark", theme.dark.as_ref()), ("light", theme.light.as_ref())] {
        if let Some(variant) = variant {
            for key in variant.keys.keys().filter(|key| !known.contains(key.as_str())) {
                theme.warnings.push(ThemeWarning {
                    key: format!("{appearance}.keys.{key}"),
                    message: "unknown theme key; preserved for forward compatibility".to_string(),
                });
            }
        }
    }
}

pub fn is_css_color(value: &str) -> bool {
    let value = value.trim();
    if let Some(hex) = value.strip_prefix('#') {
        return matches!(hex.len(), 3 | 4 | 6 | 8) && hex.bytes().all(|byte| byte.is_ascii_hexdigit());
    }
    for name in ["rgb", "rgba", "hsl", "hsla", "oklch"] {
        if let Some(body) = value.strip_prefix(name).and_then(|rest| rest.strip_prefix('(')).and_then(|rest| rest.strip_suffix(')')) {
            return validate_color_function(name, body);
        }
    }
    false
}

fn validate_color_function(name: &str, body: &str) -> bool {
    if body.trim().is_empty() || body.contains(['(', ')']) {
        return false;
    }
    let normalized = body.replace(',', " ").replace('/', " / ");
    let parts = normalized.split_whitespace().collect::<Vec<_>>();
    let slash = parts.iter().position(|part| *part == "/");
    let channels = slash.unwrap_or_else(|| {
        if matches!(name, "rgba" | "hsla") && parts.len() == 4 { 3 } else { parts.len() }
    });
    if channels != 3 || slash.is_some_and(|index| parts.len() != index + 2) {
        return false;
    }
    if !parts[..channels].iter().all(|part| parse_number(part)) {
        return false;
    }
    if let Some(index) = slash {
        if !parse_number(parts[index + 1]) {
            return false;
        }
    } else if matches!(name, "rgba" | "hsla") && parts.len() == 4 {
        return parse_number(parts[3]);
    } else if parts.len() != 3 {
        return false;
    }
    true
}

fn parse_number(value: &str) -> bool {
    let value = value
        .strip_suffix('%')
        .or_else(|| value.strip_suffix("deg"))
        .unwrap_or(value);
    value.parse::<f64>().is_ok_and(f64::is_finite)
}

fn validation(origin: &str, message: impl Into<String>) -> ThemeError {
    ThemeError::Validation { origin: origin.to_string(), message: message.into() }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn minimal_theme(extra: &str) -> String {
        let base = BASE_TOKENS
            .iter()
            .map(|key| {
                let value = if NON_COLOR_BASE_TOKENS.contains(key) { "1rem" } else { "#123456" };
                format!("\"{key}\" = \"{value}\"")
            })
            .collect::<Vec<_>>()
            .join("\n");
        format!(
            "schema = 1\nid = \"test\"\nname = \"Test\"\nauthor = \"Test\"\nlicense = \"MIT\"\n[dark.base]\n{base}\n{extra}\n"
        )
    }

    #[test]
    fn built_ins_load_and_have_unique_ids() {
        let themes = built_in_themes().unwrap();
        assert_eq!(themes.len(), BUILT_INS.len());
        let ids = themes.iter().map(|theme| &theme.id).collect::<BTreeSet<_>>();
        assert_eq!(ids.len(), themes.len());
    }

    #[test]
    fn flattens_nested_theme_keys() {
        let theme = parse_theme(
            &minimal_theme("[dark.keys.terminal.ansi]\nred = \"rgb(255 0 0)\""),
            "test",
        )
        .unwrap();
        assert_eq!(theme.dark.unwrap().keys["terminal.ansi.red"].color(), "rgb(255 0 0)");
    }

    #[test]
    fn rejects_unknown_top_level_and_base_fields() {
        let top = minimal_theme("").replacen("[dark.base]", "mystery = true\n[dark.base]", 1);
        assert!(matches!(parse_theme(&top, "test"), Err(ThemeError::Toml { .. })));
        let base = minimal_theme("").replacen(
            "[dark.base]\n",
            "[dark.base]\nmystery = \"#fff\"\n",
            1,
        );
        assert!(parse_theme(&base, "test").unwrap_err().to_string().contains("unknown base token"));
    }

    #[test]
    fn rejects_leaf_prefix_conflicts() {
        let source = minimal_theme("[dark.keys]\nsyntax = \"#fff\"\n[dark.keys.syntax]\nkeyword = \"#000\"");
        assert!(parse_theme(&source, "test").is_err());
    }

    #[test]
    fn unknown_theme_keys_are_warnings() {
        let theme = parse_theme(&minimal_theme("[dark.keys]\nfuture = \"#fff\""), "test").unwrap();
        assert_eq!(theme.warnings.len(), 1);
    }

    #[test]
    fn validates_supported_css_colour_syntaxes() {
        for color in ["#abc", "#abcd", "#aabbcc", "#aabbccdd", "rgb(1 2 3 / 50%)", "rgba(1, 2, 3, 0.5)", "hsl(120 50% 50%)", "oklch(0.7 0.2 120 / .8)"] {
            assert!(is_css_color(color), "{color}");
        }
        for color in ["red", "#12", "rgb()", "oklch(nope 1 2)"] {
            assert!(!is_css_color(color), "{color}");
        }
    }

    #[test]
    fn generated_schema_is_current() {
        let expected = serde_json::to_string_pretty(&json_schema()).unwrap() + "\n";
        assert_eq!(include_str!("../schema/theme-v1.json"), expected);
    }

    #[test]
    fn browser_mock_snapshot_is_current() {
        let expected = serde_json::to_string_pretty(&built_in_themes().unwrap()).unwrap() + "\n";
        assert_eq!(include_str!("../../../src/dev/mock-backend/builtin-themes.json"), expected);
    }
}
