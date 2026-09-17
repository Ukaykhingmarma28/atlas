//! IPC for icon themes (decisions 4, 11 and 12).
//!
//! Three read commands carry the lazy-loading contract that keeps 1 MB of
//! bundled SVGs off the startup path:
//!
//!   * `resolve_icons` takes a batch of paths and answers with definition ids.
//!   * `get_icon_theme_assets` takes a batch of ids and answers with bytes.
//!   * `get_icon_theme_fonts` is called only when a resolve returned a glyph.
//!
//! The frontend caches assets by id, so scrolling a project of TypeScript
//! files transfers a handful of icons rather than the theme.
//!
//! Three write commands cover Open VSX, which decision 11 leaves as the only
//! remote source (the `atlas-themes` community repo was dropped, so nothing
//! else fetches). Every one of them is explicitly invoked, time-bounded, and
//! reports its failure as a message the picker can show: **nothing here runs
//! at startup**, and being offline costs a search, not a launch.

use std::collections::BTreeMap;
use std::time::Duration;

use atlas_icon_theme::{
    Appearance, IconAsset, IconFontFace, IconRequest, IconThemeSummary, ResolvedIcon,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

pub const ICON_THEMES_CHANGED_EVENT: &str = "atlas:icon-themes-changed";

/// Open VSX's public API. No key, no account, and the only network Atlas
/// touches for icon themes.
const OPEN_VSX_API: &str = "https://open-vsx.org/api";

/// A search or a metadata read is a person waiting on a dialog.
const METADATA_TIMEOUT: Duration = Duration::from_secs(10);
/// A `.vsix` is ~1 MB for the largest theme published; a minute is generous.
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(60);
/// Past this, the payload is not an icon theme and the download is abandoned
/// rather than buffered. Material, the biggest by far, is 890 KB.
const MAX_VSIX_BYTES: usize = 32 * 1024 * 1024;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct IconThemesChangedEvent {
    kind: &'static str,
}

fn notify(app: &AppHandle) {
    let _ =
        app.emit(ICON_THEMES_CHANGED_EVENT, IconThemesChangedEvent { kind: "icon-themes-changed" });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn list_icon_themes() -> Result<Vec<IconThemeSummary>, String> {
    tokio::task::spawn_blocking(atlas_icon_theme::list)
        .await
        .map_err(|error| format!("icon theme list task failed: {error}"))
}

#[tauri::command]
pub async fn resolve_icons(
    theme_id: String,
    appearance: Appearance,
    requests: Vec<IconRequest>,
) -> Result<Vec<Option<ResolvedIcon>>, String> {
    tokio::task::spawn_blocking(move || {
        let theme = atlas_icon_theme::load(&theme_id).map_err(|error| error.to_string())?;
        Ok(atlas_icon_theme::resolve_icons(&theme, &requests, appearance))
    })
    .await
    .map_err(|error| format!("icon resolve task failed: {error}"))?
}

#[tauri::command]
pub async fn get_icon_theme_assets(
    theme_id: String,
    definitions: Vec<String>,
) -> Result<BTreeMap<String, IconAsset>, String> {
    tokio::task::spawn_blocking(move || {
        let theme = atlas_icon_theme::load(&theme_id).map_err(|error| error.to_string())?;
        Ok(atlas_icon_theme::icon_assets(&theme, &definitions))
    })
    .await
    .map_err(|error| format!("icon asset task failed: {error}"))?
}

#[tauri::command]
pub async fn get_icon_theme_fonts(theme_id: String) -> Result<Vec<IconFontFace>, String> {
    tokio::task::spawn_blocking(move || {
        let theme = atlas_icon_theme::load(&theme_id).map_err(|error| error.to_string())?;
        Ok(atlas_icon_theme::icon_fonts(&theme))
    })
    .await
    .map_err(|error| format!("icon font task failed: {error}"))?
}

// ---------------------------------------------------------------------------
// Open VSX
// ---------------------------------------------------------------------------

/// One search hit, reduced to what the picker shows and what an install needs.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenVsxIconTheme {
    /// `namespace.name` — also the directory the theme installs into.
    pub id: String,
    pub namespace: String,
    pub name: String,
    pub display_name: String,
    pub version: String,
    pub description: String,
    pub license: String,
    pub downloads: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    /// Already installed under this id, so the picker offers "Reinstall".
    pub installed: bool,
}

fn http_client(timeout: Duration) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(timeout)
        .user_agent("Atlas-IDE")
        .build()
        .map_err(|error| format!("could not build an HTTP client: {error}"))
}

/// A network failure, said in a way a picker can show.
///
/// `reqwest`'s own Display is a chain ending in an OS errno, which reads as
/// noise in a dialog. Offline is the common case and deserves its own words.
fn network_error(context: &str, error: &reqwest::Error) -> String {
    if error.is_timeout() {
        return format!("{context} timed out — Open VSX did not answer in time.");
    }
    if error.is_connect() {
        return format!("{context} failed — Atlas could not reach open-vsx.org. Are you online?");
    }
    format!("{context} failed: {error}")
}

fn text_field(value: &serde_json::Value, key: &str) -> String {
    value.get(key).and_then(serde_json::Value::as_str).unwrap_or_default().to_string()
}

/// How many search hits are checked. Each costs one manifest fetch.
const SEARCH_CANDIDATES: usize = 20;

/// Search Open VSX for extensions that contribute an icon theme.
///
/// Open VSX has no icon-theme category — `Themes` covers colour themes,
/// product icon themes and file icon themes alike, and a search for "dracula"
/// returns mostly colour themes. Filtering on the name or the publisher's
/// keywords would be a guess, so each candidate's real `package.json` is
/// fetched and checked for `contributes.iconThemes`. That is the same fact the
/// install would later discover, learned before the user clicks rather than
/// after a 1 MB download.
///
/// The manifest lives at a predictable URL, so it is one request per
/// candidate, and the candidates are checked concurrently.
#[tauri::command]
pub async fn search_icon_themes(query: String) -> Result<Vec<OpenVsxIconTheme>, String> {
    let trimmed = query.trim().to_string();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }
    let client = http_client(METADATA_TIMEOUT)?;
    let url = format!(
        "{OPEN_VSX_API}/-/search?query={}&category=Themes&size={SEARCH_CANDIDATES}&sortBy=relevance&includeAllVersions=false",
        urlencoding(&trimmed)
    );
    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|error| network_error("The Open VSX search", &error))?;
    if !response.status().is_success() {
        return Err(format!("Open VSX answered {} to the search.", response.status()));
    }
    let body: serde_json::Value = response
        .json()
        .await
        .map_err(|error| format!("Open VSX sent a search result Atlas could not read: {error}"))?;

    let installed = tokio::task::spawn_blocking(atlas_icon_theme::list)
        .await
        .map_err(|error| format!("icon theme list task failed: {error}"))?
        .into_iter()
        .map(|theme| theme.id)
        .collect::<Vec<_>>();

    let entries =
        body.get("extensions").and_then(serde_json::Value::as_array).cloned().unwrap_or_default();
    let mut checks = tokio::task::JoinSet::new();
    for (rank, entry) in entries.into_iter().take(SEARCH_CANDIDATES).enumerate() {
        let namespace = text_field(&entry, "namespace");
        let name = text_field(&entry, "name");
        if namespace.is_empty() || name.is_empty() {
            continue;
        }
        let client = client.clone();
        let installed = installed.clone();
        checks.spawn(async move {
            if !contributes_an_icon_theme(&client, &namespace, &name).await {
                return None;
            }
            let id = format!("{namespace}.{name}");
            let display_name = text_field(&entry, "displayName");
            let license = text_field(&entry, "license");
            Some((
                rank,
                OpenVsxIconTheme {
                    installed: installed.contains(&id),
                    id,
                    namespace,
                    name: name.clone(),
                    display_name: if display_name.is_empty() { name } else { display_name },
                    version: text_field(&entry, "version"),
                    description: text_field(&entry, "description"),
                    license: if license.is_empty() { "Unspecified".to_string() } else { license },
                    downloads: entry
                        .get("downloadCount")
                        .and_then(serde_json::Value::as_u64)
                        .unwrap_or(0),
                    icon: entry
                        .get("files")
                        .and_then(|files| files.get("icon"))
                        .and_then(serde_json::Value::as_str)
                        .map(str::to_string),
                },
            ))
        });
    }

    let mut ranked = Vec::new();
    while let Some(result) = checks.join_next().await {
        // A panicked check drops its row; it must not fail the search.
        if let Ok(Some(hit)) = result {
            ranked.push(hit);
        }
    }
    // The concurrent checks finish out of order, so relevance is restored from
    // the position Open VSX gave each hit.
    ranked.sort_by_key(|(rank, _)| *rank);
    Ok(ranked.into_iter().map(|(_, theme)| theme).collect())
}

/// `true` when the extension's own `package.json` declares an icon theme.
///
/// Anything that goes wrong answers `false`: one unreachable entry should drop
/// a row from the results, not fail the whole search.
async fn contributes_an_icon_theme(client: &reqwest::Client, namespace: &str, name: &str) -> bool {
    let url = format!("{OPEN_VSX_API}/{namespace}/{name}/latest/file/package.json");
    let Ok(response) = client.get(&url).send().await else { return false };
    let Ok(body) = response.json::<serde_json::Value>().await else { return false };
    body.get("contributes")
        .and_then(|contributes| contributes.get("iconThemes"))
        .and_then(serde_json::Value::as_array)
        .is_some_and(|themes| !themes.is_empty())
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallIconThemeArgs {
    pub namespace: String,
    pub name: String,
    /// Omitted installs the latest published version.
    #[serde(default)]
    pub version: Option<String>,
}

/// Download a `.vsix` from Open VSX and unpack it as an installed icon theme.
#[tauri::command]
pub async fn install_icon_theme(
    app: AppHandle,
    args: InstallIconThemeArgs,
) -> Result<IconThemeSummary, String> {
    let id = format!("{}.{}", args.namespace, args.name);
    if !atlas_icon_theme::is_valid_id(&id) {
        return Err(format!("\"{id}\" is not a usable extension id."));
    }
    if atlas_icon_theme::is_built_in(&id) {
        return Err(format!("\"{id}\" is built in and cannot be replaced."));
    }

    let metadata_client = http_client(METADATA_TIMEOUT)?;
    let metadata_url = match &args.version {
        Some(version) => format!("{OPEN_VSX_API}/{}/{}/{version}", args.namespace, args.name),
        None => format!("{OPEN_VSX_API}/{}/{}", args.namespace, args.name),
    };
    let metadata: serde_json::Value = metadata_client
        .get(&metadata_url)
        .send()
        .await
        .map_err(|error| network_error("Looking up the extension", &error))?
        .json()
        .await
        .map_err(|error| format!("Open VSX sent metadata Atlas could not read: {error}"))?;
    let download = metadata
        .get("files")
        .and_then(|files| files.get("download"))
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| format!("Open VSX has no downloadable .vsix for \"{id}\"."))?
        .to_string();

    let bytes = http_client(DOWNLOAD_TIMEOUT)?
        .get(&download)
        .send()
        .await
        .map_err(|error| network_error("The download", &error))?
        .bytes()
        .await
        .map_err(|error| network_error("The download", &error))?;
    if bytes.len() > MAX_VSIX_BYTES {
        return Err(format!(
            "\"{id}\" is {} MB, past the {} MB Atlas accepts for an icon theme.",
            bytes.len() / (1024 * 1024),
            MAX_VSIX_BYTES / (1024 * 1024),
        ));
    }

    // Unzipping and writing a thousand small files is the blocking half.
    let summary = tokio::task::spawn_blocking(move || {
        atlas_icon_theme::install_vsix(&id, &bytes).map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| format!("icon theme install task failed: {error}"))??;
    notify(&app);
    Ok(summary)
}

#[tauri::command]
pub async fn remove_icon_theme(app: AppHandle, id: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        atlas_icon_theme::remove(&id).map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| format!("icon theme removal task failed: {error}"))??;
    notify(&app);
    Ok(())
}

/// Percent-encode a query string. `github.rs` keeps its own copy of this for
/// the same reason: one helper, four lines, no dependency.
fn urlencoding(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char)
            }
            b' ' => out.push('+'),
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn query_strings_are_encoded() {
        assert_eq!(urlencoding("material icon"), "material+icon");
        assert_eq!(urlencoding("a/b?c=d"), "a%2Fb%3Fc%3Dd");
        assert_eq!(urlencoding("héllo"), "h%C3%A9llo");
    }
}
