//! A checkout of a pull request's head for an agent session to work in: the
//! "Fix" actions' first step.
//!
//! The main checkout is never switched. A pull request whose branch is
//! already checked out — in the main checkout or in a worktree — is worked on
//! where it is. Otherwise it gets a worktree of its own under Atlas's data
//! directory, and `gh pr checkout` puts the branch in it: `gh` fetches the
//! head, names the push remote (a fork's included) and fast-forwards a local
//! branch that already exists, so the user can push the session's work from
//! the session context overlay as usual.
//!
//! A pull request from another repository is checked out as
//! `atlas/pr-<number>/<branch>`, so a fork's `main` never lands on the user's
//! own `main`.
//!
//! Nothing here logs a repository, branch or path.

use std::path::{Path, PathBuf};
use std::process::Stdio;

use serde::Serialize;
use tauri::{AppHandle, Manager};

use super::model::PrError;

/// Where the session should run, and how it got there.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrCheckout {
    /// The local branch holding the pull request's head.
    pub branch: String,
    /// The worktree it is in, or `None` for the main checkout.
    pub worktree_path: Option<String>,
    /// The directory the session runs in.
    pub cwd: String,
    /// Whether the checkout's HEAD is the pull request's head commit. False
    /// for a reused checkout that holds commits of its own or could not move.
    pub is_on_pull_request_head: bool,
    /// An existing checkout was used rather than a new worktree made.
    pub reused: bool,
}

/// Check out pull request `number`'s head for a session: where it already is,
/// or in a new worktree.
#[tauri::command]
pub async fn pr_prepare_checkout(
    app: AppHandle,
    path: String,
    number: u64,
    head_branch: String,
    head_sha: Option<String>,
    is_cross_repository: bool,
) -> Result<PrCheckout, PrError> {
    let path = super::checkout(&path)?.to_string();
    let number = super::pull_number(number)?;
    let root = app
        .path()
        .app_data_dir()
        .map_err(|e| PrError::failed(e.to_string()))?
        .join("worktrees");
    tokio::task::spawn_blocking(move || {
        prepare(
            Path::new(&path),
            &root,
            number,
            head_branch.trim(),
            head_sha.as_deref(),
            is_cross_repository,
        )
    })
    .await
    .map_err(|e| PrError::failed(e.to_string()))?
}

pub(super) fn run(cwd: &Path, program: &str, args: &[&str]) -> Result<String, String> {
    let out = atlas_process::command(program)
        .args(args)
        .current_dir(cwd)
        .env("GH_PROMPT_DISABLED", "1")
        .env("GH_NO_UPDATE_NOTIFIER", "1")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("NO_COLOR", "1")
        .stdin(Stdio::null())
        .output()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                format!("{program} is not installed")
            } else {
                e.to_string()
            }
        })?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        let line = stderr
            .lines()
            .map(str::trim)
            .rfind(|l| !l.is_empty())
            .unwrap_or("failed")
            .to_string();
        return Err(line);
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

pub(super) fn git(cwd: &Path, args: &[&str]) -> Result<String, String> {
    run(cwd, "git", args).map(|s| s.trim_end().to_string())
}

/// The branch a cross-repository head is checked out as. Same rule as the
/// branch-name generator: lower case, `[a-z0-9/_-]`, at most 64 characters.
pub(super) fn sanitize_branch_fragment(raw: &str) -> String {
    let trim_set = |c: char| matches!(c, '.' | '/' | '_' | '-') || c.is_whitespace();
    let lowered: String = raw
        .trim()
        .to_lowercase()
        .chars()
        .filter(|c| !matches!(c, '\'' | '"' | '`'))
        .collect();
    let lowered = lowered.trim_matches(trim_set);
    let mut out = String::new();
    let mut last: Option<char> = None;
    for c in lowered.chars() {
        let mapped = if c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '/' | '_' | '-')
        {
            c
        } else {
            '-'
        };
        // Runs of `/` and of `-` collapse to one.
        if (mapped == '/' || mapped == '-') && last == Some(mapped) {
            continue;
        }
        out.push(mapped);
        last = Some(mapped);
    }
    let trimmed: String = out
        .trim_matches(|c: char| matches!(c, '.' | '/' | '_' | '-'))
        .chars()
        .take(64)
        .collect();
    let trimmed = trimmed.trim_end_matches(['.', '/', '_', '-']).to_string();
    if trimmed.is_empty() {
        "update".into()
    } else {
        trimmed
    }
}

pub(super) fn local_branch_name(number: u64, head_branch: &str, cross_repository: bool) -> String {
    if !cross_repository {
        return head_branch.to_string();
    }
    let suffix = sanitize_branch_fragment(head_branch);
    let suffix = if suffix.is_empty() {
        "head".to_string()
    } else {
        suffix
    };
    format!("atlas/pr-{number}/{suffix}")
}

/// `git worktree list --porcelain`: each worktree's path and the branch it
/// has checked out (`None` when detached).
pub(super) fn parse_worktrees(porcelain: &str) -> Vec<(PathBuf, Option<String>)> {
    let mut out = Vec::new();
    let mut current: Option<(PathBuf, Option<String>)> = None;
    for line in porcelain.lines() {
        if let Some(path) = line.strip_prefix("worktree ") {
            if let Some(done) = current.take() {
                out.push(done);
            }
            current = Some((PathBuf::from(path), None));
        } else if let Some(branch) = line.strip_prefix("branch ") {
            if let Some((_, slot)) = current.as_mut() {
                *slot = Some(
                    branch
                        .strip_prefix("refs/heads/")
                        .unwrap_or(branch)
                        .to_string(),
                );
            }
        }
    }
    if let Some(done) = current {
        out.push(done);
    }
    out
}

fn canonical(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn head_matches(cwd: &Path, head_sha: Option<&str>) -> bool {
    let Some(want) = head_sha.map(str::trim).filter(|s| !s.is_empty()) else {
        return false;
    };
    git(cwd, &["rev-parse", "HEAD"])
        .map(|have| have.trim().to_lowercase().starts_with(&want.to_lowercase()))
        .unwrap_or(false)
}

/// A short, stable folder name for a checkout: its folder name and a hash of
/// its path, so two clones of one repository never share a worktree folder.
pub(super) fn checkout_slug(root: &Path) -> String {
    let name = root
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "repo".into());
    let name = sanitize_branch_fragment(&name).replace('/', "-");
    let mut hash: u32 = 0x811c_9dc5;
    for byte in root.to_string_lossy().as_bytes() {
        hash ^= u32::from(*byte);
        hash = hash.wrapping_mul(0x0100_0193);
    }
    format!("{name}-{hash:08x}")
}

fn prepare(
    path: &Path,
    worktrees_root: &Path,
    number: u64,
    head_branch: &str,
    head_sha: Option<&str>,
    cross_repository: bool,
) -> Result<PrCheckout, PrError> {
    if head_branch.is_empty() {
        return Err(PrError::invalid("The pull request names no head branch."));
    }
    let root = git(path, &["rev-parse", "--show-toplevel"])
        .map(|r| canonical(Path::new(r.trim())))
        .map_err(|_| PrError::invalid("This folder is not a git checkout."))?;
    let branch = local_branch_name(number, head_branch, cross_repository);
    if git(&root, &["check-ref-format", "--branch", &branch]).is_err() {
        return Err(PrError::invalid(
            "The pull request's branch name is not one git can check out.",
        ));
    }

    let worktrees = git(&root, &["worktree", "list", "--porcelain"])
        .map(|p| parse_worktrees(&p))
        .unwrap_or_default();
    if let Some((found, _)) = worktrees
        .iter()
        .find(|(_, b)| b.as_deref() == Some(branch.as_str()))
    {
        let found = canonical(found);
        let is_main = found == root;
        // Moved forward only when it can be without losing anything: `gh`
        // fast-forwards, and refuses a branch that has diverged.
        if !head_matches(&found, head_sha) {
            let n = number.to_string();
            if let Err(e) = run(&found, "gh", &["pr", "checkout", &n, "--branch", &branch]) {
                tracing::debug!(target: "atlas::pull_requests", "refreshing a reused checkout failed: {e}");
            }
        }
        let cwd = found.to_string_lossy().into_owned();
        return Ok(PrCheckout {
            branch,
            worktree_path: (!is_main).then(|| cwd.clone()),
            is_on_pull_request_head: head_matches(&found, head_sha),
            cwd,
            reused: true,
        });
    }

    let parent = worktrees_root.join(checkout_slug(&root));
    std::fs::create_dir_all(&parent).map_err(|e| PrError::failed(e.to_string()))?;
    // A folder left by a worktree whose registration is gone is pruned first;
    // one still in use gets a numbered sibling.
    let _ = git(&root, &["worktree", "prune"]);
    let mut dir = parent.join(format!("pr-{number}"));
    let mut attempt = 1;
    while dir.exists() {
        attempt += 1;
        dir = parent.join(format!("pr-{number}-{attempt}"));
    }
    let dir_str = dir.to_string_lossy().into_owned();
    git(
        &root,
        &["worktree", "add", "--detach", "--quiet", &dir_str, "HEAD"],
    )
    .map_err(|e| PrError::failed(format!("Could not make a worktree: {e}")))?;
    let n = number.to_string();
    if let Err(e) = run(&dir, "gh", &["pr", "checkout", &n, "--branch", &branch]) {
        let _ = git(&root, &["worktree", "remove", "--force", &dir_str]);
        let _ = std::fs::remove_dir_all(&dir);
        return Err(if e.contains("not installed") {
            PrError::NotInstalled
        } else {
            PrError::failed(format!("gh could not check out the pull request: {e}"))
        });
    }
    let dir = canonical(&dir);
    let cwd = dir.to_string_lossy().into_owned();
    Ok(PrCheckout {
        branch,
        is_on_pull_request_head: head_sha.is_none() || head_matches(&dir, head_sha),
        worktree_path: Some(cwd.clone()),
        cwd,
        reused: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_same_repository_head_keeps_its_branch_name() {
        assert_eq!(local_branch_name(12, "feat/x", false), "feat/x");
    }

    #[test]
    fn a_fork_head_gets_a_namespaced_branch() {
        assert_eq!(local_branch_name(12, "main", true), "atlas/pr-12/main");
        assert_eq!(
            local_branch_name(7, "Feature/Some Thing!", true),
            "atlas/pr-7/feature/some-thing"
        );
        assert_eq!(local_branch_name(7, "---", true), "atlas/pr-7/update");
    }

    #[test]
    fn worktree_porcelain_reads_paths_and_branches() {
        let porcelain = "worktree /repo\nHEAD abc\nbranch refs/heads/main\n\nworktree /wt/a\nHEAD def\ndetached\n\nworktree /wt/b\nHEAD 123\nbranch refs/heads/feat/x\n";
        let parsed = parse_worktrees(porcelain);
        assert_eq!(
            parsed,
            vec![
                (PathBuf::from("/repo"), Some("main".into())),
                (PathBuf::from("/wt/a"), None),
                (PathBuf::from("/wt/b"), Some("feat/x".into())),
            ]
        );
    }

    #[test]
    fn the_checkout_slug_is_stable_and_distinguishes_clones() {
        let a = checkout_slug(Path::new("/Users/me/code/atlas"));
        let b = checkout_slug(Path::new("/Users/me/other/atlas"));
        assert!(a.starts_with("atlas-"));
        assert_ne!(a, b);
        assert_eq!(a, checkout_slug(Path::new("/Users/me/code/atlas")));
    }

    #[test]
    fn a_branch_checked_out_in_the_main_checkout_is_used_in_place() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let g = |args: &[&str]| git(&repo, args).unwrap();
        g(&["init", "-q", "-b", "feat"]);
        g(&[
            "-c",
            "user.name=a",
            "-c",
            "user.email=a@b",
            "commit",
            "-q",
            "--allow-empty",
            "-m",
            "x",
        ]);
        let sha = g(&["rev-parse", "HEAD"]);
        let out = prepare(&repo, &dir.path().join("wt"), 3, "feat", Some(&sha), false).unwrap();
        assert!(out.reused);
        assert_eq!(out.worktree_path, None);
        assert!(out.is_on_pull_request_head);
        assert_eq!(out.cwd, canonical(&repo).to_string_lossy());
    }

    #[test]
    fn a_branch_in_another_worktree_is_reused() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let g = |args: &[&str]| git(&repo, args).unwrap();
        g(&["init", "-q", "-b", "main"]);
        g(&[
            "-c",
            "user.name=a",
            "-c",
            "user.email=a@b",
            "commit",
            "-q",
            "--allow-empty",
            "-m",
            "x",
        ]);
        let linked = dir.path().join("linked");
        g(&[
            "worktree",
            "add",
            "-q",
            "-b",
            "feat",
            linked.to_str().unwrap(),
        ]);
        let sha = g(&["rev-parse", "HEAD"]);
        let out = prepare(&repo, &dir.path().join("wt"), 3, "feat", Some(&sha), false).unwrap();
        assert!(out.reused);
        assert_eq!(
            out.worktree_path.as_deref(),
            Some(canonical(&linked).to_str().unwrap())
        );
        // The main checkout stayed on its branch.
        assert_eq!(g(&["symbolic-ref", "--short", "HEAD"]), "main");
    }
}
