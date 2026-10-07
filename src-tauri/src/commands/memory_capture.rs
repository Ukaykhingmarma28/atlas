//! Shared memory reading the capture recorder (`atlas-checkpoint`,
//! `.atlas/sessions.db`). Read-only: every store is opened with
//! `capture::open_reader` and never written, so nothing memory holds can ride
//! capture's sync to an Organisation, and nothing from capture is stored in
//! `memory.sqlite`. The two records are joined by the agent's session id,
//! which both key a conversation by (pinned by
//! `a_memory_session_and_its_recorded_session_share_one_id`). Everything here
//! degrades to "nothing recorded" when capture is off, unreadable, or written
//! by a newer Atlas.

use std::path::{Path, PathBuf};

use atlas_checkpoint::{LinkState, Session, Source, Store};

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
            }
        }

        pub(crate) fn close_turn(&mut self) {
            Capture::new(&mut self.store, ProjectMode::Local)
                .finish_turn(&self.row, self.turn)
                .expect("turn closed");
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
