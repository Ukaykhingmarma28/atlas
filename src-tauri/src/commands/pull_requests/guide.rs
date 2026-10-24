//! The Guide tab's git side: a read-only checkout of a pull request's head for
//! the agent that writes the guide, the change it is measured against, and the
//! written guide, kept per pull request and per head commit.
//!
//! The guide itself is written by an agent session the frontend runs in the
//! background (`pull-request-guide-run.ts`): Atlas has no model call of its own
//! that can read a checkout, and a guide written without reading the change is
//! refused rather than written blind. This module gives that session somewhere
//! to look and keeps what it wrote:
//!
//! - [`pr_guide_prepare`] fetches the base branch into a ref of the run's own,
//!   finds the head commit (local objects, the commit, the branch, then
//!   `refs/pull/<n>/head`), adds a detached worktree at it under Atlas's data
//!   directory, and reads the change (`<merge-base>...HEAD`): the changed
//!   files and each file's hunk ranges, which the frontend clamps the guide's
//!   excerpts to;
//! - [`pr_guide_finish`] removes the worktree and the base ref;
//! - [`pr_guide_read`] / [`pr_guide_write`] keep the latest guide for a pull
//!   request. The guide names the head commit it was written for, so the tab
//!   can tell a guide written before the latest push. The guide is stored as
//!   the frontend wrote it; its shape is checked there.
//!
//! Nothing here logs a repository, branch or path.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Manager};

use super::checkout::{git, run};
use super::model::PrError;

/// One file's changed line ranges, inclusive, on each side.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct PrGuideHunks {
    pub new: Vec<[u32; 2]>,
    pub old: Vec<[u32; 2]>,
}

/// The change a guide is written against.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct PrGuideChange {
    pub files: Vec<String>,
    pub hunks: BTreeMap<String, PrGuideHunks>,
}

/// A guide run's checkout.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrGuideCheckout {
    pub run_id: String,
    /// The detached worktree at the head commit.
    pub path: String,
    /// The merge base the change is measured from.
    pub base_commit: String,
    /// The head commit, in full.
    pub head_commit: String,
    pub change: PrGuideChange,
}

const COMMIT_HASH_LEN: std::ops::RangeInclusive<usize> = 7..=64;
static RUN_COUNTER: AtomicU64 = AtomicU64::new(0);

fn data_dir(app: &AppHandle) -> Result<PathBuf, PrError> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| PrError::failed(e.to_string()))?
        .join("pull-request-guides"))
}

/// The file a pull request's guide is kept in. Keyed by repository and number,
/// hashed so no name a host allows can escape the folder.
fn guide_file(dir: &Path, repository: &str, number: u64) -> PathBuf {
    let key = format!("{}#{number}", repository.trim().to_lowercase());
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in key.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    dir.join("stored").join(format!("{hash:016x}.json"))
}

/// The guide last written for this pull request, whichever head it was for.
#[tauri::command]
pub async fn pr_guide_read(
    app: AppHandle,
    repository: String,
    number: u64,
) -> Result<Option<Value>, PrError> {
    let number = super::pull_number(number)?;
    let file = guide_file(&data_dir(&app)?, &repository, number);
    tokio::task::spawn_blocking(move || match std::fs::read_to_string(&file) {
        Ok(text) => Ok(serde_json::from_str(&text).ok()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(PrError::failed(e.to_string())),
    })
    .await
    .map_err(|e| PrError::failed(e.to_string()))?
}

/// Keep `guide` as this pull request's guide, replacing the last one.
#[tauri::command]
pub async fn pr_guide_write(
    app: AppHandle,
    repository: String,
    number: u64,
    guide: Value,
) -> Result<(), PrError> {
    let number = super::pull_number(number)?;
    if !guide.is_object() {
        return Err(PrError::invalid("A guide is an object."));
    }
    let file = guide_file(&data_dir(&app)?, &repository, number);
    tokio::task::spawn_blocking(move || {
        let parent = file.parent().expect("guide files sit in a folder");
        std::fs::create_dir_all(parent).map_err(|e| PrError::failed(e.to_string()))?;
        let tmp = file.with_extension("json.tmp");
        let text = serde_json::to_string(&guide).map_err(|e| PrError::failed(e.to_string()))?;
        std::fs::write(&tmp, text).map_err(|e| PrError::failed(e.to_string()))?;
        std::fs::rename(&tmp, &file).map_err(|e| PrError::failed(e.to_string()))
    })
    .await
    .map_err(|e| PrError::failed(e.to_string()))?
}

/// Check out the pull request's head, detached, for a guide run, and read the
/// change it makes.
#[tauri::command]
pub async fn pr_guide_prepare(
    app: AppHandle,
    path: String,
    number: u64,
    head_sha: String,
    head_branch: String,
    base_branch: String,
) -> Result<PrGuideCheckout, PrError> {
    let path = super::checkout(&path)?.to_string();
    let number = super::pull_number(number)?;
    let runs = data_dir(&app)?.join("runs");
    tokio::task::spawn_blocking(move || {
        prepare(
            Path::new(&path),
            &runs,
            number,
            head_sha.trim(),
            head_branch.trim(),
            base_branch.trim(),
        )
    })
    .await
    .map_err(|e| PrError::failed(e.to_string()))?
}

/// Remove a guide run's worktree and base ref. Best-effort: a run that left
/// something behind is pruned by the next one.
#[tauri::command]
pub async fn pr_guide_finish(app: AppHandle, path: String, run_id: String) -> Result<(), PrError> {
    let path = super::checkout(&path)?.to_string();
    if run_id.is_empty()
        || !run_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        return Err(PrError::invalid("That is not a guide run."));
    }
    let runs = data_dir(&app)?.join("runs");
    tokio::task::spawn_blocking(move || {
        finish(Path::new(&path), &runs, &run_id);
        Ok(())
    })
    .await
    .map_err(|e| PrError::failed(e.to_string()))?
}

fn base_ref(run_id: &str) -> String {
    format!("refs/atlas/pr-guide/{run_id}/base")
}

fn finish(root: &Path, runs: &Path, run_id: &str) {
    let dir = runs.join(run_id);
    let checkout = dir.join("checkout");
    let _ = git(
        root,
        &["worktree", "remove", "--force", &checkout.to_string_lossy()],
    );
    let _ = std::fs::remove_dir_all(&dir);
    let _ = git(root, &["update-ref", "-d", &base_ref(run_id)]);
    let _ = git(root, &["worktree", "prune"]);
}

fn is_commit_hash(sha: &str) -> bool {
    COMMIT_HASH_LEN.contains(&sha.len()) && sha.chars().all(|c| c.is_ascii_hexdigit())
}

/// The commit `sha` names here, only when it is that commit — `rev-parse`
/// prefers a branch or tag named like a short hash.
fn resolve_commit(root: &Path, sha: &str) -> Option<String> {
    let resolved = git(
        root,
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("{sha}^{{commit}}"),
        ],
    )
    .ok()?
    .trim()
    .to_lowercase();
    resolved.starts_with(sha).then_some(resolved)
}

fn remotes(root: &Path) -> Vec<String> {
    let mut names: Vec<String> = git(root, &["remote"])
        .map(|out| {
            out.lines()
                .map(str::to_string)
                .filter(|n| !n.is_empty())
                .collect()
        })
        .unwrap_or_default();
    // `origin` first: the clone's own remote is the likeliest to have the head.
    names.sort_by_key(|n| n != "origin");
    names
}

fn fetch(root: &Path, remote: &str, refspec: &str) -> Result<(), String> {
    git(
        root,
        &["fetch", "--quiet", "--no-tags", "--", remote, refspec],
    )
    .map(|_| ())
}

/// The head commit, from wherever it can be found, in the reference's order.
fn find_head(
    root: &Path,
    remotes: &[String],
    number: u64,
    sha: &str,
    branch: &str,
) -> Result<String, PrError> {
    if let Some(found) = resolve_commit(root, sha) {
        return Ok(found);
    }
    let branch_ref = format!("refs/heads/{branch}");
    let branch_ok = !branch.is_empty() && git(root, &["check-ref-format", &branch_ref]).is_ok();
    let mut sources: Vec<String> = Vec::new();
    if sha.len() == 40 || sha.len() == 64 {
        sources.push(sha.to_string());
    }
    if branch_ok {
        sources.push(branch_ref);
    }
    sources.push(format!("refs/pull/{number}/head"));
    let mut failures: Vec<String> = Vec::new();
    for remote in remotes {
        for source in &sources {
            match fetch(root, remote, source) {
                Ok(()) => {
                    if let Some(found) = resolve_commit(root, sha) {
                        return Ok(found);
                    }
                }
                Err(e) => failures.push(e),
            }
        }
    }
    Err(PrError::failed(format!(
        "Could not find the pull request's head commit here.{}",
        failures
            .last()
            .map(|e| format!(" Last error: {e}"))
            .unwrap_or_default()
    )))
}

fn prepare(
    path: &Path,
    runs: &Path,
    number: u64,
    head_sha: &str,
    head_branch: &str,
    base_branch: &str,
) -> Result<PrGuideCheckout, PrError> {
    let sha = head_sha.to_lowercase();
    if !is_commit_hash(&sha) {
        return Err(PrError::invalid(
            "GitHub did not report the pull request's head commit.",
        ));
    }
    // A name git rejects, or one that would change the refspec, never reaches
    // `git fetch`.
    if base_branch.is_empty()
        || base_branch.starts_with('+')
        || base_branch.contains(':')
        || git(path, &["check-ref-format", "--branch", base_branch]).is_err()
    {
        return Err(PrError::invalid(
            "The pull request's base branch name is not one git can fetch.",
        ));
    }
    let root = git(path, &["rev-parse", "--show-toplevel"])
        .map(|r| PathBuf::from(r.trim()))
        .map_err(|_| PrError::invalid("This folder is not a git checkout."))?;
    let remotes = remotes(&root);
    if remotes.is_empty() {
        return Err(PrError::invalid(
            "This checkout has no remote to fetch from.",
        ));
    }

    let run_id = format!(
        "{}-{}",
        super::gh::now_ms(),
        RUN_COUNTER.fetch_add(1, Ordering::Relaxed)
    );
    // Fetched into a ref of this run's own: FETCH_HEAD is shared by every
    // fetch in the checkout, so a concurrent run could otherwise measure this
    // change from its base.
    let base = base_ref(&run_id);
    let spec = format!("+refs/heads/{base_branch}:{base}");
    let fetched = remotes.iter().any(|r| fetch(&root, r, &spec).is_ok());
    if !fetched {
        return Err(PrError::failed(
            "Could not fetch the pull request's base branch.",
        ));
    }
    let cleanup = |root: &Path| finish(root, runs, &run_id);

    let head = match find_head(&root, &remotes, number, &sha, head_branch) {
        Ok(head) => head,
        Err(e) => {
            cleanup(&root);
            return Err(e);
        }
    };
    let dir = runs.join(&run_id);
    let checkout = dir.join("checkout");
    if let Err(e) = std::fs::create_dir_all(&dir) {
        cleanup(&root);
        return Err(PrError::failed(e.to_string()));
    }
    let checkout_str = checkout.to_string_lossy().into_owned();
    if let Err(e) = git(
        &root,
        &[
            "worktree",
            "add",
            "--detach",
            "--quiet",
            &checkout_str,
            &head,
        ],
    ) {
        cleanup(&root);
        return Err(PrError::failed(format!("Could not make a worktree: {e}")));
    }
    let base_commit = match git(&checkout, &["merge-base", &base, "HEAD"]) {
        Ok(b) => b.trim().to_string(),
        Err(e) => {
            cleanup(&root);
            return Err(PrError::failed(format!(
                "The head shares no history with the base: {e}"
            )));
        }
    };
    let range = format!("{base_commit}...HEAD");
    // Fixed prefixes: a user's diff.noPrefix or custom prefixes would hide the
    // headers the parser reads.
    let diff = |extra: &[&str]| {
        let mut args = vec![
            "-c",
            "core.quotePath=false",
            "diff",
            "--src-prefix=a/",
            "--dst-prefix=b/",
        ];
        args.extend_from_slice(extra);
        args.push(&range);
        run(&checkout, "git", &args)
    };
    let change = match (
        diff(&["--name-only", "-z"]),
        diff(&["--unified=0", "--no-color", "--no-ext-diff"]),
    ) {
        (Ok(names), Ok(patch)) => parse_change(&names, &patch),
        (Err(e), _) | (_, Err(e)) => {
            cleanup(&root);
            return Err(PrError::failed(format!("Could not read the change: {e}")));
        }
    };
    let path = std::fs::canonicalize(&checkout)
        .unwrap_or(checkout)
        .to_string_lossy()
        .into_owned();
    Ok(PrGuideCheckout {
        run_id,
        path,
        base_commit,
        head_commit: head,
        change,
    })
}

fn hunk_range(start: &str, count: Option<&str>) -> Option<[u32; 2]> {
    let start: u32 = start.parse().ok()?;
    let lines: u32 = match count {
        None => 1,
        Some(c) => c.parse().ok()?,
    };
    (lines > 0).then(|| [start, start + lines - 1])
}

/// `@@ -a[,b] +c[,d] @@`, as its four parts.
fn parse_hunk_header(line: &str) -> Option<(&str, Option<&str>, &str, Option<&str>)> {
    let rest = line.strip_prefix("@@ -")?;
    let (old, rest) = rest.split_once(" +")?;
    let (new, _) = rest.split_once(" @@")?;
    let (old_start, old_count) = hunk_side(old)?;
    let (new_start, new_count) = hunk_side(new)?;
    Some((old_start, old_count, new_start, new_count))
}

/// One side of a hunk header, `start[,count]`, digits only.
fn hunk_side(s: &str) -> Option<(&str, Option<&str>)> {
    let digits = |s: &str| !s.is_empty() && s.chars().all(|c| c.is_ascii_digit());
    let (start, count) = match s.split_once(',') {
        Some((a, b)) => (a, Some(b)),
        None => (s, None),
    };
    (digits(start) && count.is_none_or(digits)).then_some((start, count))
}

/// The changed files (`--name-only -z`) and each file's hunk ranges from a
/// `--unified=0` patch.
pub(super) fn parse_change(name_only: &str, patch: &str) -> PrGuideChange {
    let mut hunks: BTreeMap<String, PrGuideHunks> = BTreeMap::new();
    let mut old_path: Option<String> = None;
    let mut current: Option<String> = None;
    // Inside a file's hunks a `--- ` or `+++ ` line is a removed or added
    // source line, not a header.
    let mut in_hunks = false;
    for line in patch.split('\n') {
        if line.starts_with("diff --git ") {
            old_path = None;
            current = None;
            in_hunks = false;
        } else if !in_hunks && line.starts_with("--- ") {
            old_path = line.strip_prefix("--- a/").map(str::to_string);
        } else if !in_hunks && line.starts_with("+++ ") {
            let path = line
                .strip_prefix("+++ b/")
                .map(str::to_string)
                .or_else(|| old_path.clone());
            let Some(path) = path else { continue };
            hunks.entry(path.clone()).or_default();
            current = Some(path);
        } else if let Some(path) = current.as_ref() {
            let Some((os, oc, ns, nc)) = parse_hunk_header(line) else {
                continue;
            };
            in_hunks = true;
            let entry = hunks.entry(path.clone()).or_default();
            if let Some(r) = hunk_range(os, oc) {
                entry.old.push(r);
            }
            if let Some(r) = hunk_range(ns, nc) {
                entry.new.push(r);
            }
        }
    }
    PrGuideChange {
        files: name_only
            .split('\0')
            .filter(|p| !p.is_empty())
            .map(str::to_string)
            .collect(),
        hunks,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_unified_zero_patch_reads_as_hunk_ranges() {
        let patch = "diff --git a/src/a.ts b/src/a.ts\nindex 1..2 100644\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -3,0 +4,2 @@ fn\n+x\n+y\n@@ -10 +12 @@\n-old\n+new\ndiff --git a/gone.ts b/gone.ts\ndeleted file mode 100644\n--- a/gone.ts\n+++ /dev/null\n@@ -1,3 +0,0 @@\n-a\n-b\n-c\n";
        let change = parse_change("src/a.ts\0gone.ts\0", patch);
        assert_eq!(change.files, vec!["src/a.ts", "gone.ts"]);
        let a = &change.hunks["src/a.ts"];
        assert_eq!(a.new, vec![[4, 5], [12, 12]]);
        assert_eq!(a.old, vec![[10, 10]]);
        let gone = &change.hunks["gone.ts"];
        assert_eq!(gone.old, vec![[1, 3]]);
        assert!(gone.new.is_empty());
    }

    #[test]
    fn a_removed_line_that_looks_like_a_header_stays_a_line() {
        let patch = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n--- not a header\n+++ nor this\n";
        let change = parse_change("x\0", patch);
        assert_eq!(change.hunks.len(), 1);
        assert_eq!(change.hunks["x"].new, vec![[1, 2]]);
    }

    #[test]
    fn only_hashes_count_as_commits() {
        assert!(is_commit_hash("abcdef1"));
        assert!(!is_commit_hash("abc"));
        assert!(!is_commit_hash("main-branch"));
    }

    #[test]
    fn a_guide_file_name_never_carries_the_repository() {
        let dir = Path::new("/data");
        let file = guide_file(dir, "Owner/../Repo", 4);
        assert!(file.starts_with("/data/stored"));
        assert!(!file.to_string_lossy().contains("Repo"));
        assert_eq!(file, guide_file(dir, "owner/../repo", 4));
        assert_ne!(file, guide_file(dir, "owner/../repo", 5));
    }

    #[test]
    fn a_run_checks_out_the_head_and_reads_its_change() {
        let dir = tempfile::tempdir().unwrap();
        let origin = dir.path().join("origin");
        std::fs::create_dir_all(&origin).unwrap();
        let g = |cwd: &Path, args: &[&str]| git(cwd, args).unwrap();
        let commit = |cwd: &Path, msg: &str| {
            g(
                cwd,
                &[
                    "-c",
                    "user.name=a",
                    "-c",
                    "user.email=a@b",
                    "commit",
                    "-q",
                    "-am",
                    msg,
                ],
            );
        };
        g(&origin, &["init", "-q", "-b", "main"]);
        std::fs::write(origin.join("a.txt"), "one\ntwo\nthree\n").unwrap();
        g(&origin, &["add", "a.txt"]);
        commit(&origin, "base");
        g(&origin, &["checkout", "-q", "-b", "feat"]);
        std::fs::write(origin.join("a.txt"), "one\nTWO\nthree\nfour\n").unwrap();
        commit(&origin, "change");
        let head = g(&origin, &["rev-parse", "HEAD"]);
        g(&origin, &["checkout", "-q", "main"]);

        let clone = dir.path().join("clone");
        g(
            dir.path(),
            &[
                "clone",
                "-q",
                origin.to_str().unwrap(),
                clone.to_str().unwrap(),
            ],
        );
        let runs = dir.path().join("runs");
        let out = prepare(&clone, &runs, 9, &head, "feat", "main").unwrap();
        assert_eq!(out.head_commit, head);
        assert_eq!(out.change.files, vec!["a.txt"]);
        assert_eq!(out.change.hunks["a.txt"].new, vec![[2, 2], [4, 4]]);
        assert!(Path::new(&out.path).join("a.txt").exists());
        // The clone's own checkout never moved.
        assert_eq!(g(&clone, &["symbolic-ref", "--short", "HEAD"]), "main");

        finish(&clone, &runs, &out.run_id);
        assert!(!Path::new(&out.path).exists());
        assert!(git(
            &clone,
            &["rev-parse", "--verify", "--quiet", &base_ref(&out.run_id)]
        )
        .is_err());
    }
}
