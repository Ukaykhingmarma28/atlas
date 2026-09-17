//! Theme import: a foreign theme, converted to an Atlas theme file, once.
//!
//! Decision 15 is the shape of this whole module: an import is a **one-time
//! conversion**. Nothing here keeps a link back to the source — no reference to
//! the shadcn registry item, no path to the `.json` it came from, no refresh.
//! What lands in `~/.config/atlas/themes/<id>.toml` is an ordinary Atlas theme
//! the user now owns and can edit, and the existing watcher picks it up with no
//! further help. That is why the conversion lives here in Rust next to the
//! parser and the writer rather than in the UI: the output has to satisfy
//! exactly the validation a hand-written theme satisfies, and the cheapest way
//! to guarantee that is to write the TOML and read it back.
//!
//! Three importers, in descending fidelity — [`shadcn`], [`zed`], [`vscode`] —
//! each with its own module doc on what it can and cannot carry. They share
//! [`draft::VariantDraft`] (base-token derivation, palette guessing) and
//! [`report::ImportReport`], which is the part the user reads.

pub mod css;
mod draft;
pub mod report;
mod shadcn;
mod vscode;
mod zed;

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::toml_writer::theme_to_toml;
use crate::{parse_theme, Theme, ThemeError, THEME_SCHEMA_VERSION};
use draft::VariantDraft;
use report::ImportReport;

pub use report::{DerivedKey, Fidelity, ImportCounts, ImportReport as Report, IgnoredKey, MappedKey};

/// How many `include` hops a VS Code theme may take. Dark+ → dark_vs is two;
/// eight is room to spare and a hard stop on a cycle a path check missed.
const MAX_INCLUDE_DEPTH: usize = 8;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum ImportFormat {
    /// A shadcn registry item, `{type, cssVars}` — what tweakcn exports.
    Shadcn,
    /// A pasted `globals.css`.
    ShadcnCss,
    /// A Zed theme family, `{themes: [{name, appearance, style}]}`.
    Zed,
    /// A VS Code colour theme, `{colors, tokenColors, include?}`.
    VsCode,
}

impl ImportFormat {
    pub fn label(self) -> &'static str {
        match self {
            Self::Shadcn => "shadcn registry item",
            Self::ShadcnCss => "shadcn CSS",
            Self::Zed => "Zed theme",
            Self::VsCode => "VS Code colour theme",
        }
    }
}

/// What the caller knows that the source does not say.
#[derive(Debug, Clone, Default)]
pub struct ImportOptions {
    /// A label for error messages: a URL, a file name, or `"pasted text"`.
    pub origin: String,
    /// Overrides the id slugged from the theme's name.
    pub id_hint: Option<String>,
    pub name_hint: Option<String>,
    pub author_hint: Option<String>,
    pub license_hint: Option<String>,
}

/// One converted theme: the file to write, and the story of how it was made.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ImportedTheme {
    /// Parsed and validated — this is the theme the TOML below produces.
    pub theme: Theme,
    /// The schema-1 TOML, ready for `~/.config/atlas/themes/<id>.toml`.
    pub toml: String,
    pub report: ImportReport,
}

/// Guess the format from the bytes.
///
/// Sniffing beats asking: the four formats are trivially distinguishable, and a
/// user pasting a blob generally does not think of it as "a registry item"
/// versus "a theme JSON". The caller may still force one.
pub fn detect_format(source: &str) -> Option<ImportFormat> {
    let trimmed = source.trim_start();
    if !trimmed.starts_with('{') {
        // A rule block with no custom property in it is still CSS, and the CSS
        // importer's "no custom properties found in :root, .dark or @theme" is
        // a far more actionable answer than "unrecognised format".
        return (trimmed.contains("--") || trimmed.contains('{')).then_some(ImportFormat::ShadcnCss);
    }
    let value: Value = serde_json::from_str(&strip_jsonc(source)).ok()?;
    if value.get("themes").and_then(Value::as_array).is_some() {
        return Some(ImportFormat::Zed);
    }
    if value.get("cssVars").is_some()
        || value.get("type").and_then(Value::as_str).is_some_and(|kind| kind.starts_with("registry:"))
    {
        return Some(ImportFormat::Shadcn);
    }
    if value.get("tokenColors").is_some()
        || value.get("semanticTokenColors").is_some()
        || value.get("include").is_some()
        || value.get("colors").is_some()
    {
        return Some(ImportFormat::VsCode);
    }
    None
}

/// Convert `source` into one or more Atlas themes.
///
/// A Zed family yields one theme per member; the others yield exactly one.
/// `base_dir` is only consulted for a VS Code `include`, and only when the
/// source came off disk — a pasted theme reports its unresolved includes in the
/// report rather than failing.
pub fn import_themes(
    source: &str,
    format: Option<ImportFormat>,
    base_dir: Option<&Path>,
    options: &ImportOptions,
) -> Result<Vec<ImportedTheme>, ThemeError> {
    let format = format.or_else(|| detect_format(source)).ok_or_else(|| {
        crate::validation(
            &options.origin,
            "unrecognised theme format: expected a shadcn registry item, a shadcn globals.css, a Zed theme family, or a VS Code colour theme",
        )
    })?;
    match format {
        ImportFormat::ShadcnCss => shadcn::from_css(source, options),
        ImportFormat::Shadcn => shadcn::from_registry_item(&parse_json(source, options)?, options),
        ImportFormat::Zed => zed::import(&parse_json(source, options)?, options),
        ImportFormat::VsCode => {
            let resolved = resolve_includes(source, base_dir, options)?;
            vscode::import(resolved, options)
        }
    }
}

fn parse_json(source: &str, options: &ImportOptions) -> Result<Value, ThemeError> {
    serde_json::from_str(&strip_jsonc(source))
        .map_err(|error| crate::validation(&options.origin, format!("invalid JSON: {error}")))
}

/// Assemble a validated [`Theme`] out of finished drafts.
///
/// The TOML is written and then *re-read* rather than trusted. That round trip
/// is the only thing standing between an importer's mapping table and a file
/// the loader rejects — validation lives in `parse_theme`, so running it here
/// means an importer can never produce a file the app then refuses to load.
fn finish_theme(
    drafts: Vec<VariantDraft>,
    mut report: ImportReport,
    options: &ImportOptions,
) -> Result<ImportedTheme, ThemeError> {
    let name = options.name_hint.clone().unwrap_or_else(|| report.source_name.clone());
    let id = options.id_hint.clone().unwrap_or_else(|| slug(&name));
    if id.is_empty() {
        return Err(crate::validation(&options.origin, "could not derive a theme id from the source"));
    }

    let mut theme = Theme {
        schema: THEME_SCHEMA_VERSION,
        id,
        name,
        author: options.author_hint.clone().unwrap_or_else(|| "Imported".to_string()),
        license: options.license_hint.clone().unwrap_or_else(|| "Unknown".to_string()),
        dark: None,
        light: None,
        warnings: Vec::new(),
    };
    for draft in drafts {
        let appearance = draft.appearance;
        let (variant, mapped, derived) = draft.finish();
        report.variants.push(appearance.to_string());
        report.mapped.extend(mapped);
        report.derived.extend(derived);
        match appearance {
            "light" => theme.light = Some(variant),
            _ => theme.dark = Some(variant),
        }
    }
    report.variants.sort();
    report.variants.dedup();
    report.finish();

    let toml = theme_to_toml(&theme);
    let theme = parse_theme(&toml, &options.origin)?;
    Ok(ImportedTheme { theme, toml, report })
}

/// A theme id: lowercase, `a-z0-9-`, no leading or trailing dash.
///
/// Accented Latin letters are folded rather than dropped, because dropping them
/// is how "Rosé Pine" becomes `ros-pine` — a id that is both ugly and no longer
/// recognisably the theme's name.
pub fn slug(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    for ch in name.chars() {
        let folded = fold(ch);
        if folded.is_empty() {
            if !out.ends_with('-') {
                out.push('-');
            }
        } else {
            out.push_str(folded);
        }
    }
    out.trim_matches('-').to_string()
}

/// One character, as the closest run of `a-z0-9`, or `""` for a separator.
fn fold(ch: char) -> &'static str {
    if ch.is_ascii_alphanumeric() {
        // SAFETY-free trick: index a static table so the return can borrow.
        const LOWER: &str = "0123456789abcdefghijklmnopqrstuvwxyz";
        let lower = ch.to_ascii_lowercase();
        let index = LOWER.find(lower).expect("alphanumeric ASCII is in the table");
        return &LOWER[index..index + 1];
    }
    match ch {
        'à'..='å' | 'À'..='Å' | 'ā' | 'ă' | 'ą' => "a",
        'è'..='ë' | 'È'..='Ë' | 'ē' | 'ė' | 'ę' => "e",
        'ì'..='ï' | 'Ì'..='Ï' | 'ī' | 'į' => "i",
        'ò'..='ö' | 'Ò'..='Ö' | 'ø' | 'Ø' | 'ō' => "o",
        'ù'..='ü' | 'Ù'..='Ü' | 'ū' => "u",
        'ç' | 'Ç' | 'ć' | 'č' => "c",
        'ñ' | 'Ñ' | 'ń' => "n",
        'ý' | 'ÿ' => "y",
        'š' | 'ś' => "s",
        'ž' | 'ź' | 'ż' => "z",
        'ß' => "ss",
        'æ' | 'Æ' => "ae",
        _ => "",
    }
}

/// Read a VS Code theme and everything its `include` chain pulls in.
///
/// VS Code's semantics: the included file is the *base*, and the including file
/// overrides it. `tokenColors` concatenate with the includer's rules last,
/// which is also the order [`vscode`]'s tie-break wants, so the merge is a
/// plain append.
fn resolve_includes(
    source: &str,
    base_dir: Option<&Path>,
    options: &ImportOptions,
) -> Result<vscode::Resolved, ThemeError> {
    let mut value = parse_json(source, options)?;
    let mut includes = Vec::new();
    let mut unresolved = Vec::new();
    let mut seen: BTreeSet<PathBuf> = BTreeSet::new();
    let mut dir = base_dir.map(Path::to_path_buf);

    for _ in 0..MAX_INCLUDE_DEPTH {
        let Some(target) = value.get("include").and_then(Value::as_str).map(str::to_string) else {
            break;
        };
        let Some(current_dir) = dir.clone() else {
            unresolved.push(target);
            break;
        };
        let path = current_dir.join(&target);
        let canonical = path.canonicalize().unwrap_or_else(|_| path.clone());
        if !seen.insert(canonical) {
            unresolved.push(format!("{target} (cycle)"));
            break;
        }
        let Ok(text) = std::fs::read_to_string(&path) else {
            unresolved.push(target);
            break;
        };
        let parent = parse_json(&text, options)?;
        includes.push(target);
        dir = path.parent().map(Path::to_path_buf);
        value = merge_theme(parent, value);
    }
    if value.get("include").is_some() && unresolved.is_empty() && includes.len() >= MAX_INCLUDE_DEPTH {
        unresolved.push(format!("include chain deeper than {MAX_INCLUDE_DEPTH} files"));
    }
    Ok(vscode::Resolved { value, includes, unresolved })
}

/// `child` wins, except that `tokenColors` accumulate.
fn merge_theme(parent: Value, child: Value) -> Value {
    // A non-object on either side is not a theme document; keep the other.
    let Value::Object(parent) = parent else { return child };
    let Value::Object(mut child) = child else { return Value::Object(parent) };
    for (key, parent_value) in parent {
        match key.as_str() {
            "include" => {}
            "colors" | "semanticTokenColors" => {
                let merged = match (parent_value, child.remove(&key)) {
                    (Value::Object(mut base), Some(Value::Object(over))) => {
                        base.extend(over);
                        Value::Object(base)
                    }
                    (base, None) => base,
                    (_, Some(over)) => over,
                };
                child.insert(key, merged);
            }
            "tokenColors" => {
                let merged = match (parent_value, child.remove(&key)) {
                    (Value::Array(mut base), Some(Value::Array(over))) => {
                        base.extend(over);
                        Value::Array(base)
                    }
                    (base, None) => base,
                    (_, Some(over)) => over,
                };
                child.insert(key, merged);
            }
            _ => {
                child.entry(key).or_insert(parent_value);
            }
        }
    }
    // The chain is walked one hop at a time, so the merged value must not carry
    // the parent's own `include` forward as if it were the child's.
    child.remove("include");
    Value::Object(child)
}

/// JSON with comments and trailing commas — the dialect VS Code themes are
/// actually written in, and which `serde_json` correctly refuses.
fn strip_jsonc(source: &str) -> String {
    let mut out = String::with_capacity(source.len());
    let chars: Vec<char> = source.chars().collect();
    let mut index = 0;
    let mut in_string = false;
    while index < chars.len() {
        let ch = chars[index];
        if in_string {
            out.push(ch);
            if ch == '\\' {
                if let Some(next) = chars.get(index + 1) {
                    out.push(*next);
                    index += 2;
                    continue;
                }
            }
            if ch == '"' {
                in_string = false;
            }
            index += 1;
            continue;
        }
        match (ch, chars.get(index + 1)) {
            ('"', _) => {
                in_string = true;
                out.push(ch);
                index += 1;
            }
            ('/', Some('/')) => {
                while index < chars.len() && chars[index] != '\n' {
                    index += 1;
                }
            }
            ('/', Some('*')) => {
                index += 2;
                while index < chars.len() && !(chars[index] == '*' && chars.get(index + 1) == Some(&'/')) {
                    index += 1;
                }
                index += 2;
            }
            (',', _) => {
                // A trailing comma is one followed only by whitespace and a
                // closing bracket.
                let mut peek = index + 1;
                while peek < chars.len() && chars[peek].is_whitespace() {
                    peek += 1;
                }
                if matches!(chars.get(peek), Some('}') | Some(']')) {
                    index += 1;
                } else {
                    out.push(ch);
                    index += 1;
                }
            }
            _ => {
                out.push(ch);
                index += 1;
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugs_a_name_into_a_theme_id() {
        assert_eq!(slug("Rosé Pine Dawn"), "rose-pine-dawn");
        assert_eq!(slug("  One Dark Pro!! "), "one-dark-pro");
        assert_eq!(slug("!!!"), "");
    }

    #[test]
    fn sniffs_each_format_apart() {
        assert_eq!(detect_format(r#"{"cssVars":{"dark":{}}}"#), Some(ImportFormat::Shadcn));
        assert_eq!(detect_format(r#"{"type":"registry:style"}"#), Some(ImportFormat::Shadcn));
        assert_eq!(detect_format(r#"{"themes":[]}"#), Some(ImportFormat::Zed));
        assert_eq!(detect_format(r#"{"colors":{},"tokenColors":[]}"#), Some(ImportFormat::VsCode));
        assert_eq!(detect_format(":root { --background: #000; }"), Some(ImportFormat::ShadcnCss));
        assert_eq!(detect_format("hello"), None);
        assert_eq!(detect_format("{ not json"), None);
    }

    #[test]
    fn reads_the_jsonc_dialect_vs_code_themes_are_written_in() {
        let source = r##"{
            // a line comment
            "name": "T", /* and a block one */
            "colors": { "editor.background": "#000000", },
        }"##;
        let value: Value = serde_json::from_str(&strip_jsonc(source)).unwrap();
        assert_eq!(value["name"], "T");
        assert_eq!(value["colors"]["editor.background"], "#000000");
    }

    #[test]
    fn a_slash_inside_a_string_is_not_a_comment() {
        let source = r#"{"a":"http://x//y","b":"/*not*/"}"#;
        assert_eq!(strip_jsonc(source), source);
    }
}
