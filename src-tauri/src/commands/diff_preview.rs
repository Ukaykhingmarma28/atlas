//! The review diff: every change in a project as raw unified patches, for the
//! diff viewer that renders patches itself.
//!
//! `git_diff_preview` answers with two sources. `working-tree` is everything
//! uncommitted against `HEAD`; `branch-range` is the working tree against the
//! merge base with the base branch, so it holds the branch's commits too. Each
//! carries the complete per-file numstat and a patch capped at
//! [`PATCH_CAP`]. The cap cuts at a file boundary, so every file the patch
//! holds is whole; when `truncated` is set the viewer renders those and loads
//! the rest one at a time through `git_diff_file_contents`.
//!
//! Untracked files belong in a review — they are usually most of what an agent
//! wrote — but `git diff` cannot see them. Rather than staging them into a
//! scratch index (three more spawns and an index copy), their patches are
//! written here: an untracked file's diff is the whole file added, so there is
//! nothing to compute.
//!
//! Paths are relative to the project path (`--relative`), matching the file
//! tree, and a project opened in a subdirectory of its repository sees only
//! its own changes.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::io::Read;
use std::path::{Component, Path};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};

/// Patch bytes per source. Past this a review is read file by file anyway,
/// and every byte crosses IPC and is parsed on the UI thread.
pub const PATCH_CAP: usize = 120_000;
/// Text per side for `git_diff_file_contents`.
pub const FILE_CAP: usize = 1024 * 1024;
/// Untracked files whose lines are counted. Past this they are listed with
/// zero counts and the source is marked truncated.
const UNTRACKED_COUNT_MAX: usize = 5_000;
/// Git's own binary sniff: a NUL in the first 8000 bytes.
const BINARY_SNIFF: usize = 8000;

const DIFF_ARGS: &[&str] = &[
    "diff",
    "--relative",
    "--find-renames",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    // A user's `diff.noprefix` / `diff.mnemonicPrefix` would otherwise leak
    // into the patch and leave the parser with unnamed files.
    "--src-prefix=a/",
    "--dst-prefix=b/",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum SourceKind {
    #[serde(rename = "working-tree")]
    WorkingTree,
    #[serde(rename = "branch-range")]
    BranchRange,
}

#[derive(Debug, Clone, Serialize, Hash)]
#[serde(rename_all = "camelCase")]
pub struct DiffFileStat {
    pub path: String,
    /// The path before a rename or copy.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
    pub additions: u32,
    pub deletions: u32,
    /// "added" | "deleted" | "modified" | "renamed" | "copied" |
    /// "conflicted" | "untracked".
    pub status: &'static str,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub binary: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffSource {
    pub kind: SourceKind,
    /// `branch-range` only: the base it was taken against (`origin/main`),
    /// or `None` when no base branch could be found and the range is just
    /// the working tree.
    pub base_ref: Option<String>,
    /// `branch-range` only: the merge-base commit. Pass it back as
    /// `git_diff_file_contents`' `base_ref` to skip resolving the base again.
    pub merge_base: Option<String>,
    pub diff: String,
    /// Changes when the patch or the file list does; stable within a run.
    pub diff_hash: String,
    pub truncated: bool,
    /// Complete even when `diff` is truncated.
    pub files: Vec<DiffFileStat>,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct DiffPreview {
    /// Empty outside a git repository.
    pub sources: Vec<DiffSource>,
}

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DiffFileContents {
    pub old_text: String,
    pub new_text: String,
    /// A side was longer than [`FILE_CAP`] and is cut at a line boundary.
    pub truncated: bool,
    /// Either side is binary; both texts are then empty.
    pub binary: bool,
}

// ── Commands ────────────────────────────────────────────────────────────────

type PreviewCell = Arc<tokio::sync::OnceCell<Result<DiffPreview, String>>>;

fn inflight() -> &'static Mutex<HashMap<String, PreviewCell>> {
    static MAP: OnceLock<Mutex<HashMap<String, PreviewCell>>> = OnceLock::new();
    MAP.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Both review sources for the project at `path`. Concurrent identical calls
/// (the watcher's refresh racing the panel's own) share one computation.
#[tauri::command]
pub async fn git_diff_preview(
    path: String,
    base_ref: Option<String>,
    ignore_whitespace: Option<bool>,
) -> Result<DiffPreview, String> {
    let ignore_ws = ignore_whitespace.unwrap_or(false);
    let key = format!("{path}\0{}\0{ignore_ws}", base_ref.as_deref().unwrap_or(""));
    let (cell, owner) = {
        let mut map = inflight().lock().expect("diff preview inflight lock");
        match map.get(&key) {
            Some(c) => (c.clone(), false),
            None => {
                let c: PreviewCell = Arc::new(tokio::sync::OnceCell::new());
                map.insert(key.clone(), c.clone());
                (c, true)
            }
        }
    };

    let result = cell
        .get_or_init(|| async move {
            tokio::task::spawn_blocking(move || {
                compute_preview(Path::new(&path), base_ref.as_deref(), ignore_ws)
            })
            .await
            .map_err(|e| e.to_string())?
        })
        .await
        .clone();

    if owner {
        inflight()
            .lock()
            .expect("diff preview inflight lock")
            .remove(&key);
    }
    result
}

/// Both sides of one file, for a viewer expanding a file the capped patch
/// left out (or showing full context). `source_kind` picks the old side:
/// `HEAD` for the working tree, the merge base for the branch range. The new
/// side is always the file on disk. A side that does not exist (added,
/// deleted) is empty.
#[tauri::command]
pub async fn git_diff_file_contents(
    path: String,
    source_kind: SourceKind,
    base_ref: Option<String>,
    file_path: String,
    old_path: Option<String>,
) -> Result<DiffFileContents, String> {
    tokio::task::spawn_blocking(move || {
        file_contents(
            Path::new(&path),
            source_kind,
            base_ref.as_deref(),
            &file_path,
            old_path.as_deref(),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

// ── Git plumbing ────────────────────────────────────────────────────────────

/// A read-only git: `--no-optional-locks` so a background read never takes
/// `index.lock` from under a commit (see `git::git_read`), and unquoted paths.
fn git(cwd: &Path) -> Command {
    let mut cmd = atlas_process::command("git");
    cmd.args(["--no-optional-locks", "-c", "core.quotePath=false"])
        .current_dir(cwd);
    cmd
}

struct Out {
    ok: bool,
    code: Option<i32>,
    stdout: Vec<u8>,
    stderr: String,
}

fn run(mut cmd: Command) -> Result<Out, String> {
    let o = cmd.output().map_err(|e| format!("git: {e}"))?;
    Ok(Out {
        ok: o.status.success(),
        code: o.status.code(),
        stdout: o.stdout,
        stderr: String::from_utf8_lossy(&o.stderr).into_owned(),
    })
}

fn stdout_line(cmd: Command) -> Option<String> {
    let o = run(cmd).ok()?;
    if !o.ok {
        return None;
    }
    let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
    (!s.is_empty()).then_some(s)
}

/// Run `cmd` and keep at most `cap` bytes of stdout. Past the cap the child
/// is killed rather than drained: a 50 MB patch should cost 120 KB of reading.
/// Returns the bytes, whether the cap cut them, and whether git succeeded
/// (unknowable once killed, so `true` then).
fn run_capped(mut cmd: Command, cap: usize) -> Result<(Vec<u8>, bool, bool), String> {
    let mut child = cmd
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .stdin(Stdio::null())
        .spawn()
        .map_err(|e| format!("git: {e}"))?;
    let mut out = Vec::new();
    let mut stdout = child.stdout.take().expect("piped stdout");
    // One byte past the cap tells "exactly cap" from "more than cap".
    (&mut stdout)
        .take(cap as u64 + 1)
        .read_to_end(&mut out)
        .map_err(|e| e.to_string())?;
    if out.len() > cap {
        let _ = child.kill();
        let _ = child.wait();
        return Ok((out, true, true));
    }
    drop(stdout);
    let status = child.wait().map_err(|e| e.to_string())?;
    Ok((out, false, status.success()))
}

enum Head {
    NotARepo,
    Unborn,
    Commit(String),
}

fn resolve_head(cwd: &Path) -> Result<Head, String> {
    let mut cmd = git(cwd);
    cmd.args(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
    let o = run(cmd)?;
    if o.ok {
        return Ok(Head::Commit(
            String::from_utf8_lossy(&o.stdout).trim().to_string(),
        ));
    }
    if o.stderr.contains("not a git repository") {
        return Ok(Head::NotARepo);
    }
    if o.code == Some(1) || o.stderr.trim().is_empty() {
        return Ok(Head::Unborn);
    }
    Err(o.stderr.trim().to_string())
}

/// The empty tree's id, for diffing a repository with no commits. Asked of
/// git so SHA-256 repositories get theirs.
fn empty_tree(cwd: &Path) -> Result<String, String> {
    let mut cmd = git(cwd);
    cmd.args(["hash-object", "-t", "tree", "--stdin"])
        .stdin(Stdio::null());
    stdout_line(cmd).ok_or_else(|| "could not hash the empty tree".to_string())
}

/// The branch a review compares against when the caller names none: the
/// remote's default (`origin/HEAD`), else the first of `origin/main`,
/// `origin/master`, `main`, `master` that exists.
fn default_base(cwd: &Path) -> Option<String> {
    let mut cmd = git(cwd);
    cmd.args([
        "symbolic-ref",
        "--quiet",
        "--short",
        "refs/remotes/origin/HEAD",
    ]);
    if let Some(r) = stdout_line(cmd) {
        return Some(r);
    }
    const CANDIDATES: [&str; 4] = [
        "refs/remotes/origin/main",
        "refs/remotes/origin/master",
        "refs/heads/main",
        "refs/heads/master",
    ];
    let mut cmd = git(cwd);
    cmd.args(["for-each-ref", "--format=%(refname)"])
        .args(CANDIDATES);
    let found = stdout_line(cmd)?;
    let found: Vec<&str> = found.lines().collect();
    CANDIDATES.iter().find(|c| found.contains(c)).map(|c| {
        c.trim_start_matches("refs/remotes/")
            .trim_start_matches("refs/heads/")
            .to_string()
    })
}

fn merge_base(cwd: &Path, base: &str) -> Option<String> {
    let mut cmd = git(cwd);
    cmd.args(["merge-base", "--end-of-options", base, "HEAD"]);
    stdout_line(cmd)
}

// ── Preview ─────────────────────────────────────────────────────────────────

/// One diff against `rev` (to the working tree), before untracked files.
struct Tracked {
    files: Vec<DiffFileStat>,
    patch: Vec<u8>,
    truncated: bool,
}

fn diff_against(cwd: &Path, rev: &str, ignore_ws: bool) -> Result<Tracked, String> {
    let ws: &[&str] = if ignore_ws {
        &["--ignore-all-space"]
    } else {
        &[]
    };
    // The full file list and the capped patch, side by side: neither waits
    // for the other.
    std::thread::scope(|s| {
        let stat = s.spawn(|| {
            let mut cmd = git(cwd);
            cmd.args(DIFF_ARGS)
                .args(ws)
                .args(["--raw", "--numstat", "-z", rev, "--"]);
            run(cmd)
        });
        let patch = s.spawn(|| {
            let mut cmd = git(cwd);
            cmd.args(DIFF_ARGS).args(ws).args(["--patch", rev, "--"]);
            run_capped(cmd, PATCH_CAP)
        });
        let stat = stat
            .join()
            .map_err(|_| "diff stat panicked".to_string())??;
        if !stat.ok {
            return Err(format!("git diff --numstat: {}", stat.stderr.trim()));
        }
        let (patch, truncated, _) = patch.join().map_err(|_| "diff panicked".to_string())??;
        let files = parse_raw_numstat(&stat.stdout);
        let (patch, truncated) = if truncated {
            (cut_at_file_boundary(patch, PATCH_CAP), true)
        } else {
            (patch, false)
        };
        Ok(Tracked {
            files,
            patch,
            truncated,
        })
    })
}

fn status_word(c: u8) -> &'static str {
    match c {
        b'A' => "added",
        b'D' => "deleted",
        b'R' => "renamed",
        b'C' => "copied",
        b'U' => "conflicted",
        _ => "modified",
    }
}

/// Parse `git diff --raw --numstat -z`: every raw record, then every numstat
/// record, in the same order.
///
/// ```text
/// raw:     :100644 100644 <sha> <sha> M\0path\0
///          :100644 100644 <sha> <sha> R087\0old\0new\0
/// numstat: 3\t1\tpath\0
///          3\t1\t\0old\0new\0         (rename / copy)
///          -\t-\tpath\0               (binary)
/// ```
pub fn parse_raw_numstat(out: &[u8]) -> Vec<DiffFileStat> {
    let mut fields = out.split(|b| *b == 0);
    let mut statuses: Vec<u8> = Vec::new();
    let mut files: Vec<DiffFileStat> = Vec::new();
    let text = |b: &[u8]| String::from_utf8_lossy(b).into_owned();
    while let Some(f) = fields.next() {
        if f.is_empty() {
            continue;
        }
        if f[0] == b':' {
            // Status is the last space-separated word; R/C carry two paths.
            let status = f
                .rsplit(|b| *b == b' ')
                .next()
                .and_then(|w| w.first().copied());
            let status = status.unwrap_or(b'M');
            let paths = if matches!(status, b'R' | b'C') { 2 } else { 1 };
            for _ in 0..paths {
                fields.next();
            }
            statuses.push(status);
            continue;
        }
        let mut cols = f.splitn(3, |b| *b == b'\t');
        let (Some(a), Some(d), Some(rest)) = (cols.next(), cols.next(), cols.next()) else {
            continue;
        };
        let binary = a == b"-" || d == b"-";
        let num = |c: &[u8]| {
            std::str::from_utf8(c)
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(0)
        };
        let (path, old_path) = if rest.is_empty() {
            let old = fields.next().map(text);
            let new = fields.next().map(text).unwrap_or_default();
            (new, old)
        } else {
            (text(rest), None)
        };
        files.push(DiffFileStat {
            path,
            old_path,
            additions: num(a),
            deletions: num(d),
            status: "modified",
            binary,
        });
    }
    // Same diff queue, same order — the raw record N is numstat record N.
    for (file, s) in files.iter_mut().zip(statuses.iter()) {
        file.status = status_word(*s);
    }
    if statuses.len() != files.len() {
        for f in files.iter_mut().filter(|f| f.old_path.is_some()) {
            f.status = "renamed";
        }
    }
    files
}

/// Cut an over-cap patch so it ends on a whole file: everything up to the
/// last `diff --git` header that starts within the cap. A first file larger
/// than the cap leaves an empty patch, which the viewer handles as lazy.
pub fn cut_at_file_boundary(mut patch: Vec<u8>, cap: usize) -> Vec<u8> {
    const HEADER: &[u8] = b"\ndiff --git ";
    let window = &patch[..cap.min(patch.len())];
    let cut = window
        .windows(HEADER.len())
        .rposition(|w| w == HEADER)
        .map(|i| i + 1)
        .unwrap_or(0);
    patch.truncate(cut);
    patch
}

/// The repository's untracked, non-ignored files under `cwd`, relative to it.
fn untracked(cwd: &Path) -> Result<Vec<String>, String> {
    let mut cmd = git(cwd);
    cmd.args(["ls-files", "--others", "--exclude-standard", "-z", "--"]);
    let o = run(cmd)?;
    if !o.ok {
        return Err(format!("git ls-files: {}", o.stderr.trim()));
    }
    Ok(o.stdout
        .split(|b| *b == 0)
        .filter(|f| !f.is_empty())
        .map(|f| String::from_utf8_lossy(f).into_owned())
        .collect())
}

/// An untracked file, read once: its stat row and, when it fits, its patch.
struct NewFile {
    stat: DiffFileStat,
    patch: Option<Vec<u8>>,
}

/// Count and (budget permitting) render one untracked file as all-added.
fn new_file(cwd: &Path, rel: &str, budget: usize, count: bool) -> NewFile {
    let mut stat = DiffFileStat {
        path: rel.to_string(),
        old_path: None,
        additions: 0,
        deletions: 0,
        status: "untracked",
        binary: false,
    };
    if !count {
        return NewFile { stat, patch: None };
    }
    let abs = cwd.join(rel);
    let (bytes, mode) = match std::fs::symlink_metadata(&abs) {
        Ok(m) if m.file_type().is_symlink() => match std::fs::read_link(&abs) {
            Ok(t) => (t.to_string_lossy().into_owned().into_bytes(), "120000"),
            Err(_) => return NewFile { stat, patch: None },
        },
        // Too big to patch anyway: count it without holding it in memory.
        Ok(m) if m.len() as usize > budget => {
            if let Some((lines, binary)) = count_streaming(&abs) {
                stat.additions = if binary { 0 } else { lines };
                stat.binary = binary;
            }
            return NewFile { stat, patch: None };
        }
        Ok(m) => match std::fs::read(&abs) {
            Ok(b) => {
                #[cfg(unix)]
                let mode = {
                    use std::os::unix::fs::PermissionsExt;
                    if m.permissions().mode() & 0o111 != 0 {
                        "100755"
                    } else {
                        "100644"
                    }
                };
                #[cfg(not(unix))]
                let mode = {
                    let _ = m;
                    "100644"
                };
                (b, mode)
            }
            Err(_) => return NewFile { stat, patch: None },
        },
        Err(_) => return NewFile { stat, patch: None },
    };

    if bytes[..bytes.len().min(BINARY_SNIFF)].contains(&0) {
        stat.binary = true;
        let patch = format!(
            "diff --git a/{rel} b/{rel}\nnew file mode {mode}\nBinary files /dev/null and b/{rel} differ\n"
        )
        .into_bytes();
        return NewFile {
            stat,
            patch: (patch.len() <= budget).then_some(patch),
        };
    }

    let lines = bytes.split_inclusive(|b| *b == b'\n').count();
    stat.additions = lines as u32;
    let mut patch = format!("diff --git a/{rel} b/{rel}\nnew file mode {mode}\n").into_bytes();
    if lines > 0 {
        let range = if lines == 1 {
            "1".to_string()
        } else {
            format!("1,{lines}")
        };
        patch.extend_from_slice(
            format!("--- /dev/null\n+++ b/{rel}\n@@ -0,0 +{range} @@\n").as_bytes(),
        );
        // The '+' prefixes add one byte per line.
        if patch.len() + bytes.len() + lines + 32 > budget {
            return NewFile { stat, patch: None };
        }
        for line in bytes.split_inclusive(|b| *b == b'\n') {
            patch.push(b'+');
            patch.extend_from_slice(line);
        }
        if bytes.last() != Some(&b'\n') {
            patch.extend_from_slice(b"\n\\ No newline at end of file\n");
        }
    }
    NewFile {
        stat,
        patch: (patch.len() <= budget).then_some(patch),
    }
}

/// Line count and binary sniff for a file, read in chunks.
fn count_streaming(path: &Path) -> Option<(u32, bool)> {
    let mut f = std::fs::File::open(path).ok()?;
    let mut buf = vec![0u8; 64 * 1024];
    let (mut lines, mut seen, mut last) = (0u32, 0usize, b'\n');
    loop {
        let n = f.read(&mut buf).ok()?;
        if n == 0 {
            break;
        }
        let chunk = &buf[..n];
        if seen < BINARY_SNIFF && chunk[..n.min(BINARY_SNIFF - seen)].contains(&0) {
            return Some((0, true));
        }
        seen += n;
        lines += chunk.iter().filter(|b| **b == b'\n').count() as u32;
        last = chunk[n - 1];
    }
    Some((lines + u32::from(last != b'\n'), false))
}

/// Append untracked files to a source: every stat row, and patches until the
/// first one that does not fit (keeping the patch a prefix of whole files).
fn assemble(
    kind: SourceKind,
    base_ref: Option<String>,
    merge_base: Option<String>,
    tracked: Tracked,
    news: &[NewFile],
    news_truncated: bool,
) -> DiffSource {
    let Tracked {
        mut files,
        mut patch,
        mut truncated,
    } = tracked;
    truncated |= news_truncated;
    for n in news {
        files.push(n.stat.clone());
        if truncated {
            continue;
        }
        match &n.patch {
            Some(p) if patch.len() + p.len() <= PATCH_CAP => patch.extend_from_slice(p),
            _ => truncated = true,
        }
    }
    let diff = String::from_utf8_lossy(&patch).into_owned();
    let mut h = std::collections::hash_map::DefaultHasher::new();
    diff.hash(&mut h);
    files.hash(&mut h);
    DiffSource {
        kind,
        base_ref,
        merge_base,
        diff,
        diff_hash: format!("{:016x}", h.finish()),
        truncated,
        files,
    }
}

pub fn compute_preview(
    cwd: &Path,
    base_ref: Option<&str>,
    ignore_ws: bool,
) -> Result<DiffPreview, String> {
    let head = match resolve_head(cwd)? {
        Head::NotARepo => return Ok(DiffPreview::default()),
        Head::Unborn => None,
        Head::Commit(sha) => Some(sha),
    };
    let head_rev = match &head {
        Some(sha) => sha.clone(),
        None => empty_tree(cwd)?,
    };

    // The base, its merge base, the untracked list and the working-tree diff
    // are independent; run them together.
    let (range, working, untracked_paths) = std::thread::scope(|s| {
        let range = s.spawn(|| {
            head.as_ref()?;
            let base = base_ref.map(str::to_string).or_else(|| default_base(cwd))?;
            let mb = merge_base(cwd, &base)?;
            Some((base, mb))
        });
        let working = s.spawn(|| diff_against(cwd, &head_rev, ignore_ws));
        let untracked_paths = s.spawn(|| untracked(cwd));
        (
            range.join().ok().flatten(),
            working.join(),
            untracked_paths.join(),
        )
    });
    let working = working.map_err(|_| "diff panicked".to_string())??;
    let untracked_paths = untracked_paths.map_err(|_| "ls-files panicked".to_string())??;

    // A merge base equal to HEAD (on the base branch, or no commits of its
    // own) makes the range the working tree: compute it once.
    let range_tracked = match &range {
        Some((_, mb)) if Some(mb) != head.as_ref() => Some(diff_against(cwd, mb, ignore_ws)?),
        _ => None,
    };

    let news_truncated = untracked_paths.len() > UNTRACKED_COUNT_MAX;
    // Room left after the smaller tracked patch: no untracked patch larger
    // than this can land in either source, so none is built.
    let tracked_len = working
        .patch
        .len()
        .min(range_tracked.as_ref().map_or(usize::MAX, |t| t.patch.len()));
    let mut budget = PATCH_CAP.saturating_sub(tracked_len);
    let news: Vec<NewFile> = untracked_paths
        .iter()
        .enumerate()
        .map(|(i, p)| {
            let n = new_file(cwd, p, budget, i < UNTRACKED_COUNT_MAX);
            budget = budget.saturating_sub(n.patch.as_ref().map_or(budget, Vec::len));
            n
        })
        .collect();

    let range_tracked = match range_tracked {
        Some(t) => t,
        None => Tracked {
            files: working.files.clone(),
            patch: working.patch.clone(),
            truncated: working.truncated,
        },
    };
    let (base, mb) = match range {
        Some((b, m)) => (Some(b), Some(m)),
        None => (None, None),
    };
    Ok(DiffPreview {
        sources: vec![
            assemble(
                SourceKind::WorkingTree,
                None,
                None,
                working,
                &news,
                news_truncated,
            ),
            assemble(
                SourceKind::BranchRange,
                base,
                mb,
                range_tracked,
                &news,
                news_truncated,
            ),
        ],
    })
}

// ── File contents ───────────────────────────────────────────────────────────

fn safe_relative(rel: &str) -> Result<&Path, String> {
    let p = Path::new(rel);
    if rel.is_empty()
        || !p
            .components()
            .all(|c| matches!(c, Component::Normal(_) | Component::CurDir))
    {
        return Err(format!("Path must be inside the project: {rel}"));
    }
    Ok(p)
}

/// Cut `bytes` to `cap` at the last line break inside it.
fn cap_text(mut bytes: Vec<u8>, cap: usize) -> (String, bool) {
    if bytes.len() <= cap {
        return (String::from_utf8_lossy(&bytes).into_owned(), false);
    }
    let cut = bytes[..cap]
        .iter()
        .rposition(|b| *b == b'\n')
        .map_or(cap, |i| i + 1);
    bytes.truncate(cut);
    (String::from_utf8_lossy(&bytes).into_owned(), true)
}

fn is_binary(bytes: &[u8]) -> bool {
    bytes[..bytes.len().min(BINARY_SNIFF)].contains(&0)
}

/// Read the working-tree file, refusing anything that resolves (through a
/// link) outside the project. A missing file is an empty side.
fn read_worktree(cwd: &Path, rel: &Path) -> Result<Vec<u8>, String> {
    let target = cwd.join(rel);
    let Ok(meta) = std::fs::metadata(&target) else {
        return Ok(Vec::new());
    };
    if !meta.is_file() {
        return Ok(Vec::new());
    }
    let real_root = std::fs::canonicalize(cwd).map_err(|e| e.to_string())?;
    let real = std::fs::canonicalize(&target).map_err(|e| e.to_string())?;
    if !real.starts_with(&real_root) {
        return Err(format!("{} resolves outside the project", rel.display()));
    }
    let mut out = Vec::new();
    std::fs::File::open(&real)
        .map_err(|e| e.to_string())?
        .take(FILE_CAP as u64 + 1)
        .read_to_end(&mut out)
        .map_err(|e| e.to_string())?;
    Ok(out)
}

pub fn file_contents(
    cwd: &Path,
    kind: SourceKind,
    base_ref: Option<&str>,
    file_path: &str,
    old_path: Option<&str>,
) -> Result<DiffFileContents, String> {
    let new_rel = safe_relative(file_path)?;
    let old_rel = safe_relative(old_path.unwrap_or(file_path))?;

    let old_rev: Option<String> = match kind {
        SourceKind::WorkingTree => Some("HEAD".to_string()),
        SourceKind::BranchRange => {
            let base = base_ref.map(str::to_string).or_else(|| default_base(cwd));
            // No base (or no common history): the range is the working
            // tree, as `git_diff_preview` reports it.
            base.and_then(|b| merge_base(cwd, &b))
                .or_else(|| Some("HEAD".to_string()))
        }
    };

    let (old, new) = std::thread::scope(|s| {
        let old = s.spawn(|| -> Result<Vec<u8>, String> {
            let Some(rev) = old_rev else {
                return Ok(Vec::new());
            };
            // `<rev>:./<path>` resolves against the cwd, so the path stays
            // relative to the project like everything else here.
            let spec = format!("{rev}:./{}", old_rel.to_string_lossy());
            let mut cmd = git(cwd);
            cmd.args(["cat-file", "blob", &spec]);
            let (bytes, _, ok) = run_capped(cmd, FILE_CAP)?;
            // Absent at that revision (an added file, an unborn HEAD).
            Ok(if ok { bytes } else { Vec::new() })
        });
        let new = read_worktree(cwd, new_rel);
        (old.join(), new)
    });
    let old = old.map_err(|_| "cat-file panicked".to_string())??;
    let new = new?;

    if is_binary(&old) || is_binary(&new) {
        return Ok(DiffFileContents {
            binary: true,
            ..Default::default()
        });
    }
    let (old_text, old_cut) = cap_text(old, FILE_CAP);
    let (new_text, new_cut) = cap_text(new, FILE_CAP);
    Ok(DiffFileContents {
        old_text,
        new_text,
        truncated: old_cut || new_cut,
        binary: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    struct Repo(PathBuf);
    impl Repo {
        fn new(tag: &str) -> Self {
            let p = std::env::temp_dir().join(format!(
                "atlas-diff-preview-{tag}-{}-{:?}",
                std::process::id(),
                std::thread::current().id()
            ));
            let _ = std::fs::remove_dir_all(&p);
            std::fs::create_dir_all(&p).unwrap();
            let r = Self(p);
            r.git(&["init", "-q", "-b", "main"]);
            r.git(&["config", "user.email", "t@example.com"]);
            r.git(&["config", "user.name", "t"]);
            r.git(&["config", "commit.gpgsign", "false"]);
            r
        }
        fn git(&self, args: &[&str]) {
            let o = atlas_process::command("git")
                .args(args)
                .current_dir(&self.0)
                .output()
                .unwrap();
            assert!(
                o.status.success(),
                "git {args:?}: {}",
                String::from_utf8_lossy(&o.stderr)
            );
        }
        fn write(&self, rel: &str, body: &str) {
            let p = self.0.join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, body).unwrap();
        }
        fn commit(&self, msg: &str) {
            self.git(&["add", "-A"]);
            self.git(&["commit", "-q", "-m", msg]);
        }
        fn working(&self) -> DiffSource {
            compute_preview(&self.0, None, false)
                .unwrap()
                .sources
                .into_iter()
                .find(|s| s.kind == SourceKind::WorkingTree)
                .unwrap()
        }
    }
    impl Drop for Repo {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn parses_a_rename_in_numstat() {
        let raw = b":100644 100644 aaa bbb R087\0old/name.ts\0new/name.ts\0:100644 100644 ccc ddd M\0x.rs\0:000000 100644 000 eee A\0img.png\0\
2\t1\t\0old/name.ts\0new/name.ts\0\
4\t0\tx.rs\0\
-\t-\timg.png\0";
        let files = parse_raw_numstat(raw);
        assert_eq!(files.len(), 3);
        assert_eq!(files[0].path, "new/name.ts");
        assert_eq!(files[0].old_path.as_deref(), Some("old/name.ts"));
        assert_eq!((files[0].additions, files[0].deletions), (2, 1));
        assert_eq!(files[0].status, "renamed");
        assert_eq!(files[1].status, "modified");
        assert_eq!(files[1].additions, 4);
        assert_eq!(files[2].status, "added");
        assert!(files[2].binary);
    }

    #[test]
    fn a_real_rename_comes_back_with_its_old_path() {
        let r = Repo::new("rename");
        let body: String = (0..40).map(|i| format!("line {i}\n")).collect();
        r.write("src/a.ts", &body);
        r.commit("init");
        r.git(&["mv", "src/a.ts", "src/b.ts"]);
        r.write("src/b.ts", &format!("{body}line 40\n"));
        let w = r.working();
        let f = w.files.iter().find(|f| f.path == "src/b.ts").unwrap();
        assert_eq!(f.old_path.as_deref(), Some("src/a.ts"));
        assert_eq!(f.status, "renamed");
        assert_eq!((f.additions, f.deletions), (1, 0));
        assert!(w.diff.contains("rename from src/a.ts"));
        assert!(!w.truncated);
    }

    #[test]
    fn untracked_files_are_listed_and_patched_as_added() {
        let r = Repo::new("untracked");
        r.write("a.txt", "a\n");
        r.commit("init");
        r.write("new.txt", "one\ntwo");
        r.write(".gitignore", "ignored.txt\n");
        r.write("ignored.txt", "x\n");
        let w = r.working();
        let f = w.files.iter().find(|f| f.path == "new.txt").unwrap();
        assert_eq!(f.status, "untracked");
        assert_eq!(f.additions, 2);
        assert!(w.files.iter().all(|f| f.path != "ignored.txt"));
        assert!(w
            .diff
            .contains("+++ b/new.txt\n@@ -0,0 +1,2 @@\n+one\n+two\n\\ No newline"));
    }

    #[test]
    fn an_oversized_patch_is_cut_at_a_file_boundary_with_every_file_listed() {
        let r = Repo::new("truncate");
        // 40 files × ~4 KB of changed lines ≈ 160 KB of patch: over the cap.
        for i in 0..40 {
            r.write(&format!("f{i:02}.txt"), "seed\n");
        }
        r.commit("init");
        let big: String = (0..100)
            .map(|i| format!("changed line {i} {}\n", "x".repeat(24)))
            .collect();
        for i in 0..40 {
            r.write(&format!("f{i:02}.txt"), &big);
        }
        let w = r.working();
        assert!(w.truncated);
        assert_eq!(w.files.len(), 40, "the file list is complete");
        assert!(w.diff.len() <= PATCH_CAP);
        assert!(w.diff.starts_with("diff --git "));
        // Ends on a whole file: the last hunk's final line is complete.
        assert!(w.diff.ends_with('\n'));
        let shown = w.diff.matches("diff --git ").count();
        assert!(shown > 0 && shown < 40);
        // And the lazy path still answers for a file the patch left out.
        let c = file_contents(&r.0, SourceKind::WorkingTree, None, "f39.txt", None).unwrap();
        assert_eq!(c.old_text, "seed\n");
        assert_eq!(c.new_text, big);
    }

    #[test]
    fn branch_range_reaches_back_to_the_merge_base() {
        let r = Repo::new("range");
        r.write("a.txt", "a\n");
        r.commit("init");
        r.git(&["checkout", "-q", "-b", "feature"]);
        r.write("b.txt", "b\n");
        r.commit("feature work");
        r.write("a.txt", "a2\n");
        let p = compute_preview(&r.0, None, false).unwrap();
        let range = p
            .sources
            .iter()
            .find(|s| s.kind == SourceKind::BranchRange)
            .unwrap();
        assert_eq!(range.base_ref.as_deref(), Some("main"));
        let paths: Vec<_> = range.files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths, ["a.txt", "b.txt"]);
        let working = p
            .sources
            .iter()
            .find(|s| s.kind == SourceKind::WorkingTree)
            .unwrap();
        assert_eq!(working.files.len(), 1);

        let mb = range.merge_base.as_deref();
        let c = file_contents(&r.0, SourceKind::BranchRange, mb, "b.txt", None).unwrap();
        assert_eq!((c.old_text.as_str(), c.new_text.as_str()), ("", "b\n"));
    }

    #[test]
    fn outside_a_repository_there_are_no_sources() {
        let p =
            std::env::temp_dir().join(format!("atlas-diff-preview-norepo-{}", std::process::id()));
        std::fs::create_dir_all(&p).unwrap();
        assert!(compute_preview(&p, None, false).unwrap().sources.is_empty());
        let _ = std::fs::remove_dir_all(&p);
    }

    #[test]
    fn file_contents_flags_binary_and_refuses_escapes() {
        let r = Repo::new("contents");
        std::fs::write(r.0.join("bin.dat"), [0u8, 1, 2, 3]).unwrap();
        r.commit("init");
        let c = file_contents(&r.0, SourceKind::WorkingTree, None, "bin.dat", None).unwrap();
        assert!(c.binary);
        assert!(file_contents(&r.0, SourceKind::WorkingTree, None, "../x", None).is_err());
    }
}
