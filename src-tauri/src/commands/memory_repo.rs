//! Shared memory as an Agent Memory Repo (memory plan M4): a read-only mirror
//! other tools can read, and an import that brings someone's memory repo in
//! as candidates.
//!
//! - **The mirror is a projection.** Active, non-stale memories only, in the
//!   spec's layout (`MEMORY.md` plus topic files, one bullet per memory with
//!   `[source: ...; added: ...]`), in a local git repository under
//!   `~/.atlas/memory-repos/`, never inside the project. No remote, no push.
//!   Atlas never reads it back as truth. It names sessions
//!   (`atlas-session:<agent>/<session>`) but carries no recorder text: no
//!   session title, no commit sha.
//! - **A purge rebuilds it with fresh history**, so a purged secret does not
//!   survive in old git objects.
//! - **An import lands as candidates** (`import:amr`), never briefed until an
//!   agent or the user confirms them. Only files inside the chosen folder
//!   are read.

use std::path::{Path, PathBuf};

use atlas_git::GitCommand;
use atlas_memory::amr::{self, AmrEntry};
use atlas_memory::citation::{validate, FileResolver, Validity};
use atlas_memory::record::{self, Entry, EntryKind, RecordStore};
use serde::Serialize;
use sha2::{Digest, Sha256};

use super::shared_memory::SharedMemoryStore;

/// The files the mirror writes, index first.
pub const MIRROR_FILES: [&str; 5] = [
    "MEMORY.md",
    "decisions.md",
    "architecture.md",
    "facts.md",
    "failures.md",
];
/// The source an imported line is recorded under.
pub const IMPORT_SOURCE: &str = "import:amr";
/// An import reads at most this much.
const IMPORT_MAX_BYTES: u64 = 2 * 1024 * 1024;

/// Where every mirror lives: `~/.atlas/memory-repos`.
pub fn mirror_root(home: &Path) -> PathBuf {
    atlas_profile::dir_in(home).join("memory-repos")
}

/// The mirror of the scope at `scope_root`: `<repo name>-<8 hex>` under
/// [`mirror_root`], the hex from the canonical scope root.
pub fn mirror_dir(home: &Path, scope_root: &Path) -> PathBuf {
    let canonical = dunce::canonicalize(scope_root).unwrap_or_else(|_| scope_root.to_path_buf());
    let name = canonical
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| "repo".to_string());
    let digest = Sha256::digest(canonical.to_string_lossy().as_bytes());
    let hex: String = digest.iter().take(4).map(|b| format!("{b:02x}")).collect();
    mirror_root(home).join(format!("{name}-{hex}"))
}

/// The topic file of a kind; preferences go at the top of `MEMORY.md`.
fn topic(kind: EntryKind) -> Option<(&'static str, &'static str, &'static str)> {
    match kind {
        EntryKind::Decision => Some(("decisions.md", "Decisions", "Decisions and why")),
        EntryKind::Architecture => Some((
            "architecture.md",
            "Architecture",
            "How the system fits together",
        )),
        EntryKind::Fact => Some(("facts.md", "Facts", "Project facts and conventions")),
        EntryKind::Failure => Some((
            "failures.md",
            "Known dead ends",
            "What was tried and failed",
        )),
        _ => None,
    }
}

/// The mirror's files for the memory in `store`, as `(file, text)`.
pub fn render_mirror(store: &RecordStore) -> Result<Vec<(&'static str, String)>, String> {
    let e = |e: anyhow::Error| format!("{e:#}");
    let files = FileResolver::new(store.root());
    let mut entries: Vec<(Entry, Vec<atlas_memory::citation::Citation>)> = Vec::new();
    for entry in store.durable_active().map_err(e)? {
        let checked: Vec<(Validity, atlas_memory::citation::Citation)> = entry
            .citations()
            .iter()
            .map(|c| validate(c, &files))
            .collect();
        if checked.iter().any(|(v, _)| *v == Validity::Stale) {
            continue;
        }
        entries.push((entry, checked.into_iter().map(|(_, c)| c).collect()));
    }
    let ids: Vec<i64> = entries.iter().map(|(e, _)| e.id).collect();
    let sources = store.sources_for(&ids).map_err(e)?;
    let line = |entry: &Entry, cites: &[atlas_memory::citation::Citation]| {
        let mut meta: Vec<(String, String)> = sources
            .get(&entry.id)
            .map(|s| {
                s.iter()
                    .map(|s| ("source".to_string(), record::source_uri(s)))
                    .collect()
            })
            .unwrap_or_default();
        if let Some(added) = chrono::DateTime::from_timestamp_millis(entry.created_at) {
            meta.push(("added".into(), added.format("%Y-%m-%d").to_string()));
        }
        meta.push(("atlas-id".into(), entry.id.to_string()));
        meta.push(("revision".into(), entry.rev.to_string()));
        for c in cites {
            meta.push((
                "code".into(),
                format!("{}#L{}-{}", c.path, c.start_line, c.end_line),
            ));
        }
        amr::render_line(&AmrEntry {
            text: entry.content.clone(),
            meta,
        })
    };
    let name = store
        .root()
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "repo".to_string());
    let mut index = format!(
        "# Memory: {name}\n\nA read-only mirror of Atlas's shared memory for this repository.\n"
    );
    let preferences: Vec<String> = entries
        .iter()
        .filter(|(e, _)| e.kind == EntryKind::Preference)
        .map(|(e, c)| line(e, c))
        .collect();
    if !preferences.is_empty() {
        index.push_str("\n## Preferences\n\n");
        for p in preferences {
            index.push_str(&p);
            index.push('\n');
        }
    }
    let mut out: Vec<(&'static str, String)> = Vec::new();
    let mut index_lines = Vec::new();
    for kind in [
        EntryKind::Decision,
        EntryKind::Architecture,
        EntryKind::Fact,
        EntryKind::Failure,
    ] {
        let Some((file, title, blurb)) = topic(kind) else {
            continue;
        };
        let lines: Vec<String> = entries
            .iter()
            .filter(|(e, _)| e.kind == kind)
            .map(|(e, c)| line(e, c))
            .collect();
        if !lines.is_empty() {
            let stem = file.trim_end_matches(".md");
            index_lines.push(format!("- [[{stem}]] {blurb} ({})", lines.len()));
        }
        let mut text = format!("# {title}\n\n");
        for l in lines {
            text.push_str(&l);
            text.push('\n');
        }
        out.push((file, text));
    }
    index.push_str("\n## Index\n\n");
    for l in index_lines {
        index.push_str(&l);
        index.push('\n');
    }
    out.insert(0, ("MEMORY.md", index));
    Ok(out)
}

fn git(dir: &Path, args: &[&str]) -> Result<atlas_git::GitOutput, String> {
    GitCommand::new(dir, args).run().map_err(|e| e.to_string())
}

/// The identity mirror commits are made under: the scope repository's own
/// `user.name` / `user.email`, else Atlas's.
fn identity(scope_root: &Path) -> (String, String) {
    let read = |key: &str| {
        GitCommand::new(scope_root, &["config", "--get", key])
            .read_only()
            .success_codes(&[0, 1])
            .run()
            .ok()
            .map(|o| o.stdout.trim().to_string())
            .filter(|s| !s.is_empty())
    };
    (
        read("user.name").unwrap_or_else(|| "Atlas memory".to_string()),
        read("user.email").unwrap_or_else(|| "memory@atlas.local".to_string()),
    )
}

/// Write the mirror of `store` and commit what changed. Returns whether a
/// commit was made.
pub fn refresh_mirror(home: &Path, store: &RecordStore) -> Result<bool, String> {
    let dir = mirror_dir(home, store.root());
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    if !dir.join(".git").exists() {
        git(&dir, &["init", "-q"])?;
    }
    for (file, text) in render_mirror(store)? {
        let path = dir.join(file);
        if std::fs::read_to_string(&path).ok().as_deref() == Some(text.as_str()) {
            continue;
        }
        let tmp = dir.join(format!(".{file}.tmp"));
        std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    }
    let mut add = vec!["add", "--"];
    add.extend(MIRROR_FILES);
    git(&dir, &add)?;
    let staged = GitCommand::new(&dir, &["diff", "--cached", "--quiet"])
        .success_codes(&[0, 1])
        .run()
        .map_err(|e| e.to_string())?;
    if staged.exit_code == 0 {
        return Ok(false);
    }
    let (name, email) = identity(store.root());
    let (name, email) = (format!("user.name={name}"), format!("user.email={email}"));
    git(
        &dir,
        &[
            "-c",
            &name,
            "-c",
            &email,
            "-c",
            "commit.gpgsign=false",
            "commit",
            "-q",
            "--no-verify",
            "-m",
            "Update memory",
        ],
    )?;
    Ok(true)
}

/// Rewrite the mirror with fresh history (after a purge): its `.git` is
/// deleted, the files rewritten and one new commit made.
pub fn rebuild_mirror(home: &Path, store: &RecordStore) -> Result<bool, String> {
    let dir = mirror_dir(home, store.root());
    let git_dir = dir.join(".git");
    if git_dir.exists() {
        std::fs::remove_dir_all(&git_dir).map_err(|e| e.to_string())?;
    }
    refresh_mirror(home, store)
}

// ── Import ───────────────────────────────────────────────────────────────────

/// One line an import would write.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoImportLine {
    /// Stable id of this line (kind + content); what confirm takes.
    pub id: String,
    pub kind: EntryKind,
    pub content: String,
    /// The file it came from, relative to the folder.
    pub file: String,
    /// `false` when memory already holds it: confirm skips it.
    pub is_new: bool,
}

/// The kind of a line from `file`: Atlas's own topic names, `preferences.md`
/// and the top of `MEMORY.md` as preferences, anything else a fact.
fn kind_of(file: &str) -> EntryKind {
    let stem = Path::new(file)
        .file_stem()
        .map(|s| s.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    match stem.as_str() {
        "decisions" | "decision" => EntryKind::Decision,
        "architecture" => EntryKind::Architecture,
        "failures" | "failure" => EntryKind::Failure,
        "preferences" | "preference" | "memory" => EntryKind::Preference,
        _ => EntryKind::Fact,
    }
}

/// Every bullet in the memory repo at `dir`: `MEMORY.md` and each file a
/// `[[link]]` reaches, inside `dir` only (no `..`, no symlink out), at most
/// [`IMPORT_MAX_BYTES`] in all. Index lines (those with links) are not
/// memories.
fn read_repo(dir: &Path) -> Result<Vec<(String, AmrEntry)>, String> {
    let root =
        dunce::canonicalize(dir).map_err(|_| format!("`{}` is not a folder", dir.display()))?;
    let mut queue = vec!["MEMORY.md".to_string()];
    let mut seen: Vec<String> = Vec::new();
    let mut out = Vec::new();
    let mut total = 0u64;
    while let Some(rel) = queue.pop() {
        if seen.contains(&rel) {
            continue;
        }
        seen.push(rel.clone());
        let Some(safe) = atlas_memory::citation::safe_rel(&rel) else {
            continue;
        };
        let Ok(path) = dunce::canonicalize(root.join(safe)) else {
            continue;
        };
        if !path.starts_with(&root) || !path.is_file() {
            continue;
        }
        let Ok(meta) = std::fs::metadata(&path) else {
            continue;
        };
        total += meta.len();
        if total > IMPORT_MAX_BYTES {
            break;
        }
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        for line in text.lines() {
            let targets = amr::links(line);
            if !targets.is_empty() {
                queue.extend(targets);
                continue;
            }
            if let Some(entry) = amr::parse_line(line) {
                if !entry.text.trim().is_empty() {
                    out.push((rel.clone(), entry));
                }
            }
        }
    }
    Ok(out)
}

fn line_id(kind: EntryKind, content: &str) -> String {
    let digest = Sha256::digest(format!("{}\n{content}", kind.as_str()).as_bytes());
    digest.iter().take(6).map(|b| format!("{b:02x}")).collect()
}

/// What importing the memory repo at `dir` would write. Writes nothing.
pub fn import_preview(
    memory: &SharedMemoryStore,
    project_path: &str,
    dir: &Path,
) -> Result<Vec<RepoImportLine>, String> {
    let mut lines: Vec<RepoImportLine> = Vec::new();
    for (file, entry) in read_repo(dir)? {
        let kind = kind_of(&file);
        let content = record::redact(&record::clean(entry.text.trim()));
        let id = line_id(kind, &content);
        if lines.iter().any(|l| l.id == id) {
            continue;
        }
        let is_new = !memory
            .list_entries(project_path, Some(kind))
            .iter()
            .any(|e| e.content == content);
        lines.push(RepoImportLine {
            id,
            kind,
            content,
            file,
            is_new,
        });
    }
    Ok(lines)
}

/// Import the previewed lines in `ids` as candidates. Returns how many were
/// written.
pub fn import_confirm(
    memory: &SharedMemoryStore,
    project_path: &str,
    dir: &Path,
    ids: &[String],
) -> Result<usize, String> {
    let mut written = 0;
    for line in import_preview(memory, project_path, dir)? {
        if !line.is_new || !ids.contains(&line.id) {
            continue;
        }
        memory.record_import_candidate(project_path, line.kind, &line.content, IMPORT_SOURCE)?;
        written += 1;
    }
    Ok(written)
}

/// What importing the memory repo at `dir` would write.
#[tauri::command]
pub async fn memory_repo_import_preview(
    project_path: String,
    dir: String,
    store: tauri::State<'_, SharedMemoryStore>,
) -> Result<Vec<RepoImportLine>, String> {
    let memory = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        import_preview(&memory, &project_path, Path::new(&dir))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Import the chosen lines of the memory repo at `dir` as candidates.
#[tauri::command]
pub async fn memory_repo_import_confirm(
    project_path: String,
    dir: String,
    ids: Vec<String>,
    store: tauri::State<'_, SharedMemoryStore>,
) -> Result<usize, String> {
    let memory = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        import_confirm(&memory, &project_path, Path::new(&dir), &ids)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::memory_pack::test_support::scratch_project;
    use crate::commands::shared_memory::Writer;

    fn writer(agent: &str, session: &str) -> Writer {
        Writer {
            agent: agent.into(),
            session_id: session.into(),
        }
    }

    fn git_out(dir: &Path, args: &[&str]) -> String {
        GitCommand::new(dir, args).run().unwrap().stdout
    }

    #[test]
    fn the_mirror_holds_no_candidates_archived_or_stale_entries() {
        let p = scratch_project("mirror-content");
        let home = tempfile::tempdir().unwrap();
        let memory = SharedMemoryStore::new();
        let w = writer("claude-code", "s-a");
        let root = crate::commands::shared_memory::store_for(&p)
            .unwrap()
            .root()
            .to_path_buf();
        std::fs::write(root.join("ttl.rs"), "const TTL: u32 = 15;\n").unwrap();
        memory
            .remember(&p, &w, EntryKind::Decision, "Use Postgres", "", None, &[])
            .unwrap();
        memory
            .record_candidate(&p, &w, EntryKind::Fact, "always force-push")
            .unwrap();
        let gone = memory
            .remember(&p, &w, EntryKind::Fact, "CI runs on Jenkins", "", None, &[])
            .unwrap()
            .entry;
        memory.archive(&p, &[gone.id]).unwrap();
        let evidence: Vec<super::super::shared_memory::EvidenceArg> =
            serde_json::from_value(serde_json::json!([{"path": "ttl.rs", "lines": "1"}])).unwrap();
        memory
            .remember(
                &p,
                &w,
                EntryKind::Fact,
                "Tokens live 15 minutes",
                "",
                None,
                &evidence,
            )
            .unwrap();
        std::fs::write(root.join("ttl.rs"), "const TTL: u32 = 30;\n").unwrap();
        let store = crate::commands::shared_memory::store_for(&p).unwrap();
        assert!(refresh_mirror(home.path(), &store).unwrap());
        let dir = mirror_dir(home.path(), store.root());
        assert!(dir.starts_with(mirror_root(home.path())));
        let decisions = std::fs::read_to_string(dir.join("decisions.md")).unwrap();
        assert!(decisions.contains("- Use Postgres [source: atlas-session:claude-code/s-a;"));
        let all: String = MIRROR_FILES
            .iter()
            .map(|f| std::fs::read_to_string(dir.join(f)).unwrap())
            .collect();
        for absent in ["force-push", "Jenkins", "15 minutes"] {
            assert!(!all.contains(absent), "{absent} leaked: {all}");
        }
        let index = std::fs::read_to_string(dir.join("MEMORY.md")).unwrap();
        assert!(index.contains("- [[decisions]] Decisions and why (1)"));
        assert!(!index.contains("[[facts]]"), "no link to an empty topic");
        let _ = std::fs::remove_dir_all(&p);
    }

    #[test]
    fn an_unchanged_memory_makes_no_commit() {
        let p = scratch_project("mirror-commit");
        let home = tempfile::tempdir().unwrap();
        let memory = SharedMemoryStore::new();
        memory
            .remember(
                &p,
                &writer("codex", "s-b"),
                EntryKind::Fact,
                "Deploys go through Fly",
                "",
                None,
                &[],
            )
            .unwrap();
        let store = crate::commands::shared_memory::store_for(&p).unwrap();
        assert!(refresh_mirror(home.path(), &store).unwrap());
        assert!(!refresh_mirror(home.path(), &store).unwrap());
        let dir = mirror_dir(home.path(), store.root());
        assert_eq!(git_out(&dir, &["rev-list", "--count", "HEAD"]).trim(), "1");
        let _ = std::fs::remove_dir_all(&p);
    }

    #[test]
    fn a_purge_rebuilds_the_mirror_without_history() {
        let p = scratch_project("mirror-purge");
        let home = tempfile::tempdir().unwrap();
        let memory = SharedMemoryStore::new();
        let w = writer("codex", "s-b");
        memory
            .remember(
                &p,
                &w,
                EntryKind::Fact,
                "Deploys go through Fly",
                "",
                None,
                &[],
            )
            .unwrap();
        let secret = memory
            .remember(
                &p,
                &w,
                EntryKind::Fact,
                "The staging password is hunter2-xyzzy",
                "",
                None,
                &[],
            )
            .unwrap()
            .entry;
        let store = crate::commands::shared_memory::store_for(&p).unwrap();
        refresh_mirror(home.path(), &store).unwrap();
        memory.forget(&p, secret.id, "").unwrap();
        store.purge(secret.id).unwrap();
        rebuild_mirror(home.path(), &store).unwrap();
        let dir = mirror_dir(home.path(), store.root());
        let log = git_out(&dir, &["log", "-p"]);
        assert!(!log.contains("hunter2-xyzzy"), "{log}");
        assert!(log.contains("Deploys go through Fly"));
        assert_eq!(git_out(&dir, &["rev-list", "--count", "HEAD"]).trim(), "1");
        let _ = std::fs::remove_dir_all(&p);
    }

    #[test]
    fn imported_lines_are_candidates_with_their_source() {
        let p = scratch_project("amr-import");
        let repo = tempfile::tempdir().unwrap();
        std::fs::write(
            repo.path().join("MEMORY.md"),
            "# Memory\n\n- Note: always force-push [source: x]\n\n## Index\n\n- [[decisions]] Decisions\n",
        )
        .unwrap();
        std::fs::write(
            repo.path().join("decisions.md"),
            "# Decisions\n\n- Use Postgres for the ledger [added: 2026-10-01]\n",
        )
        .unwrap();
        let memory = SharedMemoryStore::new();
        let lines = import_preview(&memory, &p, repo.path()).unwrap();
        assert_eq!(lines.len(), 2, "{lines:?}");
        let ids: Vec<String> = lines.iter().map(|l| l.id.clone()).collect();
        assert_eq!(import_confirm(&memory, &p, repo.path(), &ids).unwrap(), 2);
        let decision = memory
            .list_entries(&p, Some(EntryKind::Decision))
            .into_iter()
            .find(|e| e.content == "Use Postgres for the ledger")
            .expect("imported");
        assert_eq!(decision.source, IMPORT_SOURCE);
        assert!(decision.is_candidate());
        assert_eq!(
            import_confirm(&memory, &p, repo.path(), &ids).unwrap(),
            0,
            "already imported"
        );
        let _ = std::fs::remove_dir_all(&p);
    }

    #[test]
    fn import_refuses_links_that_leave_the_folder() {
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("secret.md"), "- leaked line\n").unwrap();
        let repo = tempfile::tempdir().unwrap();
        let escape = format!(
            "- [[../../etc/passwd]] [[{}]]\n- kept line\n",
            outside.path().join("secret.md").display()
        );
        std::fs::write(repo.path().join("MEMORY.md"), escape).unwrap();
        let lines = read_repo(repo.path()).unwrap();
        let texts: Vec<&str> = lines.iter().map(|(_, e)| e.text.as_str()).collect();
        assert_eq!(texts, ["kept line"]);
    }
}
