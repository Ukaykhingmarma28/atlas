//! Picking one `iconDefinitions` id for one path.
//!
//! The rules, in the order they are tried (decision 4):
//!
//! 1. `fileNames` — a whole file name, optionally prefixed by parent folders
//! 2. `fileExtensions` — the longest matching extension first
//! 3. `languageIds` — the editor's own language id for the path
//! 4. `file` — the theme's generic fallback
//!
//! and, cutting across all four, **a parent-path-prefixed entry beats a bare
//! one**: `.config/graphqlrc` wins over `graphqlrc`, and `.github/workflows`
//! over `workflows`. Material ships 204 prefixed file names and 25 prefixed
//! folder names, so this is not a theoretical clause.
//!
//! Appearance sections are consulted *per step*, not per resolution. Running
//! the whole chain against `light` first and then against the base would let a
//! `light.fileExtensions` hit beat a base `fileNames` hit, which inverts the
//! documented precedence for any theme whose light section is partial — which
//! is every one of them (Material's light section overrides 179 file names and
//! nothing else).

use crate::format::{Associations, IconThemeDocument};

/// What is being drawn. Folders come in four states because the theme may give
/// each its own icon, and the explorer knows which one it is rendering.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum IconKind {
    File,
    Folder,
    FolderExpanded,
    RootFolder,
    RootFolderExpanded,
}

/// Which of the theme's three association sets applies.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Appearance {
    #[default]
    Dark,
    Light,
    HighContrast,
}

/// One thing to draw an icon for.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IconRequest {
    /// The path as the app knows it. Only the tail matters; an absolute path
    /// is fine and is what the explorer has.
    pub path: String,
    pub kind: IconKind,
    /// The editor's language id for this path, when it has one. Atlas reuses
    /// `src/features/editor/lib/languages.ts` rather than keeping a second
    /// table — see `docs/reference/icon-themes.md`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub language_id: Option<String>,
}

/// Every path suffix of `path`, longest first, lowercased and `/`-separated.
///
/// `src/components/App.tsx` yields `src/components/app.tsx`, then
/// `components/app.tsx`, then `app.tsx`. Trying them in that order is what
/// makes a prefixed association beat a bare one without a second pass.
fn suffixes(path: &str) -> Vec<String> {
    let normalised = path.replace('\\', "/").to_lowercase();
    let segments: Vec<&str> = normalised.split('/').filter(|segment| !segment.is_empty()).collect();
    // A deep absolute path would otherwise generate one candidate per ancestor
    // for every lookup, and no published theme prefixes more than two folders.
    // Four is slack over the observed maximum, not a guess at the format.
    const MAX_SEGMENTS: usize = 4;
    let start = segments.len().saturating_sub(MAX_SEGMENTS);
    (start..segments.len()).map(|from| segments[from..].join("/")).collect()
}

/// The extensions of `name`, longest first: `a.test.ts` -> `test.ts`, `ts`.
fn extensions(name: &str) -> Vec<String> {
    let lower = name.to_lowercase();
    let mut out = Vec::new();
    // Skip index 0 so a dotfile's whole name is never read as its extension:
    // `.gitignore` has no extension, it has a file name.
    let mut from = 1usize;
    while let Some(dot) = lower[from..].find('.') {
        from += dot + 1;
        if from < lower.len() {
            out.push(lower[from..].to_string());
        }
    }
    out
}

/// The sections to consult, in order, for `appearance`.
///
/// High contrast falls back to the base set rather than to `light`: VS Code
/// treats the two as siblings, and a high-contrast-dark theme borrowing light
/// icons would be worse than borrowing the defaults.
fn sections(document: &IconThemeDocument, appearance: Appearance) -> Vec<&Associations> {
    match appearance {
        Appearance::Dark => vec![&document.associations],
        Appearance::Light => {
            let mut out = Vec::new();
            out.extend(document.light.as_ref());
            out.push(&document.associations);
            out
        }
        Appearance::HighContrast => {
            let mut out = Vec::new();
            out.extend(document.high_contrast.as_ref());
            out.push(&document.associations);
            out
        }
    }
}

/// The first hit for `keys` across `sections`, keys in order and sections in
/// order within each key.
fn lookup<'a>(
    sections: &[&'a Associations],
    keys: &[String],
    pick: impl Fn(&'a Associations) -> &'a std::collections::BTreeMap<String, String>,
) -> Option<&'a str> {
    for key in keys {
        for section in sections {
            if let Some(id) = pick(section).get(key) {
                return Some(id.as_str());
            }
        }
    }
    None
}

fn first_some<'a>(
    sections: &[&'a Associations],
    pick: impl Fn(&'a Associations) -> Option<&'a str>,
) -> Option<&'a str> {
    sections.iter().find_map(|section| pick(section))
}

/// The `iconDefinitions` id for `request`, or `None` when the theme has
/// nothing to say — in which case the caller falls back to its own icon.
pub fn resolve<'a>(
    document: &'a IconThemeDocument,
    request: &IconRequest,
    appearance: Appearance,
) -> Option<&'a str> {
    let sections = sections(document, appearance);
    let path_suffixes = suffixes(&request.path);
    let name = path_suffixes.first().map(String::as_str).unwrap_or("");
    let name = name.rsplit('/').next().unwrap_or(name).to_string();

    match request.kind {
        IconKind::File => {
            if let Some(id) = lookup(&sections, &path_suffixes, |a| &a.file_names) {
                return Some(id);
            }
            // Extensions are never path-prefixed in any published theme, and
            // the schema does not describe them that way, so only the bare
            // extension is tried — longest first, so `.d.ts` beats `.ts`.
            let extension_keys = extensions(&name);
            if let Some(id) = lookup(&sections, &extension_keys, |a| &a.file_extensions) {
                return Some(id);
            }
            if let Some(language) = request.language_id.as_deref() {
                let keys = vec![language.to_lowercase()];
                if let Some(id) = lookup(&sections, &keys, |a| &a.language_ids) {
                    return Some(id);
                }
            }
            first_some(&sections, |a| a.file.as_deref())
        }
        IconKind::Folder | IconKind::FolderExpanded => {
            let expanded = request.kind == IconKind::FolderExpanded;
            let names = if expanded {
                lookup(&sections, &path_suffixes, |a| &a.folder_names_expanded)
                    // A theme may name only the collapsed form and expect the
                    // same icon when open; falling through keeps that working
                    // instead of dropping to the generic folder.
                    .or_else(|| lookup(&sections, &path_suffixes, |a| &a.folder_names))
            } else {
                lookup(&sections, &path_suffixes, |a| &a.folder_names)
            };
            if let Some(id) = names {
                return Some(id);
            }
            if expanded {
                if let Some(id) = first_some(&sections, |a| a.folder_expanded.as_deref()) {
                    return Some(id);
                }
            }
            first_some(&sections, |a| a.folder.as_deref())
        }
        IconKind::RootFolder | IconKind::RootFolderExpanded => {
            let expanded = request.kind == IconKind::RootFolderExpanded;
            let names = if expanded {
                lookup(&sections, &path_suffixes, |a| &a.root_folder_names_expanded)
                    .or_else(|| lookup(&sections, &path_suffixes, |a| &a.root_folder_names))
            } else {
                lookup(&sections, &path_suffixes, |a| &a.root_folder_names)
            };
            if let Some(id) = names {
                return Some(id);
            }
            if expanded {
                if let Some(id) = first_some(&sections, |a| a.root_folder_expanded.as_deref()) {
                    return Some(id);
                }
            }
            if let Some(id) = first_some(&sections, |a| a.root_folder.as_deref()) {
                return Some(id);
            }
            // A theme with no root-folder opinion draws the root like any
            // other folder, which is what VS Code does.
            resolve(
                document,
                &IconRequest {
                    path: request.path.clone(),
                    kind: if expanded { IconKind::FolderExpanded } else { IconKind::Folder },
                    language_id: None,
                },
                appearance,
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn document() -> IconThemeDocument {
        IconThemeDocument::parse(
            r#"{
              "iconDefinitions": {
                "file": { "iconPath": "./file.svg" },
                "ts": { "iconPath": "./ts.svg" },
                "dts": { "iconPath": "./dts.svg" },
                "tsconfig": { "iconPath": "./tsconfig.svg" },
                "graphql": { "iconPath": "./graphql.svg" },
                "graphql-config": { "iconPath": "./graphql-config.svg" },
                "rust": { "iconPath": "./rust.svg" },
                "folder": { "iconPath": "./folder.svg" },
                "folder-open": { "iconPath": "./folder-open.svg" },
                "src": { "iconPath": "./src.svg" },
                "src-open": { "iconPath": "./src-open.svg" },
                "workflows": { "iconPath": "./workflows.svg" },
                "root": { "iconPath": "./root.svg" },
                "file-light": { "iconPath": "./file-light.svg" },
                "ts-light": { "iconPath": "./ts-light.svg" },
                "ts-hc": { "iconPath": "./ts-hc.svg" }
              },
              "file": "file",
              "folder": "folder",
              "folderExpanded": "folder-open",
              "rootFolder": "root",
              "fileExtensions": { "ts": "ts", "d.ts": "dts" },
              "fileNames": { "tsconfig.json": "tsconfig", "graphqlrc": "graphql",
                             ".config/graphqlrc": "graphql-config" },
              "languageIds": { "rust": "rust" },
              "folderNames": { "src": "src", ".github/workflows": "workflows" },
              "folderNamesExpanded": { "src": "src-open" },
              "light": { "file": "file-light", "fileExtensions": { "ts": "ts-light" } },
              "highContrast": { "fileExtensions": { "ts": "ts-hc" } }
            }"#,
            "test",
        )
        .expect("the fixture parses")
    }

    fn pick(path: &str, kind: IconKind) -> Option<String> {
        resolve(
            &document(),
            &IconRequest { path: path.into(), kind, language_id: None },
            Appearance::Dark,
        )
        .map(str::to_string)
    }

    #[test]
    fn file_names_beat_file_extensions() {
        assert_eq!(pick("a/tsconfig.json", IconKind::File).as_deref(), Some("tsconfig"));
    }

    #[test]
    fn file_extensions_beat_language_ids() {
        let request = IconRequest {
            path: "a/main.ts".into(),
            kind: IconKind::File,
            language_id: Some("rust".into()),
        };
        assert_eq!(resolve(&document(), &request, Appearance::Dark), Some("ts"));
    }

    #[test]
    fn language_ids_are_used_when_nothing_else_matches() {
        let request = IconRequest {
            path: "a/main.unknownext".into(),
            kind: IconKind::File,
            language_id: Some("Rust".into()),
        };
        assert_eq!(
            resolve(&document(), &request, Appearance::Dark),
            Some("rust"),
            "the language id is matched case-insensitively"
        );
    }

    #[test]
    fn falls_back_to_the_generic_file_icon() {
        assert_eq!(pick("a/whatever.qqq", IconKind::File).as_deref(), Some("file"));
    }

    #[test]
    fn a_parent_prefixed_file_name_beats_a_bare_one() {
        assert_eq!(pick("x/graphqlrc", IconKind::File).as_deref(), Some("graphql"));
        assert_eq!(
            pick("x/.config/graphqlrc", IconKind::File).as_deref(),
            Some("graphql-config"),
            "the prefixed entry wins even though the bare one also matches"
        );
    }

    #[test]
    fn a_parent_prefixed_folder_name_beats_a_bare_one() {
        assert_eq!(pick("repo/.github/workflows", IconKind::Folder).as_deref(), Some("workflows"));
    }

    #[test]
    fn the_longest_extension_wins() {
        assert_eq!(pick("a/types.d.ts", IconKind::File).as_deref(), Some("dts"));
        assert_eq!(pick("a/types.ts", IconKind::File).as_deref(), Some("ts"));
    }

    #[test]
    fn extension_matching_ignores_case() {
        assert_eq!(pick("a/Main.TS", IconKind::File).as_deref(), Some("ts"));
    }

    #[test]
    fn a_dotfile_name_is_not_read_as_an_extension() {
        // `.ts` as a whole file name must not pick up the `ts` extension icon.
        assert_eq!(pick("a/.ts", IconKind::File).as_deref(), Some("file"));
    }

    #[test]
    fn folders_use_their_expanded_association_when_open() {
        assert_eq!(pick("p/src", IconKind::Folder).as_deref(), Some("src"));
        assert_eq!(pick("p/src", IconKind::FolderExpanded).as_deref(), Some("src-open"));
    }

    #[test]
    fn an_expanded_folder_falls_back_to_the_collapsed_association() {
        assert_eq!(
            pick("repo/.github/workflows", IconKind::FolderExpanded).as_deref(),
            Some("workflows"),
            "the theme names no expanded form for this folder"
        );
    }

    #[test]
    fn generic_folders_use_the_open_icon_when_expanded() {
        assert_eq!(pick("p/plain", IconKind::Folder).as_deref(), Some("folder"));
        assert_eq!(pick("p/plain", IconKind::FolderExpanded).as_deref(), Some("folder-open"));
    }

    #[test]
    fn a_root_folder_uses_its_own_icon() {
        assert_eq!(pick("/home/me/project", IconKind::RootFolder).as_deref(), Some("root"));
    }

    #[test]
    fn the_light_section_overrides_only_what_it_sets() {
        let doc = document();
        let file = IconRequest { path: "a/x.qqq".into(), kind: IconKind::File, language_id: None };
        let typescript =
            IconRequest { path: "a/x.ts".into(), kind: IconKind::File, language_id: None };
        let folder =
            IconRequest { path: "a/src".into(), kind: IconKind::Folder, language_id: None };
        assert_eq!(resolve(&doc, &file, Appearance::Light), Some("file-light"));
        assert_eq!(resolve(&doc, &typescript, Appearance::Light), Some("ts-light"));
        assert_eq!(
            resolve(&doc, &folder, Appearance::Light),
            Some("src"),
            "the light section sets no folder names, so the base ones stand"
        );
    }

    #[test]
    fn a_light_extension_does_not_outrank_a_base_file_name() {
        // The failure this pins: running the whole chain against `light` first
        // would answer `ts-light` for a file the base section names outright.
        let doc = document();
        let request =
            IconRequest { path: "a/tsconfig.json".into(), kind: IconKind::File, language_id: None };
        assert_eq!(resolve(&doc, &request, Appearance::Light), Some("tsconfig"));
    }

    #[test]
    fn high_contrast_overrides_fall_back_to_the_base_and_not_to_light() {
        let doc = document();
        let typescript =
            IconRequest { path: "a/x.ts".into(), kind: IconKind::File, language_id: None };
        let other = IconRequest { path: "a/x.qqq".into(), kind: IconKind::File, language_id: None };
        assert_eq!(resolve(&doc, &typescript, Appearance::HighContrast), Some("ts-hc"));
        assert_eq!(
            resolve(&doc, &other, Appearance::HighContrast),
            Some("file"),
            "not `file-light`: high contrast is a sibling of light, not a child"
        );
    }

    #[test]
    fn a_theme_with_no_generic_file_icon_resolves_to_nothing() {
        let doc = IconThemeDocument::parse(
            r#"{ "iconDefinitions": { "ts": { "iconPath": "./ts.svg" } },
                 "fileExtensions": { "ts": "ts" } }"#,
            "test",
        )
        .expect("parses");
        let request =
            IconRequest { path: "a/x.qqq".into(), kind: IconKind::File, language_id: None };
        assert_eq!(resolve(&doc, &request, Appearance::Dark), None);
    }

    #[test]
    fn windows_separators_resolve_the_same_as_posix_ones() {
        assert_eq!(pick(r"repo\.github\workflows", IconKind::Folder).as_deref(), Some("workflows"));
    }
}
