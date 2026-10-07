//! Shared memory reading the capture recorder (`atlas-checkpoint`,
//! `.atlas/sessions.db`). Read-only: every store is opened with
//! `capture::open_reader` and never written, so nothing memory holds can ride
//! capture's sync to an Organisation, and nothing from capture is stored in
//! `memory.sqlite`. The two records are joined by the agent's session id,
//! which both key a conversation by (pinned by
//! `a_memory_session_and_its_recorded_session_share_one_id`). Everything here
//! degrades to "nothing recorded" when capture is off, unreadable, or written
//! by a newer Atlas.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use atlas_checkpoint::{
    Checkpoint, FileTouch, LinkState, Session, Source, Store, TurnSpan, TurnState,
};
use atlas_memory::citation::{work_validity, CommitEvidence, Kept, Validity, MAX_FILE_BYTES};

/// Where memory looks for recorded sessions. `transcripts_dir` finds the
/// scope's subdirectory launches, as the recent-session handoff does; without
/// it only the launch directory and the repository's worktrees are read.
#[derive(Clone, Default)]
pub struct CaptureReader {
    pub transcripts_dir: Option<PathBuf>,
}

/// One scope's capture stores, opened for reading.
pub struct ScopeStores(Vec<(PathBuf, Store)>);

/// A recorded session, with the store and launch directory it lives in.
pub struct Recorded<'a> {
    pub root: &'a Path,
    pub store: &'a Store,
    pub session: Session,
}

impl CaptureReader {
    /// Every capture store in `cwd`'s scope. A root whose capture was never
    /// enabled, or whose store can't be read, is skipped. Reading never
    /// creates a store.
    pub fn stores(&self, cwd: &str) -> ScopeStores {
        let roots = crate::commands::memory_pack::scope_roots(cwd, self.transcripts_dir.as_deref());
        ScopeStores(
            roots
                .into_iter()
                .filter_map(|root| {
                    let store = crate::commands::capture::open_reader(&root.to_string_lossy())
                        .ok()
                        .flatten()?;
                    Some((root, store))
                })
                .collect(),
        )
    }
}

impl ScopeStores {
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// The recorded session memory knows as `session_id`: the same string
    /// capture files under `native_session_id`. Live capture keys it under
    /// `native` or `acp`; a session capture missed live may have been
    /// imported from its own transcript (`external_jsonl`). At most six
    /// lookups on the unique index per store.
    pub fn find(&self, session_id: &str) -> Option<Recorded<'_>> {
        if session_id.is_empty() {
            return None;
        }
        for (root, store) in &self.0 {
            for workspace in workspace_ids(root) {
                for source in [Source::Native, Source::Acp, Source::ExternalJsonl] {
                    let Ok(Some(row)) = store.session_id_for(&workspace, source, session_id) else {
                        continue;
                    };
                    if let Ok(Some(session)) = store.session(&row) {
                        return Some(Recorded {
                            root,
                            store,
                            session,
                        });
                    }
                }
            }
        }
        None
    }
}

/// The two spellings a store keys one Project by: live capture uses the
/// canonical path, the importer the path as given (`memory_pack::capture_heads`).
fn workspace_ids(root: &Path) -> Vec<String> {
    let mut ids = vec![crate::commands::capture::project_id_for(root)];
    let lexical = root.to_string_lossy().to_string();
    if !ids.contains(&lexical) {
        ids.push(lexical);
    }
    ids
}

/// Fill each source's title and commits from the session it names. A source
/// with no recorded session (capture off, an import, the user) is left as is.
pub fn resolve_sources(stores: &ScopeStores, sources: &mut [atlas_memory::record::Source]) {
    for source in sources.iter_mut() {
        let Some(found) = stores.find(&source.session) else {
            continue;
        };
        source.title.clone_from(&found.session.title);
        let mut checkpoints = found
            .store
            .checkpoints_for_session(&found.session.id)
            .unwrap_or_default();
        // An orphaned checkpoint's commit is gone; it is not "the commit this produced".
        checkpoints.retain(|c| c.link_state == LinkState::Linked);
        checkpoints.sort_by(|a, b| {
            b.created_at
                .cmp(&a.created_at)
                .then(a.commit_sha.cmp(&b.commit_sha))
        });
        source.commits = checkpoints
            .into_iter()
            .take(3)
            .map(|c| c.commit_sha.chars().take(12).collect())
            .collect();
    }
}

/// Sources as `memory_get`, `memory_history` and the panel show them.
pub fn provenance_json(sources: &[atlas_memory::record::Source]) -> serde_json::Value {
    serde_json::Value::Array(
        sources
            .iter()
            .map(|s| {
                serde_json::json!({
                    "source": atlas_memory::record::source_uri(s),
                    "agent": s.agent,
                    "added": chrono::DateTime::from_timestamp_millis(s.at)
                        .map(|d| d.format("%Y-%m-%d").to_string()),
                    "title": s.title,
                    "commits": s.commits,
                })
            })
            .collect(),
    )
}

/// The turn of a recorded session that was running at a moment.
pub enum TurnAt<'a> {
    None,
    One(&'a TurnSpan),
    /// Two turns overlap there (a queued prompt opened the next turn before
    /// the last one closed). Nothing is inferred from an ambiguous write.
    Ambiguous,
}

/// The turn running at `at_ms`. Both clocks are this machine's: capture
/// stamps a turn when its worker records the prompt and when the turn
/// finishes, memory stamps a write when it lands. An open turn runs on.
pub fn turn_at(spans: &[TurnSpan], at_ms: i64) -> TurnAt<'_> {
    let mut hits = spans.iter().filter(|t| {
        t.started_at.timestamp_millis() <= at_ms
            && t.ended_at.is_none_or(|e| at_ms <= e.timestamp_millis())
    });
    match (hits.next(), hits.next()) {
        (None, _) => TurnAt::None,
        (Some(t), None) => TurnAt::One(t),
        _ => TurnAt::Ambiguous,
    }
}

/// Work-evidence answers, reused while a file's size and mtime are unchanged.
#[derive(Default)]
pub struct KeptCache(std::sync::Mutex<HashMap<(PathBuf, u64, i128, String), Kept>>);

/// A memory's commit evidence and the validity it gives.
#[derive(Debug)]
pub struct WorkCheck {
    pub commits: Vec<CommitEvidence>,
    pub validity: Option<Validity>,
}

/// The commits that carried the work of the turn in which `found`'s session
/// wrote at `at_ms`, and whether that work is still in the tree. `None` when
/// the write falls in no single turn, the turn was taken back, it wrote no
/// file, or none of its files reached a commit (memory plan M3 Task 4b).
pub fn work_evidence(
    scope_root: &Path,
    found: &Recorded<'_>,
    at_ms: i64,
    cache: &KeptCache,
) -> Option<WorkCheck> {
    let spans = found.store.turn_spans(&found.session.id).ok()?;
    let TurnAt::One(turn) = turn_at(&spans, at_ms) else {
        return None;
    };
    if turn.state == TurnState::Rewound {
        return None;
    }
    let touches: Vec<FileTouch> = found
        .store
        .latest_file_touches(&found.session.id)
        .ok()?
        .into_iter()
        .filter(|t| t.turn_seq == turn.turn_seq && !t.out_of_repo)
        .collect();
    let checkpoints: Vec<Checkpoint> = found
        .store
        .checkpoints_for_session(&found.session.id)
        .ok()?
        .into_iter()
        .filter(|c| {
            c.files_touched
                .iter()
                .any(|f| touches.iter().any(|t| &t.path == f))
        })
        .collect();
    if checkpoints.is_empty() {
        return None;
    }
    let kept: Vec<Kept> = touches
        .iter()
        .filter(|t| {
            checkpoints
                .iter()
                .any(|c| c.files_touched.contains(&t.path))
        })
        .take(10)
        .map(|t| kept(scope_root, found.root, t, cache))
        .collect();
    let mut validity = work_validity(&kept);
    // A flagged capture may have lost touches: it cannot prove the work gone.
    if found.session.needs_attention && validity == Some(Validity::Stale) {
        validity = Some(Validity::Unverifiable);
    }
    let mut commits: Vec<CommitEvidence> = checkpoints
        .iter()
        .map(|c| CommitEvidence {
            sha: c.commit_sha.chars().take(12).collect(),
            orphaned: c.link_state == LinkState::Orphaned,
        })
        .collect();
    commits.sort_by(|a, b| a.sha.cmp(&b.sha));
    commits.dedup();
    commits.truncate(3);
    Some(WorkCheck { commits, validity })
}

/// Whether one landed file still holds the session's work: the agent's line
/// fingerprint against the file as it is now, in the scope root first and
/// then where the session ran. A deletion is kept while the file stays gone.
fn kept(scope_root: &Path, root: &Path, touch: &FileTouch, cache: &KeptCache) -> Kept {
    let repo_rel = match root.strip_prefix(scope_root) {
        Ok(sub) => sub.join(&touch.path),
        // A linked worktree: the same repository path.
        Err(_) => PathBuf::from(&touch.path),
    };
    let found = [scope_root.join(&repo_rel), root.join(&touch.path)]
        .into_iter()
        .find(|p| p.is_file());
    let path = match (found, touch.deleted) {
        (None, true) => return Kept::Yes,
        (Some(_), true) => return Kept::No,
        (None, false) if root.exists() => return Kept::No,
        // Its worktree is gone.
        (None, false) => return Kept::Unknown,
        (Some(path), false) => path,
    };
    let Some(agent) = touch.sketch_after.as_deref() else {
        return Kept::Unknown;
    };
    let Ok(meta) = std::fs::metadata(&path) else {
        return Kept::Unknown;
    };
    if meta.len() > MAX_FILE_BYTES {
        return Kept::Unknown;
    }
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_nanos() as i128);
    let key = (path.clone(), meta.len(), mtime, touch.id.clone());
    if let Some(hit) = cache
        .0
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .get(&key)
    {
        return *hit;
    }
    let answer = match std::fs::read(&path)
        .ok()
        .and_then(|b| atlas_checkpoint::sketch::sketch(&b))
    {
        Some(now) if atlas_checkpoint::sketch::retains_agent_work(agent, &now) => Kept::Yes,
        Some(_) => Kept::No,
        None => Kept::Unknown,
    };
    let mut seen = cache
        .0
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if seen.len() > 10_000 {
        seen.clear();
    }
    seen.insert(key, answer);
    answer
}

/// What a recorded session shows, for its handoff note and the dream (M4):
/// the files it wrote, the tool calls that failed, the commits it produced,
/// whether its last turn was cut off, and its branch and title.
pub fn session_facts(found: &Recorded<'_>) -> atlas_memory::handoff::SessionFacts {
    use atlas_memory::handoff::{CommitFact, SessionFacts};
    let (store, session) = (found.store, &found.session);
    let spans = store.turn_spans(&session.id).unwrap_or_default();
    let interrupted = spans
        .last()
        .is_some_and(|t| matches!(t.state, TurnState::Open | TurnState::Aborted));
    let rewound_turns = spans
        .iter()
        .filter(|t| t.state == TurnState::Rewound)
        .count() as u32;
    let files_written = store
        .written_paths(&session.id, atlas_memory::handoff::MAX_FILES as i64)
        .unwrap_or_default()
        .into_iter()
        .map(|(path, deleted)| {
            if deleted {
                format!("{path} (deleted)")
            } else {
                path
            }
        })
        .collect();
    let mut checkpoints = store
        .checkpoints_for_session(&session.id)
        .unwrap_or_default();
    checkpoints.sort_by(|a, b| {
        b.created_at
            .cmp(&a.created_at)
            .then(a.commit_sha.cmp(&b.commit_sha))
    });
    let commits = checkpoints
        .into_iter()
        .take(5)
        .map(|c| CommitFact {
            sha: c.commit_sha.chars().take(12).collect(),
            // Git owns the message; the record keeps none.
            subject: atlas_checkpoint::git::commit_info(found.root, &c.commit_sha)
                .ok()
                .map(|i| short(&safe(&i.subject), 80))
                .filter(|s| !s.is_empty()),
            branch: c.branch,
            orphaned: c.link_state == LinkState::Orphaned,
        })
        .collect();
    SessionFacts {
        title: session.title.as_deref().map(safe),
        branch: session.branch.clone(),
        files_written,
        failed_tools: fold_failures(store.failed_tool_calls(&session.id, 50).unwrap_or_default()),
        commits,
        interrupted,
        rewound_turns,
        incomplete: session.needs_attention,
    }
}

/// The stretches of time (ms) that only rewound turns of a session cover:
/// each rewound turn's span with every other turn's span cut out, so a
/// write that also falls inside a live turn is never demoted. An open span
/// runs to `now_ms`. Sorted.
pub fn rewound_windows(spans: &[TurnSpan], now_ms: i64) -> Vec<(i64, i64)> {
    let span = |t: &TurnSpan| {
        (
            t.started_at.timestamp_millis(),
            t.ended_at.map_or(now_ms, |e| e.timestamp_millis()),
        )
    };
    let live: Vec<(i64, i64)> = spans
        .iter()
        .filter(|t| t.state != TurnState::Rewound)
        .map(span)
        .collect();
    let mut out = Vec::new();
    for rewound in spans.iter().filter(|t| t.state == TurnState::Rewound) {
        let mut pieces = vec![span(rewound)];
        for (a, b) in &live {
            pieces = pieces
                .into_iter()
                .flat_map(|(x, y)| {
                    if *b < x || *a > y {
                        vec![(x, y)]
                    } else {
                        [(x, a - 1), (b + 1, y)]
                            .into_iter()
                            .filter(|(p, q)| p <= q)
                            .collect()
                    }
                })
                .collect();
        }
        out.extend(pieces);
    }
    out.sort_unstable();
    out
}

/// `session`'s rewound windows from its recorded turns; `None` when capture
/// never saw the session.
pub fn rewound_windows_for(
    reader: &CaptureReader,
    cwd: &str,
    session: &str,
    now_ms: i64,
) -> Option<Vec<(i64, i64)>> {
    let stores = reader.stores(cwd);
    let found = stores.find(session)?;
    let spans = found
        .store
        .turn_spans(&found.session.id)
        .unwrap_or_default();
    Some(rewound_windows(&spans, now_ms))
}

/// Text from the recorder, cleaned and redacted again: capture redacted it
/// on write, and memory serves no text its own redactor hasn't seen.
fn safe(s: &str) -> String {
    atlas_memory::record::redact(&atlas_memory::record::clean(s))
}

/// Failed calls folded by (tool, what was tried), most repeated first, then
/// newest; at most 8.
fn fold_failures(
    calls: Vec<atlas_checkpoint::FailedCall>,
) -> Vec<atlas_memory::handoff::FailedTool> {
    use atlas_memory::handoff::FailedTool;
    let mut out: Vec<FailedTool> = Vec::new();
    for call in calls {
        let command = call
            .arguments
            .as_deref()
            .and_then(|a| serde_json::from_str::<serde_json::Value>(a).ok())
            .and_then(|v| {
                v.get("command")
                    .and_then(|c| c.as_str())
                    .map(str::to_string)
            });
        let detail = command.or(call.title).unwrap_or_default();
        let detail = short(&safe(first_line(&detail)), 100);
        let error = call
            .result
            .as_deref()
            .map(first_line)
            .filter(|l| !l.is_empty())
            .map(|l| short(&safe(l), 120));
        let tool = call.tool_name.as_str().to_string();
        match out
            .iter_mut()
            .find(|f| f.tool == tool && f.detail == detail)
        {
            Some(seen) => seen.count += 1,
            None => out.push(FailedTool {
                tool,
                detail,
                error,
                count: 1,
            }),
        }
    }
    // Stable: equal counts keep newest first (the order the calls came in).
    out.sort_by(|a, b| b.count.cmp(&a.count));
    out.truncate(8);
    out
}

fn first_line(s: &str) -> &str {
    s.lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("")
}

fn short(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    s.chars().take(max).collect::<String>() + "…"
}

#[cfg(test)]
pub(crate) mod test_support {
    use std::path::Path;

    use atlas_checkpoint::model::ProjectMode;
    use atlas_checkpoint::{Capture, CheckpointInput, SessionKey, Source, Store};

    /// One recorded session, driven through the real capture recorder with
    /// one writing store held open: re-opening a writer store reconciles an
    /// open turn as aborted.
    pub(crate) struct Recording {
        pub(crate) store: Store,
        pub(crate) key: SessionKey,
        pub(crate) row: String,
        pub(crate) turn: i64,
        calls: u32,
    }

    impl Recording {
        /// Start session `native_id` of `agent` in `project`, and open turn 1.
        pub(crate) fn open_turn(project: &str, native_id: &str, agent: &str, prompt: &str) -> Self {
            let mut store =
                Store::open(atlas_checkpoint::atlas_dir(project)).expect("capture store opens");
            let key = SessionKey {
                workspace_id: crate::commands::capture::project_id_for(Path::new(project)),
                source: if agent == atlas_native_agent::ATLAS_AGENT_ID {
                    Source::Native
                } else {
                    Source::Acp
                },
                native_session_id: native_id.into(),
            };
            let row = Capture::new(&mut store, ProjectMode::Local)
                .record_prompt(&key, prompt, 1, Some(agent), None, Some(project))
                .expect("prompt recorded");
            Self {
                store,
                key,
                row,
                turn: 1,
                calls: 0,
            }
        }

        /// A failed shell call in the open turn, as live capture records it.
        pub(crate) fn fail(&mut self, command: &str, error: &str) {
            use atlas_checkpoint::tools::ToolName;
            use atlas_checkpoint::{ToolCallContent, ToolStatus};
            self.calls += 1;
            let native_call_id = format!("fail-{}-{}", self.turn, self.calls);
            let arguments = serde_json::json!({ "command": command }).to_string();
            Capture::new(&mut self.store, ProjectMode::Local)
                .record_tool_call(
                    &self.row,
                    ToolCallContent {
                        turn_seq: self.turn,
                        native_call_id: Some(&native_call_id),
                        tool_name: ToolName::Bash,
                        title: Some(command),
                        kind: Some("execute"),
                        status: ToolStatus::Failed,
                        locations: &serde_json::json!([]),
                        arguments: Some(&arguments),
                        result: Some(error.as_bytes()),
                    },
                )
                .expect("call recorded");
        }

        /// The agent took back the last `turns` turns (a retry).
        pub(crate) fn rewind(&mut self, turns: i64) {
            Capture::new(&mut self.store, ProjectMode::Local)
                .rewind_turns(&self.row, turns)
                .expect("turns rewound");
        }

        /// The next prompt of the same session: a new turn, left open.
        pub(crate) fn next_turn(&mut self, prompt: &str) {
            self.turn += 1;
            Capture::new(&mut self.store, ProjectMode::Local)
                .record_prompt(&self.key, prompt, self.turn, None, None, None)
                .expect("prompt recorded");
        }

        pub(crate) fn close_turn(&mut self) {
            Capture::new(&mut self.store, ProjectMode::Local)
                .finish_turn(&self.row, self.turn)
                .expect("turn closed");
        }

        /// A completed write of `path` (project-relative) in the open turn,
        /// with the hash and fingerprint live capture takes at write time.
        pub(crate) fn write(&mut self, path: &str, content: &[u8]) {
            use atlas_checkpoint::tools::{ResolvedPath, ToolName};
            use atlas_checkpoint::{FileWrite, ToolCallContent, ToolStatus};
            let native_call_id = format!("write-{}-{path}", self.turn);
            let mut capture = Capture::new(&mut self.store, ProjectMode::Local);
            let call = capture
                .record_tool_call(
                    &self.row,
                    ToolCallContent {
                        turn_seq: self.turn,
                        native_call_id: Some(&native_call_id),
                        tool_name: ToolName::Write,
                        title: None,
                        kind: Some("edit"),
                        status: ToolStatus::Completed,
                        locations: &serde_json::json!([]),
                        arguments: None,
                        result: None,
                    },
                )
                .expect("call recorded");
            let resolved = ResolvedPath {
                path: path.into(),
                out_of_repo: false,
            };
            capture
                .record_file_write(
                    &self.row,
                    &call,
                    self.turn,
                    FileWrite {
                        path: &resolved,
                        sha256_after: Some(atlas_checkpoint::hash_written_content(content)),
                        sketch_after: atlas_checkpoint::sketch::sketch(content),
                        existed_before: false,
                        deleted: false,
                    },
                )
                .expect("touch recorded");
        }

        /// A linked checkpoint of `sha` carrying `files`, as the commit walk writes it.
        pub(crate) fn commit(&mut self, sha: &str, files: &[&str]) {
            let files: Vec<String> = files.iter().map(|f| (*f).to_string()).collect();
            self.store
                .upsert_checkpoint(CheckpointInput {
                    session_id: &self.row,
                    commit_sha: sha,
                    patch_id: Some("patch"),
                    branch: Some("main"),
                    git_author_name: None,
                    git_author_email: None,
                    files_touched: &files,
                    insertions: 1,
                    deletions: 0,
                    sync_state: ProjectMode::Local.initial_sync_state(),
                })
                .expect("checkpoint recorded");
        }
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use atlas_checkpoint::model::ProjectMode;
    use atlas_checkpoint::Store;

    use super::*;
    use crate::commands::memory_pack::test_support::scratch_project;

    fn wait_for<T>(mut probe: impl FnMut() -> Option<T>) -> Option<T> {
        for _ in 0..50 {
            if let Some(found) = probe() {
                return Some(found);
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        None
    }

    /// Capture files a conversation under the id `agents_send` passes to
    /// `CaptureState::note_prompt`; memory under the id `AgentHost::bind`
    /// passes to `SessionLifecycle::session_started`, which a token is bound
    /// to. Both are the ACP session id string, for ACP agents and the native
    /// agent. The id memory's grant carries must find the recorded row.
    #[test]
    fn a_memory_session_and_its_recorded_session_share_one_id() {
        let p = scratch_project("same-id");
        {
            let store = Store::open(atlas_checkpoint::atlas_dir(&p)).unwrap();
            let id = crate::commands::capture::project_id_for(Path::new(&p));
            atlas_checkpoint::bind(&store, &id, Path::new(&p), ProjectMode::Local).unwrap();
        }
        let capture = crate::commands::capture::CaptureState::new();
        let tokens = crate::commands::memory_server::MemoryTokens::default();
        for (id, agent) in [
            ("acp-7f3e", "claude-code"),
            ("native-91aa", atlas_native_agent::ATLAS_AGENT_ID),
        ] {
            capture.note_prompt(id, &p, agent, None, "move auth to EdDSA");
            crate::commands::agent_host::SessionLifecycle::session_started(&tokens, id, agent, &p);
            let grant = tokens
                .grant_for_session(id)
                .expect("the session has a token");
            let found = wait_for(|| {
                CaptureReader::default()
                    .stores(&p)
                    .find(&grant.session_id)
                    .map(|r| r.session.native_session_id)
            });
            assert_eq!(found.as_deref(), Some(id), "{agent}");
        }
        let _ = std::fs::remove_dir_all(&p);
    }

    #[test]
    fn a_write_belongs_to_the_one_turn_running_then_and_overlaps_decide_nothing() {
        use atlas_checkpoint::{TurnSpan, TurnState};
        let at = |ms: i64| chrono::DateTime::from_timestamp_millis(ms).unwrap();
        let span = |turn, from, to: Option<i64>| TurnSpan {
            turn_seq: turn,
            state: TurnState::Completed,
            started_at: at(from),
            ended_at: to.map(at),
        };
        let spans = [
            span(1, 1_000, Some(2_000)),
            span(2, 1_900, Some(3_000)),
            span(3, 4_000, None),
        ];
        assert!(matches!(turn_at(&spans, 1_500), TurnAt::One(t) if t.turn_seq == 1));
        assert!(
            matches!(turn_at(&spans, 1_950), TurnAt::Ambiguous),
            "a queued prompt overlapped turn 1"
        );
        assert!(matches!(turn_at(&spans, 3_500), TurnAt::None));
        assert!(
            matches!(turn_at(&spans, 9_000), TurnAt::One(t) if t.turn_seq == 3),
            "an open turn runs on"
        );
    }

    #[test]
    fn rewound_windows_cut_out_every_live_turn() {
        use atlas_checkpoint::{TurnSpan, TurnState};
        let at = |ms: i64| chrono::DateTime::from_timestamp_millis(ms).unwrap();
        let span = |turn, state, from, to: Option<i64>| TurnSpan {
            turn_seq: turn,
            state,
            started_at: at(from),
            ended_at: to.map(at),
        };
        let spans = [
            span(1, TurnState::Completed, 1_000, Some(2_000)),
            // Opened by a queued prompt before turn 1 closed.
            span(2, TurnState::Rewound, 1_900, Some(3_000)),
            span(3, TurnState::Completed, 3_500, None),
        ];
        assert_eq!(rewound_windows(&spans, 9_000), [(2_001, 3_000)]);
        assert!(rewound_windows(&spans[..1], 9_000).is_empty());
    }

    /// End to end on a real capture store and a wall-clock memory store.
    #[test]
    fn writes_in_a_taken_back_turn_become_candidates() {
        use crate::commands::shared_memory::{SharedMemoryStore, Writer};
        use atlas_memory::record::{EntryKind, State};
        let p = scratch_project("rewound");
        let memory = SharedMemoryStore::new();
        let writer = Writer {
            agent: "atlas-agent".into(),
            session_id: "s-n".into(),
        };
        let mut rec =
            test_support::Recording::open_turn(&p, "s-n", "atlas-agent", "sign with HS256");
        let undone = memory
            .remember(
                &p,
                &writer,
                EntryKind::Decision,
                "Sign JWTs with HS256",
                "",
                None,
                &[],
            )
            .unwrap()
            .entry;
        rec.close_turn();
        rec.rewind(1);
        rec.next_turn("sign with EdDSA");
        let kept = memory
            .remember(
                &p,
                &writer,
                EntryKind::Decision,
                "Sign JWTs with EdDSA",
                "",
                None,
                &[],
            )
            .unwrap()
            .entry;
        rec.close_turn();
        drop(rec);
        let now = memory.now();
        let windows =
            rewound_windows_for(&CaptureReader::default(), &p, "s-n", now).expect("recorded");
        assert_eq!(memory.demote_rewound(&p, "s-n", &windows).unwrap(), 1);
        let state = |id| memory.get_entry(&p, id).unwrap().unwrap().state;
        assert_eq!(state(undone.id), State::Candidate);
        assert_eq!(state(kept.id), State::Active);
        let _ = std::fs::remove_dir_all(&p);
    }

    #[test]
    fn without_capture_nothing_is_found_and_no_store_is_created() {
        let p = scratch_project("no-capture");
        assert!(CaptureReader::default().stores(&p).find("s-a").is_none());
        assert!(
            !atlas_checkpoint::atlas_dir(&p).join("sessions.db").exists(),
            "a read must not plant a store"
        );
        let _ = std::fs::remove_dir_all(&p);
    }
}
