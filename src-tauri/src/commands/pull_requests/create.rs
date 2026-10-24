//! Opening a pull request for the checkout's current branch: `gh pr create`,
//! under the user's own `gh` login, and the title and body it starts from.
//!
//! The flow is the session context overlay's "Create PR": the frontend pushes
//! the branch first (through the git store, which owns push and publish), then
//! asks [`pr_create_draft`] for a title and body to show, then calls
//! [`pr_create`] with what the user kept. `gh` picks the host from the
//! remote; Atlas never holds a token.
//!
//! The prefill is what `gh pr create --fill` would write, computed here so the
//! user sees it before anything is opened: one commit ahead of the base gives
//! that commit's subject and body; several give the branch name as the title
//! and the commit subjects as a list.

use std::ffi::OsStr;
use std::path::Path;
use std::process::Stdio;

use serde::{Deserialize, Serialize};
use tokio::io::AsyncWriteExt;

use super::gh::{classify_no_response, PR_PERMITS, WRITE_TIMEOUT};
use super::model::PrError;

/// How many commits the prefill lists before it stops.
const MAX_LISTED_COMMITS: usize = 50;

/// What the user confirmed in the Create PR dialog.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrCreateInput {
    pub title: String,
    pub body: String,
    /// The branch to merge into; `None` lets `gh` use the repository default.
    pub base: Option<String>,
    pub draft: bool,
}

/// The pull request `gh` opened.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrCreated {
    pub number: u64,
    pub url: String,
}

/// A starting title and body for the current branch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrCreateDraft {
    /// The current branch; `None` on a detached HEAD, where nothing can be opened.
    pub head_branch: Option<String>,
    /// The remote's default branch, when the remote names one.
    pub base_branch: Option<String>,
    pub title: String,
    pub body: String,
    /// Commits on the branch that the base does not have.
    pub commit_count: u32,
}

/// The title and body a new pull request for the current branch starts from.
#[tauri::command]
pub async fn pr_create_draft(path: String) -> Result<PrCreateDraft, PrError> {
    let path = super::checkout(&path)?.to_string();
    tokio::task::spawn_blocking(move || draft_for(Path::new(&path)))
        .await
        .map_err(|e| PrError::failed(e.to_string()))
}

/// Open a pull request for the current branch. The branch must already be on
/// the remote; the overlay pushes it first. `sessionId`, the live session the
/// overlay belongs to, has the new pull request linked to it as `created`.
#[tauri::command]
pub async fn pr_create(
    path: String,
    input: PrCreateInput,
    session_id: Option<String>,
    host: tauri::State<'_, std::sync::Arc<crate::commands::agent_host::AgentHost>>,
) -> Result<PrCreated, PrError> {
    let cwd = super::checkout(&path)?.to_string();
    let title = input.title.trim();
    if title.is_empty() {
        return Err(PrError::invalid("A pull request needs a title."));
    }
    let head = {
        let cwd = cwd.clone();
        tokio::task::spawn_blocking(move || current_branch(Path::new(&cwd)))
            .await
            .map_err(|e| PrError::failed(e.to_string()))?
    }
    .ok_or_else(|| PrError::invalid("A pull request cannot be opened from a detached HEAD."))?;
    let args = create_args(title, &head, &input);
    let _permit = PR_PERMITS
        .acquire()
        .await
        .map_err(|e| PrError::failed(e.to_string()))?;
    let out = run_gh(OsStr::new("gh"), &cwd, &args, input.body.as_bytes()).await?;
    let created = parse_created(&out).ok_or_else(|| {
        PrError::failed("gh opened the pull request but did not say where it is.")
    })?;
    // Opened from a session: it is that session's pull request from now on.
    if let Some(session_id) = session_id.as_deref().filter(|s| !s.is_empty()) {
        crate::commands::session_pull_requests::record_created(
            host.inner(),
            session_id,
            &created.url,
            created.number,
            title,
            &head,
            input.base.as_deref(),
            input.draft,
        );
    }
    Ok(created)
}

/// `gh pr create`'s arguments. The body goes on stdin (`--body-file -`), so
/// a long one never meets an argument-length limit or a shell.
fn create_args(title: &str, head: &str, input: &PrCreateInput) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "pr".into(),
        "create".into(),
        "--title".into(),
        title.into(),
        "--body-file".into(),
        "-".into(),
        "--head".into(),
        head.into(),
    ];
    if let Some(base) = input
        .base
        .as_deref()
        .map(str::trim)
        .filter(|b| !b.is_empty())
    {
        args.push("--base".into());
        args.push(base.into());
    }
    if input.draft {
        args.push("--draft".into());
    }
    args
}

async fn run_gh(
    program: &OsStr,
    cwd: &str,
    args: &[String],
    stdin: &[u8],
) -> Result<String, PrError> {
    if !Path::new(cwd).is_dir() {
        return Err(classify_no_response(None, "not a git repository"));
    }
    let mut cmd = atlas_process::async_command(program);
    cmd.args(args)
        .current_dir(cwd)
        .env("GH_PROMPT_DISABLED", "1")
        .env("GH_NO_UPDATE_NOTIFIER", "1")
        .env("NO_COLOR", "1")
        .env("GH_PAGER", "")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err(PrError::NotInstalled),
        Err(e) => return Err(PrError::failed(e.to_string())),
    };
    let pipe = child.stdin.take();
    let body = stdin.to_vec();
    let work = async move {
        if let Some(mut pipe) = pipe {
            let _ = pipe.write_all(&body).await;
            drop(pipe);
        }
        child.wait_with_output().await
    };
    let output = match tokio::time::timeout(WRITE_TIMEOUT, work).await {
        Ok(Ok(output)) => output,
        Ok(Err(e)) => return Err(PrError::failed(e.to_string())),
        Err(_) => {
            return Err(PrError::failed(
                "gh took too long to open the pull request.",
            ))
        }
    };
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        // `gh` says plainly when the branch already has one; that is the
        // user's answer, not a network failure.
        if let Some(line) = stderr.lines().find(|l| l.contains("already exists")) {
            return Err(PrError::invalid(
                line.trim().trim_start_matches("gh: ").to_string(),
            ));
        }
        return Err(classify_no_response(output.status.code(), &stderr));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// The URL `gh pr create` prints last, and the number at its end.
fn parse_created(stdout: &str) -> Option<PrCreated> {
    let url = stdout
        .lines()
        .map(str::trim)
        .rev()
        .find(|l| l.starts_with("https://") && l.contains("/pull/"))?;
    let number = url.rsplit('/').next()?.parse().ok()?;
    Some(PrCreated {
        number,
        url: url.to_string(),
    })
}

fn git(cwd: &Path, args: &[&str]) -> Option<String> {
    let out = atlas_process::command("git")
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn current_branch(cwd: &Path) -> Option<String> {
    git(cwd, &["symbolic-ref", "--quiet", "--short", "HEAD"]).filter(|b| !b.is_empty())
}

fn draft_for(cwd: &Path) -> PrCreateDraft {
    let head = current_branch(cwd);
    // `origin/HEAD` names the remote's default branch when the clone recorded it.
    let base_ref = git(
        cwd,
        &[
            "symbolic-ref",
            "--quiet",
            "--short",
            "refs/remotes/origin/HEAD",
        ],
    )
    .filter(|r| !r.is_empty());
    let base_branch = base_ref
        .as_deref()
        .map(|r| r.strip_prefix("origin/").unwrap_or(r).to_string());
    let commits: Vec<(String, String)> = base_ref
        .as_deref()
        .and_then(|base| {
            git(
                cwd,
                &[
                    "log",
                    "--reverse",
                    "--format=%s%x1f%b%x1e",
                    &format!("{base}..HEAD"),
                ],
            )
        })
        .map(|log| parse_log(&log))
        .unwrap_or_default();
    let (title, body) = prefill(head.as_deref(), &commits);
    PrCreateDraft {
        head_branch: head,
        base_branch,
        title,
        body,
        commit_count: u32::try_from(commits.len()).unwrap_or(u32::MAX),
    }
}

/// `subject \x1f body \x1e` records, oldest first.
fn parse_log(log: &str) -> Vec<(String, String)> {
    log.split('\u{1e}')
        .filter_map(|record| {
            let record = record.trim_matches(['\n', '\r']);
            if record.trim().is_empty() {
                return None;
            }
            let (subject, body) = record.split_once('\u{1f}').unwrap_or((record, ""));
            Some((subject.trim().to_string(), body.trim().to_string()))
        })
        .collect()
}

/// `gh pr create --fill`'s rule: one commit gives its own subject and body;
/// otherwise the branch, humanised, is the title and the subjects are the body.
fn prefill(head: Option<&str>, commits: &[(String, String)]) -> (String, String) {
    if let [(subject, body)] = commits {
        return (subject.clone(), body.clone());
    }
    let title = head.map(humanize_branch).unwrap_or_default();
    let body = commits
        .iter()
        .take(MAX_LISTED_COMMITS)
        .map(|(subject, _)| format!("- {subject}"))
        .collect::<Vec<_>>()
        .join("\n");
    (title, body)
}

/// `uzayer/session-context_overlay` → `Session context overlay`.
fn humanize_branch(branch: &str) -> String {
    let leaf = branch.rsplit('/').next().unwrap_or(branch);
    let words = leaf.replace(['-', '_'], " ");
    let words = words.trim();
    let mut chars = words.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_url_gh_prints_is_read_back_with_its_number() {
        let out = "Warning: 2 uncommitted changes\nhttps://github.com/acme/app/pull/415\n";
        assert_eq!(
            parse_created(out),
            Some(PrCreated {
                number: 415,
                url: "https://github.com/acme/app/pull/415".into()
            })
        );
        assert_eq!(parse_created("nothing useful"), None);
    }

    #[test]
    fn the_arguments_carry_base_and_draft_only_when_asked() {
        let input = PrCreateInput {
            title: "t".into(),
            body: "b".into(),
            base: Some("  ".into()),
            draft: false,
        };
        assert_eq!(
            create_args("t", "feat", &input),
            [
                "pr",
                "create",
                "--title",
                "t",
                "--body-file",
                "-",
                "--head",
                "feat"
            ]
        );
        let input = PrCreateInput {
            base: Some("main".into()),
            draft: true,
            ..input
        };
        assert!(create_args("t", "feat", &input).ends_with(&[
            "--base".to_string(),
            "main".to_string(),
            "--draft".to_string()
        ]));
    }

    #[test]
    fn one_commit_fills_from_itself_and_several_from_the_branch() {
        let one = parse_log("Add the overlay\u{1f}Body line\n\u{1e}\n");
        assert_eq!(
            prefill(Some("u/x"), &one),
            ("Add the overlay".to_string(), "Body line".to_string())
        );
        let many = parse_log("First\u{1f}\u{1e}\nSecond\u{1f}more\u{1e}\n");
        assert_eq!(
            prefill(Some("uzayer/session-context_overlay"), &many),
            (
                "Session context overlay".to_string(),
                "- First\n- Second".to_string()
            )
        );
        assert_eq!(prefill(None, &[]), (String::new(), String::new()));
    }
}
