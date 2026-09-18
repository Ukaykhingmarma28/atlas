//! IPC for theme import and export.
//!
//! Three verbs, and the split between them is the point:
//!
//!  - [`preview_theme_import`] converts and reports, and **writes nothing**.
//!    A VS Code import is lossy by construction, so the user has to be able to
//!    read what happened to their theme before it becomes a file.
//!  - [`commit_theme_import`] writes the reviewed TOML into
//!    `~/.config/atlas/themes/`, where the existing watcher picks it up and
//!    `atlas:themes-changed` refreshes the picker. No new event channel.
//!  - [`export_theme_shadcn`] goes the other way, for pasting an Atlas theme
//!    into a shadcn project.
//!
//! The conversion itself lives in `atlas-theme` next to the parser and the
//! writer. Nothing here knows what a shadcn token is.

use std::path::{Path, PathBuf};
use std::time::Duration;

use atlas_theme::export::ShadcnExport;
use atlas_theme::import::report::ImportReport;
use atlas_theme::import::{ImportFormat, ImportOptions};
use atlas_theme::{Theme, ThemeOrigin};
use serde::{Deserialize, Serialize};

/// A fetch is a courtesy, not a feature: a theme URL that does not answer
/// promptly is a worse experience than "paste it instead".
const FETCH_TIMEOUT: Duration = Duration::from_secs(10);

/// Enough for any theme file and a hard stop on a URL that streams forever.
const MAX_FETCH_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeImportInput {
    /// Pasted JSON or CSS.
    #[serde(default)]
    pub text: Option<String>,
    /// An `http(s)` URL to fetch the theme from.
    #[serde(default)]
    pub url: Option<String>,
    /// A local file. The only source that can resolve a VS Code `include`,
    /// because an `include` is a sibling path.
    #[serde(default)]
    pub path: Option<String>,
    /// Forces a format instead of sniffing one.
    #[serde(default)]
    pub format: Option<ImportFormat>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeImportCandidate {
    pub id: String,
    pub name: String,
    pub author: String,
    pub license: String,
    pub variants: Vec<String>,
    /// The file that `commit_theme_import` would write.
    pub toml: String,
    pub theme: Theme,
    pub report: ImportReport,
    /// Whether committing would create, replace or shadow something.
    pub existing: ThemeOrigin,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeImportPreview {
    /// Where the bytes came from, for the "imported from" line.
    pub origin: String,
    /// The format that was used, sniffed or forced.
    pub format: String,
    /// One per theme in the source; a Zed family has several.
    pub themes: Vec<ThemeImportCandidate>,
}

/// Convert a foreign theme and report on it, without writing anything.
#[tauri::command]
pub async fn preview_theme_import(input: ThemeImportInput) -> Result<ThemeImportPreview, String> {
    let (source, origin, base_dir) = read_source(input.text, input.url, input.path).await?;
    let format = input.format;

    // Parsing a theme is pure CPU over a few hundred KB at most, but it shares
    // the command runtime with the UI's IPC channel, so it goes off-thread like
    // any other non-trivial work.
    tokio::task::spawn_blocking(move || {
        let options = ImportOptions { origin: origin.clone(), ..ImportOptions::default() };
        let detected = format
            .or_else(|| atlas_theme::import::detect_format(&source))
            .map_or_else(|| "unknown".to_string(), |format| format.label().to_string());
        let imported = atlas_theme::import::import_themes(&source, format, base_dir.as_deref(), &options)
            .map_err(|error| error.to_string())?;
        Ok(ThemeImportPreview {
            origin,
            format: detected,
            themes: imported
                .into_iter()
                .map(|entry| ThemeImportCandidate {
                    existing: atlas_theme::theme_origin(&entry.theme.id),
                    id: entry.theme.id.clone(),
                    name: entry.theme.name.clone(),
                    author: entry.theme.author.clone(),
                    license: entry.theme.license.clone(),
                    variants: entry.report.variants.clone(),
                    toml: entry.toml,
                    theme: entry.theme,
                    report: entry.report,
                })
                .collect(),
        })
    })
    .await
    .map_err(|error| format!("theme import task failed: {error}"))?
}

/// Write a previewed theme into `~/.config/atlas/themes/<id>.toml`.
///
/// `id` and `name` are the user's, applied to the previewed TOML rather than
/// spliced into its text: the file is re-parsed, renamed and re-serialised, so
/// a name with a quote in it cannot produce a file that will not load.
#[tauri::command]
pub async fn commit_theme_import(toml: String, id: String, name: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let mut theme = atlas_theme::parse_theme(&toml, "import").map_err(|error| error.to_string())?;
        let id = atlas_theme::import::slug(&id);
        if id.is_empty() {
            return Err("a theme id needs at least one letter or digit".to_string());
        }
        theme.id = id;
        if !name.trim().is_empty() {
            theme.name = name.trim().to_string();
        }
        let rendered = atlas_theme::toml_writer::theme_to_toml(&theme);
        atlas_theme::write_user_theme(&rendered)
            .map(|path| path.display().to_string())
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| format!("theme write task failed: {error}"))?
}

/// An Atlas theme as a shadcn registry item, plus what could not come along.
#[tauri::command]
pub async fn export_theme_shadcn(id: String) -> Result<ShadcnExport, String> {
    tokio::task::spawn_blocking(move || {
        atlas_theme::get_theme(&id)
            .map(|theme| atlas_theme::export::to_shadcn_registry_item(&theme))
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| format!("theme export task failed: {error}"))?
}

/// Resolve the three input shapes to `(source, origin label, base dir)`.
async fn read_source(
    text: Option<String>,
    url: Option<String>,
    path: Option<String>,
) -> Result<(String, String, Option<PathBuf>), String> {
    if let Some(path) = path.filter(|path| !path.trim().is_empty()) {
        let path = PathBuf::from(path);
        let origin = path
            .file_name()
            .map_or_else(|| path.display().to_string(), |name| name.to_string_lossy().into_owned());
        let base_dir = path.parent().map(Path::to_path_buf);
        let label = origin.clone();
        let source = tokio::task::spawn_blocking(move || std::fs::read_to_string(&path))
            .await
            .map_err(|error| format!("theme read task failed: {error}"))?
            .map_err(|error| format!("could not read {label}: {error}"))?;
        return Ok((source, origin, base_dir));
    }
    if let Some(url) = url.filter(|url| !url.trim().is_empty()) {
        let source = fetch(url.trim()).await?;
        return Ok((source, url.trim().to_string(), None));
    }
    let text = text.unwrap_or_default();
    if text.trim().is_empty() {
        return Err("nothing to import: paste a theme, give a URL, or choose a file".to_string());
    }
    Ok((text, "pasted text".to_string(), None))
}

/// Fetch a theme over HTTP, time-bounded and size-bounded.
///
/// Never called at startup and never retried: an import is something the user
/// asked for, once, with a URL they typed. Offline is an ordinary error
/// message, not a failure state the app has to recover from.
async fn fetch(url: &str) -> Result<String, String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("a theme URL must start with https:// or http://".to_string());
    }
    let client = reqwest::Client::builder()
        .timeout(FETCH_TIMEOUT)
        .user_agent("Atlas-IDE")
        .build()
        .map_err(|error| format!("could not build an HTTP client: {error}"))?;
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|error| format!("could not fetch {url}: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("{url} answered {}", response.status()));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("could not read {url}: {error}"))?;
    if bytes.len() > MAX_FETCH_BYTES {
        return Err(format!("{url} returned {} bytes; the limit is 4 MB", bytes.len()));
    }
    String::from_utf8(bytes.to_vec()).map_err(|_| format!("{url} did not return text"))
}
