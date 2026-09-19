//! VS Code's `iconThemes` document, verbatim (decision 4).
//!
//! The point of taking the format unchanged is that a VS Code icon theme is
//! installable in Atlas without conversion, so this module's job is to be
//! *permissive in the same places VS Code is*: unknown top-level fields are
//! ignored rather than rejected, comments and trailing commas are tolerated
//! (the contribution is documented as JSON but published as JSONC), and an
//! association pointing at a definition that does not exist is a warning, not
//! a failed load. A theme is a third-party artifact; refusing to load one
//! because of a stale key helps nobody.
//!
//! What is *not* permissive: association keys are normalised on the way in —
//! lowercased, with `\` folded to `/` — so lookup is a plain map hit rather
//! than a scan. `fileExtensions` is documented as case-insensitive and the
//! real themes rely on it (Material ships both `tmLanguage` and `APKBUILD`).

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::IconThemeError;

/// One icon: either an image on disk or a glyph in an embedded font.
///
/// Both halves are optional in the schema and a definition may legally carry
/// neither (themes do ship empty ones as spacers), so the discrimination lives
/// in [`IconDefinition::resolved`] rather than in an enum here — round-tripping
/// the document shape matters more than modelling it tightly.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IconDefinition {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub font_character: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub font_color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub font_size: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub font_id: Option<String>,
}

/// What a definition actually renders as, once the optional fields are read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DefinitionKind<'a> {
    /// An SVG or PNG, at a path relative to the theme document.
    Image { path: &'a str },
    /// A glyph in one of the theme's [`IconFont`]s.
    Glyph { character: &'a str },
    /// Neither — the theme asked for nothing to be drawn.
    Empty,
}

impl IconDefinition {
    pub fn resolved(&self) -> DefinitionKind<'_> {
        // `iconPath` wins when a theme sets both, which is what VS Code does:
        // the image is the richer of the two.
        if let Some(path) = self.icon_path.as_deref().filter(|path| !path.is_empty()) {
            return DefinitionKind::Image { path };
        }
        if let Some(character) = self.font_character.as_deref().filter(|c| !c.is_empty()) {
            return DefinitionKind::Glyph { character };
        }
        DefinitionKind::Empty
    }
}

/// A web font a glyph-based theme draws from (Seti and its descendants).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IconFont {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub src: Vec<IconFontSource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub weight: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub style: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IconFontSource {
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub format: String,
}

/// The association tables — the part a `light` or `highContrast` section
/// overrides.
///
/// Every map here is keyed by a normalised (lowercased, `/`-separated) string;
/// see [`normalise_key`]. The values are `iconDefinitions` ids and are left
/// exactly as written.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Associations {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub folder: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub folder_expanded: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub root_folder: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub root_folder_expanded: Option<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub folder_names: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub folder_names_expanded: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub root_folder_names: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub root_folder_names_expanded: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub file_extensions: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub file_names: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub language_ids: BTreeMap<String, String>,
}

impl Associations {
    fn normalise(&mut self) {
        for map in [
            &mut self.folder_names,
            &mut self.folder_names_expanded,
            &mut self.root_folder_names,
            &mut self.root_folder_names_expanded,
            &mut self.file_extensions,
            &mut self.file_names,
            &mut self.language_ids,
        ] {
            let normalised =
                std::mem::take(map).into_iter().map(|(k, v)| (normalise_key(&k), v)).collect();
            *map = normalised;
        }
    }

    /// Every definition id this section names, for the reference check.
    fn referenced(&self) -> impl Iterator<Item = &str> {
        [
            self.file.as_deref(),
            self.folder.as_deref(),
            self.folder_expanded.as_deref(),
            self.root_folder.as_deref(),
            self.root_folder_expanded.as_deref(),
        ]
        .into_iter()
        .flatten()
        .chain(
            [
                &self.folder_names,
                &self.folder_names_expanded,
                &self.root_folder_names,
                &self.root_folder_names_expanded,
                &self.file_extensions,
                &self.file_names,
                &self.language_ids,
            ]
            .into_iter()
            .flat_map(|map| map.values().map(String::as_str)),
        )
    }
}

/// Lowercase, and fold Windows separators onto `/`.
///
/// Both halves of every lookup go through this, so a theme written on Windows
/// and a path observed on macOS meet in the same spelling.
pub fn normalise_key(key: &str) -> String {
    key.replace('\\', "/").to_lowercase()
}

/// A whole icon theme document.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IconThemeDocument {
    #[serde(default)]
    pub icon_definitions: BTreeMap<String, IconDefinition>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub fonts: Vec<IconFont>,
    /// The base (dark) associations, which live at the document root.
    #[serde(flatten)]
    pub associations: Associations,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub light: Option<Associations>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub high_contrast: Option<Associations>,
    #[serde(default)]
    pub hides_explorer_arrows: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub show_language_mode_icons: Option<bool>,
    /// Fonts and font sources [`IconThemeDocument::parse`] dropped because a
    /// field that ends up in a CSS `@font-face` rule was not a plain word.
    #[serde(skip)]
    rejected: Vec<IconThemeWarning>,
}

/// Something survivable that the document got wrong.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IconThemeWarning {
    pub key: String,
    pub message: String,
}

impl IconThemeDocument {
    /// Parse one document. `origin` names it in errors.
    pub fn parse(source: &str, origin: &str) -> Result<Self, IconThemeError> {
        let cleaned = strip_jsonc(source);
        let mut document: Self = serde_json::from_str(&cleaned).map_err(|source| {
            IconThemeError::Parse { origin: origin.to_string(), message: source.to_string() }
        })?;
        document.associations.normalise();
        if let Some(light) = document.light.as_mut() {
            light.normalise();
        }
        if let Some(high_contrast) = document.high_contrast.as_mut() {
            high_contrast.normalise();
        }
        document.rejected = sanitise_fonts(&mut document.fonts);
        if document.icon_definitions.is_empty() {
            return Err(IconThemeError::Parse {
                origin: origin.to_string(),
                message: "no `iconDefinitions`: this is not an icon theme".to_string(),
            });
        }
        Ok(document)
    }

    /// Everything wrong with the document that is not worth refusing it over.
    ///
    /// Two kinds, both of which real published themes contain: an association
    /// naming a definition that was deleted, and a glyph definition naming a
    /// font the `fonts` array does not declare. Each renders as a blank icon
    /// and is otherwise completely silent, which is why they are collected
    /// rather than ignored.
    pub fn warnings(&self) -> Vec<IconThemeWarning> {
        let mut warnings = self.rejected.clone();
        let sections = [
            ("", Some(&self.associations)),
            ("light.", self.light.as_ref()),
            ("highContrast.", self.high_contrast.as_ref()),
        ];
        let mut unknown: Vec<(&str, &str)> = Vec::new();
        for (prefix, section) in sections {
            let Some(section) = section else { continue };
            for id in section.referenced() {
                if !self.icon_definitions.contains_key(id) && !unknown.iter().any(|(_, u)| *u == id)
                {
                    unknown.push((prefix, id));
                }
            }
        }
        for (prefix, id) in unknown {
            warnings.push(IconThemeWarning {
                key: format!("{prefix}iconDefinitions.{id}"),
                message: "an association names a definition the theme does not define".to_string(),
            });
        }
        let font_ids: Vec<&str> = self.fonts.iter().map(|font| font.id.as_str()).collect();
        for (id, definition) in &self.icon_definitions {
            let Some(font_id) = definition.font_id.as_deref() else {
                continue;
            };
            if !font_ids.contains(&font_id) {
                warnings.push(IconThemeWarning {
                    key: format!("iconDefinitions.{id}"),
                    message: format!("names font \"{font_id}\", which `fonts` does not declare"),
                });
            }
        }
        warnings
    }
}

/// `true` for a value that may be written into a CSS `@font-face` rule or a
/// `font-family` name as-is: letters, digits, space, `_` and `-`.
///
/// A font's `id`, `weight` and `style` and a source's `format` are all
/// interpolated into CSS by the webview, and the theme is a third-party file.
/// Every real value (`seti`, `normal`, `bold`, `400`, `woff2`) fits.
pub fn is_plain_css_word(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, ' ' | '_' | '-'))
}

/// Drop every font whose id, weight or style is not a plain word, and every
/// source whose format is not, returning one warning per thing dropped. A
/// glyph naming a dropped font then warns through the ordinary undeclared-font
/// check, and renders blank rather than as injected CSS.
fn sanitise_fonts(fonts: &mut Vec<IconFont>) -> Vec<IconThemeWarning> {
    let mut rejected = Vec::new();
    fonts.retain_mut(|font| {
        let bad_field = [("id", Some(&font.id)), ("weight", font.weight.as_ref()), ("style", font.style.as_ref())]
            .into_iter()
            .find(|(_, value)| value.is_some_and(|value| !is_plain_css_word(value)));
        if let Some((field, _)) = bad_field {
            rejected.push(IconThemeWarning {
                key: format!("fonts.{}", font.id),
                message: format!("font `{field}` must be letters, digits, space, `_` or `-`; font ignored"),
            });
            return false;
        }
        font.src.retain(|source| {
            let ok = is_plain_css_word(&source.format);
            if !ok {
                rejected.push(IconThemeWarning {
                    key: format!("fonts.{}.src", font.id),
                    message: format!(
                        "source `{}` has a format that is not a plain word; source ignored",
                        source.path
                    ),
                });
            }
            ok
        });
        true
    });
    rejected
}

/// Strip `//` and `/* */` comments and trailing commas.
///
/// The `iconThemes` contribution is published as JSONC — VS Code parses it
/// with its own tolerant reader, and shipped themes do carry comments. Rather
/// than take a JSONC dependency for forty lines of state machine, this walks
/// the text once and blanks the comment spans (replacing them with spaces
/// rather than deleting them, so `serde_json`'s byte offsets in an error still
/// point at the right column of the original file).
fn strip_jsonc(source: &str) -> String {
    let bytes = source.as_bytes();
    let mut out = String::with_capacity(source.len());
    let mut index = 0usize;
    let mut in_string = false;
    while index < bytes.len() {
        let byte = bytes[index];
        if in_string {
            out.push(byte as char);
            if byte == b'\\' && index + 1 < bytes.len() {
                // An escape consumes the next byte whatever it is, so a `\"`
                // does not end the string and a `\\` does not swallow the quote
                // after it.
                out.push(bytes[index + 1] as char);
                index += 2;
                continue;
            }
            if byte == b'"' {
                in_string = false;
            }
            index += 1;
            continue;
        }
        match byte {
            b'"' => {
                in_string = true;
                out.push('"');
                index += 1;
            }
            b'/' if index + 1 < bytes.len() && bytes[index + 1] == b'/' => {
                while index < bytes.len() && bytes[index] != b'\n' {
                    out.push(' ');
                    index += 1;
                }
            }
            b'/' if index + 1 < bytes.len() && bytes[index + 1] == b'*' => {
                let end = source[index + 2..].find("*/").map(|at| index + 2 + at + 2);
                let end = end.unwrap_or(bytes.len());
                for byte in &bytes[index..end] {
                    // Newlines are kept so line numbers in a parse error survive.
                    out.push(if *byte == b'\n' { '\n' } else { ' ' });
                }
                index = end;
            }
            _ => {
                // Non-ASCII bytes are copied through as part of the char they
                // belong to; pushing byte-by-byte would mangle them.
                let char_end = next_char_boundary(source, index);
                out.push_str(&source[index..char_end]);
                index = char_end;
            }
        }
    }
    strip_trailing_commas(&out)
}

fn next_char_boundary(source: &str, from: usize) -> usize {
    let mut end = from + 1;
    while end < source.len() && !source.is_char_boundary(end) {
        end += 1;
    }
    end.min(source.len())
}

/// Remove a `,` that is followed only by whitespace and a closing bracket.
fn strip_trailing_commas(source: &str) -> String {
    let bytes = source.as_bytes();
    let mut out = String::with_capacity(source.len());
    let mut index = 0usize;
    let mut in_string = false;
    while index < bytes.len() {
        let byte = bytes[index];
        if in_string {
            out.push(byte as char);
            if byte == b'\\' && index + 1 < bytes.len() {
                out.push(bytes[index + 1] as char);
                index += 2;
                continue;
            }
            if byte == b'"' {
                in_string = false;
            }
            index += 1;
            continue;
        }
        if byte == b'"' {
            in_string = true;
            out.push('"');
            index += 1;
            continue;
        }
        if byte == b',' {
            let rest = source[index + 1..].trim_start();
            if rest.starts_with('}') || rest.starts_with(']') {
                out.push(' ');
                index += 1;
                continue;
            }
        }
        let char_end = next_char_boundary(source, index);
        out.push_str(&source[index..char_end]);
        index = char_end;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_line_and_block_comments() {
        let source = r#"{
            // a leading comment
            "iconDefinitions": { /* inline */ "a": { "iconPath": "./a.svg" } },
            "file": "a",
        }"#;
        let document = IconThemeDocument::parse(source, "test").expect("parses");
        assert_eq!(document.associations.file.as_deref(), Some("a"));
    }

    #[test]
    fn keeps_comment_markers_that_live_inside_strings() {
        let source = r#"{
            "iconDefinitions": { "a": { "iconPath": "./http://x/*y*/.svg" } },
            "file": "a"
        }"#;
        let document = IconThemeDocument::parse(source, "test").expect("parses");
        assert_eq!(
            document.icon_definitions["a"].icon_path.as_deref(),
            Some("./http://x/*y*/.svg"),
            "a URL inside a string is not a comment"
        );
    }

    #[test]
    fn lowercases_association_keys() {
        let source = r#"{
            "iconDefinitions": { "a": { "iconPath": "./a.svg" } },
            "fileExtensions": { "TmLanguage": "a" },
            "folderNames": { "META-INF": "a" }
        }"#;
        let document = IconThemeDocument::parse(source, "test").expect("parses");
        assert!(document.associations.file_extensions.contains_key("tmlanguage"));
        assert!(document.associations.folder_names.contains_key("meta-inf"));
    }

    #[test]
    fn a_document_with_no_definitions_is_not_an_icon_theme() {
        let error = IconThemeDocument::parse(r#"{"file":"a"}"#, "test").unwrap_err();
        assert!(error.to_string().contains("not an icon theme"), "{error}");
    }

    #[test]
    fn warns_about_a_dangling_association() {
        let source = r#"{
            "iconDefinitions": { "a": { "iconPath": "./a.svg" } },
            "fileNames": { "x": "gone" }
        }"#;
        let document = IconThemeDocument::parse(source, "test").expect("parses");
        let warnings = document.warnings();
        assert_eq!(warnings.len(), 1);
        assert_eq!(warnings[0].key, "iconDefinitions.gone");
    }

    #[test]
    fn warns_about_a_glyph_naming_an_undeclared_font() {
        let source = r#"{
            "fonts": [{ "id": "seti", "src": [{ "path": "./seti.woff", "format": "woff" }] }],
            "iconDefinitions": {
                "a": { "fontCharacter": "\\E001", "fontId": "seti" },
                "b": { "fontCharacter": "\\E002", "fontId": "ghost" }
            },
            "file": "a"
        }"#;
        let document = IconThemeDocument::parse(source, "test").expect("parses");
        let warnings = document.warnings();
        assert_eq!(warnings.len(), 1);
        assert!(warnings[0].message.contains("ghost"), "{:?}", warnings[0]);
    }

    #[test]
    fn a_font_with_css_in_its_fields_is_dropped_with_a_warning() {
        let source = r##"{
            "fonts": [
                { "id": "ok", "weight": "400", "style": "normal",
                  "src": [
                    { "path": "./a.woff", "format": "woff" },
                    { "path": "./b.woff", "format": "woff\"); } body { display: none" }
                  ] },
                { "id": "x;}", "src": [{ "path": "./c.woff", "format": "woff" }] },
                { "id": "y", "weight": "bold}", "src": [] },
                { "id": "z", "style": "<script>", "src": [] }
            ],
            "iconDefinitions": { "a": { "fontCharacter": "\\E001", "fontId": "ok" } },
            "file": "a"
        }"##;
        let document = IconThemeDocument::parse(source, "test").expect("parses");
        assert_eq!(document.fonts.len(), 1);
        assert_eq!(document.fonts[0].id, "ok");
        assert_eq!(document.fonts[0].src.len(), 1, "the bad source is dropped");
        assert_eq!(document.warnings().len(), 4, "{:?}", document.warnings());
        assert!(is_plain_css_word("Seti Icons_2-x"));
        assert!(!is_plain_css_word(""));
    }

    #[test]
    fn reads_a_font_backed_definition() {
        let source = r##"{
            "fonts": [{
                "id": "seti", "weight": "normal", "style": "normal", "size": "150%",
                "src": [{ "path": "./seti.woff", "format": "woff" }]
            }],
            "iconDefinitions": {
                "_default": { "fontCharacter": "\\E001", "fontColor": "#cccccc", "fontId": "seti" }
            },
            "file": "_default"
        }"##;
        let document = IconThemeDocument::parse(source, "test").expect("parses");
        assert_eq!(document.fonts[0].size.as_deref(), Some("150%"));
        let definition = &document.icon_definitions["_default"];
        assert_eq!(definition.resolved(), DefinitionKind::Glyph { character: "\\E001" });
        assert_eq!(definition.font_color.as_deref(), Some("#cccccc"));
    }
}
