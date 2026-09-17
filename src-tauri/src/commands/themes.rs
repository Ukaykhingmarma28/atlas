use std::sync::Mutex;

use atlas_theme::{Theme, ThemeSummary};
use notify::RecommendedWatcher;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

pub const THEMES_CHANGED_EVENT: &str = "atlas:themes-changed";

pub struct ThemeWatcherState(Mutex<Option<RecommendedWatcher>>);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ThemesChangedEvent {
    kind: &'static str,
}

#[tauri::command]
pub async fn list_themes() -> Result<Vec<ThemeSummary>, String> {
    let catalog = tokio::task::spawn_blocking(atlas_theme::all_themes)
        .await
        .map_err(|error| format!("theme list task failed: {error}"))?
        .map_err(|error| error.to_string())?;
    // A file in `~/.config/atlas/themes/` that could not be loaded no longer
    // takes the catalog down with it, so the only trace left is this line —
    // which is what a theme author mid-edit goes looking for.
    for warning in &catalog.warnings {
        tracing::warn!(
            target: "atlas::themes",
            file = %warning.key,
            "skipped an unloadable user theme: {}",
            warning.message,
        );
    }
    Ok(catalog.themes.into_iter().map(|(theme, built_in)| theme.summary(built_in)).collect())
}

#[tauri::command]
pub async fn get_theme(id: String) -> Result<Theme, String> {
    tokio::task::spawn_blocking(move || atlas_theme::get_theme(&id))
        .await
        .map_err(|error| format!("theme load task failed: {error}"))?
        .map_err(|error| error.to_string())
}

pub fn start_watcher(app: &AppHandle) {
    let app_for_event = app.clone();
    let watcher = atlas_theme::watch_user_themes(move || {
        let _ = app_for_event.emit(
            THEMES_CHANGED_EVENT,
            ThemesChangedEvent { kind: "themes-changed" },
        );
    });
    match watcher {
        Ok(watcher) => {
            app.manage(ThemeWatcherState(Mutex::new(Some(watcher))));
        }
        Err(error) => {
            tracing::warn!(target: "atlas::themes", "failed to start theme watcher: {error}");
            app.manage(ThemeWatcherState(Mutex::new(None)));
        }
    }
}

impl Drop for ThemeWatcherState {
    fn drop(&mut self) {
        let _ = self.0.lock().map(|mut watcher| watcher.take());
    }
}
