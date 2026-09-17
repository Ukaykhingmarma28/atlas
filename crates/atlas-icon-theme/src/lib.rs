//! Icon themes: VS Code's `iconThemes` format, loaded, resolved and served.
//!
//! Atlas takes the format verbatim (decision 4), so a theme published for VS
//! Code installs here unchanged. This crate owns everything about that: the
//! document shape ([`format`]), the precedence rules ([`resolve`]), the
//! `.vsix` reader ([`vsix`]), and the catalog of what is installed.
//!
//! # The lazy part
//!
//! Material Icon Theme — the bundled default (decision 12) — is a 444 KB
//! document naming 1,251 SVGs that come to about 1 MB. None of that may reach
//! the webview at startup, so the API is split in three:
//!
//!   * [`resolve_icons`] answers *which* definition each visible path uses. The
//!     reply is one short id per row, and glyph definitions carry their
//!     character and colour inline because those are a few bytes each.
//!   * [`icon_assets`] fetches the SVG source for a batch of definition ids.
//!     The frontend asks only for ids it has not already cached, so a project
//!     of TypeScript files transfers a handful of icons, not a thousand.
//!   * [`icon_fonts`] fetches a glyph theme's web fonts, and is never called
//!     for a theme that has none.
//!
//! The document itself is parsed once per theme and cached in-process; the
//! cache is dropped when a theme is installed or removed.

use std::collections::BTreeMap;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use thiserror::Error;

pub mod format;
pub mod resolve;
pub mod vsix;

pub use format::{
    Associations, DefinitionKind, IconDefinition, IconFont, IconFontSource, IconThemeDocument,
    IconThemeWarning,
};
pub use resolve::{Appearance, IconKind, IconRequest};

/// The id of the theme that renders Atlas's own lucide icons — the opt-out.
///
/// It is not a document: "minimal" means *no icon theme*, and the frontend
/// keeps rendering what it rendered before icon themes existed. Modelling it
/// as an empty theme instead would have meant inventing 1,200 lucide
/// associations to say "carry on".
pub const MINIMAL_ICON_THEME_ID: &str = "minimal";

/// The bundled default (decision 12).
pub const MATERIAL_ICON_THEME_ID: &str = "material-icon-theme";

/// What a fresh install selects.
pub const DEFAULT_ICON_THEME_ID: &str = MATERIAL_ICON_THEME_ID;

const MATERIAL_DOCUMENT: &str =
    include_str!("../vendor/material-icon-theme/dist/material-icons.json");
const MATERIAL_BLOB: &str = include_str!(concat!(env!("OUT_DIR"), "/material_icons_blob.txt"));
include!(concat!(env!("OUT_DIR"), "/material_icons_index.rs"));

#[derive(Debug, Error)]
pub enum IconThemeError {
    #[error("icon theme \"{id}\" is not installed")]
    NotFound { id: String },
    #[error("{origin}: {message}")]
    Parse { origin: String, message: String },
    #[error("{path}: {source}")]
    Io { path: PathBuf, source: io::Error },
    #[error("{message}")]
    Vsix { message: String },
    #[error("{message}")]
    Install { message: String },
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

/// One row in the icon-theme picker.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IconThemeSummary {
    pub id: String,
    pub name: String,
    pub author: String,
    pub license: String,
    /// `true` for `minimal` and the bundled Material theme — neither can be
    /// removed.
    pub built_in: bool,
    /// The theme asks the explorer to drop its twisty chevrons, because its
    /// folder icons already say open or closed.
    pub hides_explorer_arrows: bool,
    /// `true` when the theme has no document at all (`minimal`), so the
    /// frontend knows to use its own icons without asking for any.
    pub uses_fallback_icons: bool,
    /// Survivable problems found while loading. Never blocks the theme.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<IconThemeWarning>,
}

/// Where a theme's files come from.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Source {
    /// No document: Atlas's own icons.
    Fallback,
    /// Compiled into the binary. `doc_dir` is the document's directory inside
    /// the vendored tree, which is what relative `iconPath`s resolve against.
    Embedded { doc_dir: &'static str },
    /// An unpacked VS Code extension under the user's icon-theme directory.
    Directory { document: PathBuf },
}

/// A theme with its document parsed, as the cache holds it.
#[derive(Debug)]
pub struct LoadedIconTheme {
    pub summary: IconThemeSummary,
    /// `None` only for `minimal`.
    pub document: Option<IconThemeDocument>,
    source: Source,
}

/// `~/.config/atlas/icon-themes`, the sibling of `~/.config/atlas/themes`.
pub fn user_icon_theme_dir() -> Option<PathBuf> {
    dirs::config_dir().map(|dir| dir.join("atlas").join("icon-themes"))
}

fn minimal_summary() -> IconThemeSummary {
    IconThemeSummary {
        id: MINIMAL_ICON_THEME_ID.to_string(),
        name: "Minimal".to_string(),
        author: "Atlas".to_string(),
        license: "MIT".to_string(),
        built_in: true,
        hides_explorer_arrows: false,
        uses_fallback_icons: true,
        warnings: Vec::new(),
    }
}

/// The metadata Atlas reads out of an unpacked extension's `package.json`.
///
/// Everything else in a VS Code manifest — activation events, commands,
/// configuration — describes an extension host Atlas does not have, so it is
/// not modelled. `serde` ignores unknown fields, which is the whole point.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExtensionManifest {
    #[serde(default)]
    name: String,
    #[serde(default)]
    display_name: Option<String>,
    #[serde(default)]
    publisher: Option<String>,
    #[serde(default)]
    license: Option<String>,
    #[serde(default)]
    contributes: Contributes,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Contributes {
    #[serde(default)]
    icon_themes: Vec<IconThemeContribution>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IconThemeContribution {
    #[serde(default)]
    label: Option<String>,
    path: String,
}

impl ExtensionManifest {
    fn read(path: &Path) -> Result<Self, IconThemeError> {
        let source = std::fs::read_to_string(path)
            .map_err(|source| IconThemeError::Io { path: path.to_path_buf(), source })?;
        serde_json::from_str(&source).map_err(|error| IconThemeError::Parse {
            origin: path.display().to_string(),
            message: error.to_string(),
        })
    }
}

/// Read one unpacked VS Code extension directory as an icon theme.
///
/// `root` is the directory holding `package.json` — the `extension/` subtree of
/// a `.vsix`, unpacked. Public so a test can exercise a theme without one being
/// installed in the real config directory.
pub fn load_from_directory(id: &str, root: &Path) -> Result<LoadedIconTheme, IconThemeError> {
    let manifest = ExtensionManifest::read(&root.join("package.json"))?;
    let contribution =
        manifest.contributes.icon_themes.first().ok_or_else(|| IconThemeError::Parse {
            origin: root.join("package.json").display().to_string(),
            message: "declares no `contributes.iconThemes`".to_string(),
        })?;
    let document_path = resolve_relative(root, &contribution.path);
    let source = std::fs::read_to_string(&document_path)
        .map_err(|source| IconThemeError::Io { path: document_path.clone(), source })?;
    let document = IconThemeDocument::parse(&source, &document_path.display().to_string())?;
    let summary = IconThemeSummary {
        id: id.to_string(),
        name: contribution
            .label
            .clone()
            .or_else(|| manifest.display_name.clone())
            .unwrap_or_else(|| manifest.name.clone()),
        author: manifest.publisher.clone().unwrap_or_else(|| "Unknown".to_string()),
        license: manifest.license.clone().unwrap_or_else(|| "Unspecified".to_string()),
        built_in: false,
        hides_explorer_arrows: document.hides_explorer_arrows,
        uses_fallback_icons: false,
        warnings: document.warnings(),
    };
    Ok(LoadedIconTheme {
        summary,
        document: Some(document),
        source: Source::Directory { document: document_path },
    })
}

fn load_material() -> Result<LoadedIconTheme, IconThemeError> {
    let document = IconThemeDocument::parse(MATERIAL_DOCUMENT, "material-icon-theme")?;
    let summary = IconThemeSummary {
        id: MATERIAL_ICON_THEME_ID.to_string(),
        name: "Material Icon Theme".to_string(),
        author: "Philipp Kief (Material Extensions)".to_string(),
        license: "MIT".to_string(),
        built_in: true,
        hides_explorer_arrows: document.hides_explorer_arrows,
        uses_fallback_icons: false,
        warnings: document.warnings(),
    };
    Ok(LoadedIconTheme {
        summary,
        document: Some(document),
        source: Source::Embedded { doc_dir: "dist" },
    })
}

/// Join a relative `iconPath` onto a directory, folding `.` and `..`.
///
/// Material's paths look like `./../icons/git.svg` relative to `dist/`, so
/// this has to actually normalise rather than concatenate.
fn resolve_relative(root: &Path, relative: &str) -> PathBuf {
    let mut out = root.to_path_buf();
    for segment in relative.replace('\\', "/").split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                out.pop();
            }
            other => out.push(other),
        }
    }
    out
}

/// The same, over the embedded tree's virtual paths.
fn resolve_relative_virtual(dir: &str, relative: &str) -> String {
    let mut out: Vec<String> =
        dir.split('/').filter(|s| !s.is_empty() && *s != ".").map(str::to_string).collect();
    for segment in relative.replace('\\', "/").split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                out.pop();
            }
            other => out.push(other.to_string()),
        }
    }
    out.join("/")
}

fn embedded_asset(virtual_path: &str) -> Option<&'static str> {
    let name = virtual_path.strip_prefix("icons/")?;
    let at = MATERIAL_ICON_INDEX.binary_search_by(|(key, _, _)| (*key).cmp(name)).ok()?;
    let (_, start, end) = MATERIAL_ICON_INDEX[at];
    Some(&MATERIAL_BLOB[start..end])
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

type Cache = Mutex<BTreeMap<String, Arc<LoadedIconTheme>>>;

fn cache() -> &'static Cache {
    static CACHE: OnceLock<Cache> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(BTreeMap::new()))
}

/// Forget every parsed document. Called after an install or a removal.
pub fn invalidate_cache() {
    if let Ok(mut cache) = cache().lock() {
        cache.clear();
    }
}

/// Load a theme by id, from cache when it is there.
pub fn load(id: &str) -> Result<Arc<LoadedIconTheme>, IconThemeError> {
    if let Ok(cache) = cache().lock() {
        if let Some(theme) = cache.get(id) {
            return Ok(Arc::clone(theme));
        }
    }
    let loaded = Arc::new(load_uncached(id)?);
    if let Ok(mut cache) = cache().lock() {
        cache.insert(id.to_string(), Arc::clone(&loaded));
    }
    Ok(loaded)
}

fn load_uncached(id: &str) -> Result<LoadedIconTheme, IconThemeError> {
    match id {
        MINIMAL_ICON_THEME_ID => Ok(LoadedIconTheme {
            summary: minimal_summary(),
            document: None,
            source: Source::Fallback,
        }),
        MATERIAL_ICON_THEME_ID => load_material(),
        other => {
            let dir = user_icon_theme_dir()
                .map(|dir| dir.join(other))
                .filter(|dir| dir.is_dir())
                .ok_or_else(|| IconThemeError::NotFound { id: other.to_string() })?;
            load_from_directory(other, &dir)
        }
    }
}

/// Every installed theme, built-ins first.
///
/// A user theme that will not load is reported as a warning row rather than
/// taking the catalog down — the same posture `atlas-theme` settled on after a
/// half-typed file cost a user every colour theme in the app.
pub fn list() -> Vec<IconThemeSummary> {
    let mut out = vec![minimal_summary()];
    match load(MATERIAL_ICON_THEME_ID) {
        Ok(theme) => out.push(theme.summary.clone()),
        Err(error) => out.push(IconThemeSummary {
            id: MATERIAL_ICON_THEME_ID.to_string(),
            name: "Material Icon Theme".to_string(),
            author: "Philipp Kief (Material Extensions)".to_string(),
            license: "MIT".to_string(),
            built_in: true,
            hides_explorer_arrows: false,
            uses_fallback_icons: true,
            warnings: vec![IconThemeWarning {
                key: MATERIAL_ICON_THEME_ID.to_string(),
                message: error.to_string(),
            }],
        }),
    }
    let Some(dir) = user_icon_theme_dir() else {
        return out;
    };
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return out;
    };
    let mut installed: Vec<PathBuf> =
        entries.filter_map(Result::ok).map(|entry| entry.path()).filter(|p| p.is_dir()).collect();
    installed.sort();
    for path in installed {
        let Some(id) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        match load(id) {
            Ok(theme) => out.push(theme.summary.clone()),
            Err(error) => out.push(IconThemeSummary {
                id: id.to_string(),
                name: id.to_string(),
                author: "Unknown".to_string(),
                license: "Unspecified".to_string(),
                built_in: false,
                hides_explorer_arrows: false,
                uses_fallback_icons: true,
                warnings: vec![IconThemeWarning {
                    key: id.to_string(),
                    message: error.to_string(),
                }],
            }),
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/// What the frontend draws for one path.
///
/// An image carries only its definition id, because the SVG is fetched in a
/// second, batched, deduplicated call. A glyph carries everything inline: the
/// payload is a character and two short strings, and a round trip per glyph
/// would cost more than the data.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ResolvedIcon {
    #[serde(rename_all = "camelCase")]
    Image { definition: String },
    #[serde(rename_all = "camelCase")]
    Glyph {
        definition: String,
        /// The actual character, already decoded from the theme's `\E001`
        /// escape — the webview renders it as text, not as CSS `content`.
        character: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        color: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        size: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        font_id: Option<String>,
    },
}

/// `"\\E001"` (four characters after JSON decoding: `\`, `E`, `0`, `1`) is a
/// codepoint escape, not text. VS Code hands it to CSS `content:`, which reads
/// it that way; Atlas renders the glyph as a text node, so it is decoded here.
fn decode_font_character(raw: &str) -> String {
    let Some(hex) = raw.strip_prefix('\\') else {
        return raw.to_string();
    };
    let hex = hex.trim();
    match u32::from_str_radix(hex, 16).ok().and_then(char::from_u32) {
        Some(character) => character.to_string(),
        // Not a valid escape: hand back what the theme wrote rather than
        // silently drawing nothing.
        None => raw.to_string(),
    }
}

/// Resolve a batch of paths against a theme.
///
/// `None` at a position means "the theme has nothing for this" and the caller
/// should draw its own icon. `minimal` answers `None` for everything.
pub fn resolve_icons(
    theme: &LoadedIconTheme,
    requests: &[IconRequest],
    appearance: Appearance,
) -> Vec<Option<ResolvedIcon>> {
    let Some(document) = theme.document.as_ref() else {
        return vec![None; requests.len()];
    };
    requests
        .iter()
        .map(|request| {
            let id = resolve::resolve(document, request, appearance)?;
            let definition = document.icon_definitions.get(id)?;
            match definition.resolved() {
                DefinitionKind::Image { .. } => {
                    Some(ResolvedIcon::Image { definition: id.to_string() })
                }
                DefinitionKind::Glyph { character } => Some(ResolvedIcon::Glyph {
                    definition: id.to_string(),
                    character: decode_font_character(character),
                    color: definition.font_color.clone(),
                    size: definition.font_size.clone(),
                    font_id: definition.font_id.clone(),
                }),
                DefinitionKind::Empty => None,
            }
        })
        .collect()
}

/// One icon's bytes, in the form the webview can use directly.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum IconAsset {
    /// SVG source, to be inlined. Inlining rather than a `data:` URL is what
    /// lets `currentColor` in a theme's SVG follow the colour theme.
    #[serde(rename_all = "camelCase")]
    Svg { source: String },
    /// Anything else (PNG), as a ready-made `data:` URL.
    #[serde(rename_all = "camelCase")]
    DataUrl { url: String },
}

/// Fetch the assets for a batch of definition ids.
///
/// Ids the theme does not define, or that are glyphs rather than images, are
/// simply absent from the reply — the caller asked for a set and gets back
/// what exists, which is cheaper to handle than a map full of nulls.
pub fn icon_assets(theme: &LoadedIconTheme, definitions: &[String]) -> BTreeMap<String, IconAsset> {
    let mut out = BTreeMap::new();
    let Some(document) = theme.document.as_ref() else {
        return out;
    };
    for id in definitions {
        let Some(definition) = document.icon_definitions.get(id) else {
            continue;
        };
        let DefinitionKind::Image { path } = definition.resolved() else {
            continue;
        };
        let Some(asset) = read_asset(theme, path) else {
            continue;
        };
        out.insert(id.clone(), asset);
    }
    out
}

fn read_asset(theme: &LoadedIconTheme, relative: &str) -> Option<IconAsset> {
    match &theme.source {
        Source::Fallback => None,
        Source::Embedded { doc_dir } => {
            let virtual_path = resolve_relative_virtual(doc_dir, relative);
            // The bundled theme is SVG-only, which the build script enforces by
            // packing nothing else.
            embedded_asset(&virtual_path)
                .map(|source| IconAsset::Svg { source: source.to_string() })
        }
        Source::Directory { document } => {
            let dir = document.parent()?;
            let path = resolve_relative(dir, relative);
            let bytes = std::fs::read(&path).ok()?;
            Some(asset_from_bytes(&path, bytes))
        }
    }
}

fn asset_from_bytes(path: &Path, bytes: Vec<u8>) -> IconAsset {
    let extension =
        path.extension().and_then(|ext| ext.to_str()).unwrap_or_default().to_lowercase();
    if extension == "svg" {
        if let Ok(source) = String::from_utf8(bytes.clone()) {
            return IconAsset::Svg { source };
        }
    }
    let media_type = match extension.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        _ => "application/octet-stream",
    };
    IconAsset::DataUrl { url: format!("data:{media_type};base64,{}", base64_encode(&bytes)) }
}

/// A web font a glyph theme needs, with its files inlined.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IconFontFace {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub weight: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub style: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<String>,
    pub src: Vec<IconFontData>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IconFontData {
    /// The CSS `format()` hint, as the theme wrote it (`woff`, `woff2`, …).
    pub format: String,
    /// A `data:` URL, so the webview needs no file access to load the font.
    pub url: String,
}

/// The theme's fonts, with each file read and inlined.
///
/// Empty for every SVG theme, which is why the frontend calls it only when a
/// resolved icon actually turns out to be a glyph.
pub fn icon_fonts(theme: &LoadedIconTheme) -> Vec<IconFontFace> {
    let Some(document) = theme.document.as_ref() else {
        return Vec::new();
    };
    document
        .fonts
        .iter()
        .map(|font| IconFontFace {
            id: font.id.clone(),
            weight: font.weight.clone(),
            style: font.style.clone(),
            size: font.size.clone(),
            src: font
                .src
                .iter()
                .filter_map(|source| {
                    let bytes = read_font_bytes(theme, &source.path)?;
                    let media_type = match source.format.as_str() {
                        "woff2" => "font/woff2",
                        "woff" => "font/woff",
                        "truetype" | "ttf" => "font/ttf",
                        "opentype" | "otf" => "font/otf",
                        _ => "application/octet-stream",
                    };
                    Some(IconFontData {
                        format: source.format.clone(),
                        url: format!("data:{media_type};base64,{}", base64_encode(&bytes)),
                    })
                })
                .collect(),
        })
        .collect()
}

fn read_font_bytes(theme: &LoadedIconTheme, relative: &str) -> Option<Vec<u8>> {
    match &theme.source {
        // The bundled theme has no fonts, and the build script packs SVG text
        // only — a font would have to be a directory theme.
        Source::Fallback | Source::Embedded { .. } => None,
        Source::Directory { document } => {
            std::fs::read(resolve_relative(document.parent()?, relative)).ok()
        }
    }
}

/// Standard base64, written out here rather than taking a dependency for it:
/// the crate needs exactly this, and the alphabet has not changed since 1987.
fn base64_encode(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let packed = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        out.push(ALPHABET[(packed >> 18) as usize & 63] as char);
        out.push(ALPHABET[(packed >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { ALPHABET[(packed >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { ALPHABET[packed as usize & 63] as char } else { '=' });
    }
    out
}

// ---------------------------------------------------------------------------
// Install / remove
// ---------------------------------------------------------------------------

/// Install a `.vsix` payload as `id`, replacing any theme already under that
/// id. The bytes are whatever the caller downloaded; this does the unpacking.
pub fn install_vsix(id: &str, archive_bytes: &[u8]) -> Result<IconThemeSummary, IconThemeError> {
    if is_built_in(id) {
        return Err(IconThemeError::Install {
            message: format!("\"{id}\" is built in and cannot be replaced"),
        });
    }
    let dir = user_icon_theme_dir().ok_or_else(|| IconThemeError::Install {
        message: "no config directory on this system".to_string(),
    })?;
    let target = dir.join(id);
    // Unpack beside the target and swap, so a failed install never leaves a
    // half-written theme where the catalog can find it.
    let staging = dir.join(format!(".{id}.installing"));
    let _ = std::fs::remove_dir_all(&staging);
    vsix::unpack_extension(archive_bytes, &staging).inspect_err(|_| {
        let _ = std::fs::remove_dir_all(&staging);
    })?;
    // Fail before the swap if what was unpacked is not an icon theme at all.
    let check = load_from_directory(id, &staging);
    let summary = match check {
        Ok(theme) => theme.summary,
        Err(error) => {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(error);
        }
    };
    let _ = std::fs::remove_dir_all(&target);
    std::fs::rename(&staging, &target)
        .map_err(|source| IconThemeError::Io { path: target.clone(), source })?;
    invalidate_cache();
    Ok(summary)
}

/// Remove an installed theme. Built-ins are refused.
pub fn remove(id: &str) -> Result<(), IconThemeError> {
    if is_built_in(id) {
        return Err(IconThemeError::Install {
            message: format!("\"{id}\" is built in and cannot be removed"),
        });
    }
    let dir = user_icon_theme_dir()
        .map(|dir| dir.join(id))
        .filter(|dir| dir.is_dir())
        .ok_or_else(|| IconThemeError::NotFound { id: id.to_string() })?;
    std::fs::remove_dir_all(&dir)
        .map_err(|source| IconThemeError::Io { path: dir.clone(), source })?;
    invalidate_cache();
    Ok(())
}

pub fn is_built_in(id: &str) -> bool {
    id == MINIMAL_ICON_THEME_ID || id == MATERIAL_ICON_THEME_ID
}

/// An id is a single path segment used as a directory name, so a value with a
/// separator or a `..` in it would escape the icon-theme directory.
pub fn is_valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id != "."
        && id != ".."
        && id.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_bundled_material_theme_loads() {
        let theme = load_material().expect("the vendored theme parses");
        assert_eq!(theme.summary.id, MATERIAL_ICON_THEME_ID);
        assert_eq!(theme.summary.license, "MIT");
        let document = theme.document.as_ref().expect("has a document");
        assert!(document.icon_definitions.len() > 1000, "1,251 at 5.38.1");
        assert!(document.associations.file_extensions.len() > 1000);
        assert!(document.light.is_some(), "Material ships a light section");
    }

    #[test]
    fn the_bundled_theme_has_no_dangling_associations() {
        let theme = load_material().expect("parses");
        assert_eq!(
            theme.summary.warnings,
            Vec::new(),
            "a vendored theme with warnings means the extraction dropped files"
        );
    }

    #[test]
    fn every_bundled_image_definition_has_its_bytes() {
        // The failure this catches: vendoring `dist/material-icons.json`
        // without all 1,251 SVGs beside it. Every icon would resolve and none
        // would draw.
        let theme = load_material().expect("parses");
        let document = theme.document.as_ref().expect("document");
        let ids: Vec<String> = document.icon_definitions.keys().cloned().collect();
        let assets = icon_assets(&theme, &ids);
        let images = document
            .icon_definitions
            .iter()
            .filter(|(_, d)| matches!(d.resolved(), DefinitionKind::Image { .. }))
            .count();
        assert_eq!(assets.len(), images, "every image definition resolves to bytes");
        assert!(images > 1000);
    }

    #[test]
    fn a_typescript_file_gets_the_typescript_icon_from_the_bundled_theme() {
        let theme = load_material().expect("parses");
        let requests = vec![
            IconRequest { path: "/p/src/main.ts".into(), kind: IconKind::File, language_id: None },
            IconRequest { path: "/p/src".into(), kind: IconKind::Folder, language_id: None },
            IconRequest { path: "/p/README.md".into(), kind: IconKind::File, language_id: None },
        ];
        let resolved = resolve_icons(&theme, &requests, Appearance::Dark);
        let names: Vec<String> = resolved
            .into_iter()
            .map(|icon| match icon {
                Some(ResolvedIcon::Image { definition }) => definition,
                other => panic!("expected an image, got {other:?}"),
            })
            .collect();
        assert_eq!(names, vec!["typescript", "folder-src", "readme"]);
    }

    #[test]
    fn minimal_resolves_nothing_and_says_so() {
        let theme = load(MINIMAL_ICON_THEME_ID).expect("always available");
        assert!(theme.summary.uses_fallback_icons);
        let requests =
            vec![IconRequest { path: "a.ts".into(), kind: IconKind::File, language_id: None }];
        assert_eq!(resolve_icons(&theme, &requests, Appearance::Dark), vec![None]);
        assert!(icon_fonts(&theme).is_empty());
    }

    #[test]
    fn the_catalog_always_offers_both_built_ins() {
        let ids: Vec<String> = list().into_iter().map(|theme| theme.id).collect();
        assert!(ids.contains(&MINIMAL_ICON_THEME_ID.to_string()));
        assert!(ids.contains(&MATERIAL_ICON_THEME_ID.to_string()));
    }

    #[test]
    fn built_ins_refuse_to_be_removed() {
        assert!(remove(MATERIAL_ICON_THEME_ID).is_err());
        assert!(remove(MINIMAL_ICON_THEME_ID).is_err());
    }

    #[test]
    fn an_id_that_would_escape_the_theme_directory_is_rejected() {
        assert!(is_valid_id("PKief.material-icon-theme"));
        assert!(!is_valid_id("../../etc"));
        assert!(!is_valid_id("a/b"));
        assert!(!is_valid_id(".."));
        assert!(!is_valid_id(""));
    }

    #[test]
    fn font_characters_are_decoded_to_the_codepoint() {
        assert_eq!(decode_font_character("\\E001"), "\u{E001}");
        assert_eq!(decode_font_character("\\f101"), "\u{f101}");
        assert_eq!(decode_font_character("x"), "x", "not an escape: passed through");
        assert_eq!(decode_font_character("\\zzzz"), "\\zzzz", "invalid hex: passed through");
    }

    #[test]
    fn relative_icon_paths_fold_dot_and_dotdot() {
        assert_eq!(resolve_relative_virtual("dist", "./../icons/git.svg"), "icons/git.svg");
        assert_eq!(resolve_relative_virtual("", "./icons/a.svg"), "icons/a.svg");
        assert_eq!(
            resolve_relative(Path::new("/root/dist"), "./../icons/a.svg"),
            PathBuf::from("/root/icons/a.svg")
        );
    }

    #[test]
    fn base64_matches_the_rfc_vectors() {
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"foob"), "Zm9vYg==");
        assert_eq!(base64_encode(b"fooba"), "Zm9vYmE=");
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
    }
}
