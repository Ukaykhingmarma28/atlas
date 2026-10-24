//! Project scripts: named commands a project keeps (`bun dev`, `cargo test`),
//! run from the session context overlay in a terminal at the project root.
//!
//! They live in the project's own settings file, `<project>/.atlas/config.toml`,
//! as an array of `[[scripts]]` tables beside its `[settings]` overrides:
//!
//! ```toml
//! [[scripts]]
//! id = "dev"
//! name = "Dev server"
//! command = "bun run dev"
//! icon = "play"
//! ```
//!
//! Not a settings-registry key: a script list is per-project data, not an
//! override of a global value, and the registry has no shape for a list of
//! records. `state::project_config` reads only `[settings]` and leaves every
//! other table alone, so the two never step on each other; this module edits
//! only `scripts`, through `toml_edit`, so a hand-written comment elsewhere in
//! the file survives. Running a script is the frontend's: it is typed into a
//! terminal tab, where the user can watch and answer it.

use std::collections::HashSet;
use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::state::atlas_config::write_atomic;
use crate::state::project_config::{self, ProjectConfigs, PROJECT_CONFIG_HEADER};

/// The icons a script may carry; the overlay draws one glyph per id.
pub const SCRIPT_ICONS: [&str; 6] = ["play", "test", "lint", "configure", "build", "debug"];

/// More than anyone keeps by hand; a cap so a broken file cannot flood the menu.
const MAX_SCRIPTS: usize = 100;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectScript {
    /// Stable within the project; derived from the name when it is added.
    pub id: String,
    pub name: String,
    /// One shell line (or several), typed into the user's own shell.
    pub command: String,
    /// One of [`SCRIPT_ICONS`]; anything else reads as `play`.
    pub icon: String,
}

/// The project's scripts, in the order the file lists them. A missing file,
/// or one with no `[[scripts]]`, is an empty list; an unreadable entry is
/// skipped rather than failing the rest.
#[tauri::command]
pub async fn project_scripts_list(project_path: String) -> Result<Vec<ProjectScript>, String> {
    tokio::task::spawn_blocking(move || read_scripts(Path::new(&project_path)))
        .await
        .map_err(|e| e.to_string())?
}

/// Replace the project's scripts with `scripts`, and answer what was written
/// (trimmed, validated, ids made unique).
#[tauri::command]
pub async fn project_scripts_save(
    project_path: String,
    scripts: Vec<ProjectScript>,
    app: AppHandle,
) -> Result<Vec<ProjectScript>, String> {
    let root = project_path.clone();
    let saved = tokio::task::spawn_blocking(move || write_scripts(Path::new(&root), scripts))
        .await
        .map_err(|e| e.to_string())??;
    // The settings overlay caches the file by its mtime; the write moved it.
    if let Some(configs) = app.try_state::<ProjectConfigs>() {
        configs.invalidate(Path::new(&project_path));
    }
    Ok(saved)
}

pub fn read_scripts(project_root: &Path) -> Result<Vec<ProjectScript>, String> {
    let path = project_config::project_config_path(project_root);
    let raw = match fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("could not read {}: {e}", path.display())),
    };
    let table: toml::Table = raw
        .parse()
        .map_err(|e| format!("{} is not valid TOML: {e}", path.display()))?;
    let Some(entries) = table.get("scripts").and_then(toml::Value::as_array) else {
        return Ok(Vec::new());
    };
    let scripts = entries
        .iter()
        .filter_map(|entry| {
            let entry = entry.as_table()?;
            let text = |key: &str| {
                entry
                    .get(key)
                    .and_then(toml::Value::as_str)
                    .map(str::to_string)
            };
            Some(ProjectScript {
                id: text("id").unwrap_or_default(),
                name: text("name")?,
                command: text("command")?,
                icon: text("icon").unwrap_or_else(|| "play".into()),
            })
        })
        .collect();
    normalize(scripts)
}

pub fn write_scripts(
    project_root: &Path,
    scripts: Vec<ProjectScript>,
) -> Result<Vec<ProjectScript>, String> {
    let scripts = normalize(scripts)?;
    let path = project_config::project_config_path(project_root);
    let raw = match fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => PROJECT_CONFIG_HEADER.to_string(),
        Err(e) => return Err(format!("could not read {}: {e}", path.display())),
    };
    let mut document: toml_edit::DocumentMut = raw
        .parse()
        .map_err(|e| format!("{} is not valid TOML: {e}", path.display()))?;
    if scripts.is_empty() {
        document.remove("scripts");
    } else {
        let mut array = toml_edit::ArrayOfTables::new();
        for script in &scripts {
            let mut table = toml_edit::Table::new();
            table["id"] = toml_edit::value(script.id.as_str());
            table["name"] = toml_edit::value(script.name.as_str());
            table["command"] = toml_edit::value(script.command.as_str());
            table["icon"] = toml_edit::value(script.icon.as_str());
            array.push(table);
        }
        document["scripts"] = toml_edit::Item::ArrayOfTables(array);
    }
    write_atomic(&path, &document.to_string())
        .map_err(|e| format!("could not write {}: {e}", path.display()))?;
    Ok(scripts)
}

/// Trim, validate and de-duplicate. A blank name or command is refused (the
/// editor says so before it gets here); an unknown icon becomes `play`; a
/// blank or repeated id is derived again from the name.
fn normalize(scripts: Vec<ProjectScript>) -> Result<Vec<ProjectScript>, String> {
    if scripts.len() > MAX_SCRIPTS {
        return Err(format!("a project keeps at most {MAX_SCRIPTS} scripts"));
    }
    let mut taken: HashSet<String> = HashSet::new();
    let mut out = Vec::with_capacity(scripts.len());
    for script in scripts {
        let name = script.name.trim().to_string();
        let command = script.command.trim().to_string();
        if name.is_empty() {
            return Err("a script needs a name".into());
        }
        if command.is_empty() {
            return Err(format!("{name} needs a command"));
        }
        let icon = if SCRIPT_ICONS.contains(&script.icon.as_str()) {
            script.icon
        } else {
            "play".into()
        };
        let wanted = slug(if script.id.trim().is_empty() {
            &name
        } else {
            &script.id
        });
        let id = unique_id(&wanted, &taken);
        taken.insert(id.clone());
        out.push(ProjectScript {
            id,
            name,
            command,
            icon,
        });
    }
    Ok(out)
}

/// Lowercase ASCII words joined by `-`; `script` when nothing is left.
pub fn slug(value: &str) -> String {
    let mut out = String::new();
    for c in value.trim().chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
        } else if !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
    }
    let out = out
        .trim_end_matches('-')
        .chars()
        .take(64)
        .collect::<String>();
    let out = out.trim_end_matches('-').to_string();
    if out.is_empty() {
        "script".into()
    } else {
        out
    }
}

fn unique_id(wanted: &str, taken: &HashSet<String>) -> String {
    if !taken.contains(wanted) {
        return wanted.to_string();
    }
    (2..)
        .map(|n| format!("{wanted}-{n}"))
        .find(|candidate| !taken.contains(candidate))
        .unwrap_or_else(|| wanted.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn script(id: &str, name: &str, command: &str, icon: &str) -> ProjectScript {
        ProjectScript {
            id: id.into(),
            name: name.into(),
            command: command.into(),
            icon: icon.into(),
        }
    }

    #[test]
    fn scripts_round_trip_beside_settings_and_comments() {
        let dir = tempfile::tempdir().unwrap();
        let path = project_config::project_config_path(dir.path());
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(
            &path,
            "# mine\nschemaVersion = 1\n\n[settings]\nshowHiddenFiles = true\n",
        )
        .unwrap();

        let saved = write_scripts(
            dir.path(),
            vec![
                script("", "Dev server", " bun run dev ", "play"),
                script("", "Dev server", "bun run dev -- --host", "nonsense"),
            ],
        )
        .unwrap();
        assert_eq!(saved[0].id, "dev-server");
        assert_eq!(saved[0].command, "bun run dev");
        assert_eq!(saved[1].id, "dev-server-2");
        assert_eq!(saved[1].icon, "play");

        let text = fs::read_to_string(&path).unwrap();
        assert!(text.contains("# mine"));
        assert!(text.contains("showHiddenFiles = true"));
        assert_eq!(read_scripts(dir.path()).unwrap(), saved);

        write_scripts(dir.path(), Vec::new()).unwrap();
        assert!(read_scripts(dir.path()).unwrap().is_empty());
        assert!(fs::read_to_string(&path)
            .unwrap()
            .contains("showHiddenFiles"));
    }

    #[test]
    fn a_project_with_no_file_has_no_scripts_and_gets_the_header_on_write() {
        let dir = tempfile::tempdir().unwrap();
        assert!(read_scripts(dir.path()).unwrap().is_empty());
        write_scripts(
            dir.path(),
            vec![script("test", "Test", "cargo test", "test")],
        )
        .unwrap();
        let text = fs::read_to_string(project_config::project_config_path(dir.path())).unwrap();
        assert!(text.starts_with("# Atlas settings for this project."));
        assert!(text.contains("[[scripts]]"));
    }

    #[test]
    fn a_blank_name_or_command_is_refused() {
        assert!(normalize(vec![script("", " ", "x", "play")]).is_err());
        assert!(normalize(vec![script("", "x", "  ", "play")]).is_err());
    }

    #[test]
    fn slugs_are_plain_and_never_empty() {
        assert_eq!(slug("  Run E2E: Chrome!  "), "run-e2e-chrome");
        assert_eq!(slug("--"), "script");
    }
}
