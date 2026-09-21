//! Git helpers shared by the integration tests, and by `src/git.rs`'s unit
//! tests, which include this file through `#[path]`.
//!
//! Every repository in these tests is driven with real git commands, and real
//! git reads the developer's global and system config. A `commit.gpgsign =
//! true` or a global `core.hooksPath` on the machine running the suite turns an
//! ordinary `git commit` into a signing prompt or a failed hook. So every
//! command built here sees no config but the repository's own, and never waits
//! on a terminal prompt.

// Each test binary uses a different subset of these.
#![allow(dead_code)]

use std::path::Path;
use std::process::Command;

/// A `git` command isolated from the global and system config.
pub fn git_command() -> Command {
    let mut cmd = Command::new("git");
    cmd.env(
        "GIT_CONFIG_GLOBAL",
        if cfg!(windows) { "NUL" } else { "/dev/null" },
    )
    .env("GIT_CONFIG_NOSYSTEM", "1")
    .env("GIT_TERMINAL_PROMPT", "0");
    cmd
}

/// `git -C <root> <args>`, asserted to succeed. Returns stdout.
pub fn git(root: &Path, args: &[&str]) -> String {
    let output = git_command()
        .arg("-C")
        .arg(root)
        .args(args)
        .output()
        .expect("git runs");
    assert!(
        output.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).into_owned()
}

/// A fresh repository on `main`. The identity is set locally because the
/// global config that would normally supply it is ignored.
pub fn init_repo(root: &Path) {
    git(root, &["init", "--initial-branch=main"]);
    git(root, &["config", "user.name", "Test Developer"]);
    git(root, &["config", "user.email", "dev@example.com"]);
}
