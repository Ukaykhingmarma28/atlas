//! What a row is.
//!
//! The one thing to keep in mind reading this file: a row is
//! **metadata only**. There is no message, no chunk, no tool call and no token
//! anywhere in it. Replaying a conversation is the agent's job, through
//! `session/load`; this store only knows enough to list the thread and route
//! the click.

use std::path::Path;
use std::str::FromStr;
use std::sync::Arc;

use agent_client_protocol::schema::v1 as acp;
use atlas_acp_thread::connection::{AgentId, AgentSessionInfo};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::paths::{PathList, WorktreePaths};

/// The default shown for a thread nobody has titled yet.
pub const DEFAULT_THREAD_TITLE: &str = "New Thread";

/// Atlas's own id for a conversation.
///
/// Minted by Atlas, never by an agent, and never reused: it is what lets a
/// thread exist *before* any agent session does (a draft) and survive an agent
/// forgetting its session afterwards.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug, Serialize, Deserialize)]
pub struct ThreadId(uuid::Uuid);

impl ThreadId {
    #[allow(clippy::new_without_default)]
    pub fn new() -> Self {
        Self(uuid::Uuid::new_v4())
    }

    pub fn from_uuid(uuid: uuid::Uuid) -> Self {
        Self(uuid)
    }

    pub fn as_uuid(&self) -> &uuid::Uuid {
        &self.0
    }

    /// Stable, hyphenated string form, suitable as a key on the wire.
    pub fn to_key_string(&self) -> String {
        self.0.hyphenated().to_string()
    }
}

impl std::fmt::Display for ThreadId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.hyphenated().fmt(f)
    }
}

impl FromStr for ThreadId {
    type Err = uuid::Error;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Ok(Self(uuid::Uuid::parse_str(s)?))
    }
}

/// Which slice of the store a query wants.
///
/// There is no
/// `ActiveOnly` because the sidebar's active list is a *path-grouped* query,
/// not a flat one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ThreadFilter {
    /// Everything, archived or not — what the history view shows.
    #[default]
    All,
    /// Only archived threads.
    ArchivedOnly,
}

/// One thread, as the sidebar and the history view need to know it.
#[derive(Debug, Clone, PartialEq)]
pub struct ThreadMetadata {
    pub thread_id: ThreadId,
    /// `None` while the thread is a draft — no agent session exists yet.
    pub session_id: Option<acp::SessionId>,
    pub agent_id: AgentId,
    /// The agent's own title for the thread, if it has produced one.
    pub title: Option<Arc<str>>,
    /// The user's rename. Beats [`ThreadMetadata::title`] so that a later
    /// agent-generated title never clobbers a name the user chose.
    pub title_override: Option<Arc<str>>,
    pub updated_at: DateTime<Utc>,
    pub created_at: Option<DateTime<Utc>>,
    /// When the user last sent (or queued) a message. Distinct from
    /// `updated_at`, which also moves for agent-side activity.
    pub interacted_at: Option<DateTime<Utc>>,
    pub worktree_paths: WorktreePaths,
    /// The remote-connection slot the spec calls for (issue #15: "…archived
    /// flag, remote-connection slot"; ADR-0001). It would hold the
    /// connection options and filter sidebar queries by them. Atlas has no remote connections yet, so the column round-trips and
    /// nothing reads it — the row shape is the one the spec fixed, rather than
    /// one needing a migration the day Atlas grows them.
    pub remote_connection: Option<serde_json::Value>,
    /// The git branch the thread's working directory was on the last time
    /// Atlas looked — when the thread was bound and at each turn start.
    /// `None` is "not known": a detached HEAD, a folder outside any
    /// repository, or a row older than the column. Never guessed.
    pub branch: Option<Arc<str>>,
    pub archived: bool,
    /// When the session was settled: done for now, moved to the sidebar's
    /// Settled shelf, still listed and still resumable. `None` is active.
    /// Settling is not archiving — an archived row leaves the sidebar, a
    /// settled one only sinks to the bottom of it.
    pub settled_at: Option<DateTime<Utc>>,
    /// When the user last un-settled the session. Auto-settle leaves a row
    /// alone while this is after its last activity: the user said "not done",
    /// and nothing has happened since that could change their mind.
    pub unsettled_at: Option<DateTime<Utc>>,
}

impl ThreadMetadata {
    /// A new thread for `agent_id` rooted at `folder_paths`, as a draft.
    ///
    /// `created_at`, `updated_at` and `interacted_at` all start at now; the
    /// thread gets its session id when its first message is sent.
    pub fn new(thread_id: ThreadId, agent_id: AgentId, folder_paths: PathList) -> Self {
        let now = Utc::now();
        Self {
            thread_id,
            session_id: None,
            agent_id,
            title: None,
            title_override: None,
            updated_at: now,
            created_at: Some(now),
            interacted_at: Some(now),
            worktree_paths: WorktreePaths::from_folder_paths(&folder_paths),
            remote_connection: None,
            branch: None,
            archived: false,
            settled_at: None,
            unsettled_at: None,
        }
    }

    /// A thread is a draft until its first message is sent, at which point it
    /// gets an ACP session id (`thread_metadata_store.rs:328-333`).
    pub fn is_draft(&self) -> bool {
        self.session_id.is_none()
    }

    /// The title to show: the user's rename, else the agent's, else the
    /// default (`:335-342`).
    pub fn display_title(&self) -> Arc<str> {
        self.title()
            .unwrap_or_else(|| Arc::from(DEFAULT_THREAD_TITLE))
    }

    /// Whether the session sits on the Settled shelf.
    pub fn is_settled(&self) -> bool {
        self.settled_at.is_some()
    }

    /// The last thing that happened in the session: agent or outside activity
    /// (`updated_at`) or the user sending (`interacted_at`), whichever is
    /// later. What "idle" is measured from.
    pub fn last_activity(&self) -> DateTime<Utc> {
        self.interacted_at
            .map_or(self.updated_at, |at| at.max(self.updated_at))
    }

    pub fn title(&self) -> Option<Arc<str>> {
        self.title_override.clone().or_else(|| self.title.clone())
    }

    pub fn folder_paths(&self) -> &PathList {
        self.worktree_paths.folder_path_list()
    }

    pub fn main_worktree_paths(&self) -> &PathList {
        self.worktree_paths.main_worktree_path_list()
    }

    pub fn references_folder_path(&self, path: &Path) -> bool {
        self.folder_paths().contains(path)
    }
}

/// A row, presented the way `session/list` results are.
///
/// A draft has no session id, so its
/// thread id stands in — the value is never sent to an agent, it only has to
/// be unique among the rows being rendered.
impl From<&ThreadMetadata> for AgentSessionInfo {
    fn from(meta: &ThreadMetadata) -> Self {
        let session_id = meta
            .session_id
            .clone()
            .unwrap_or_else(|| acp::SessionId::new(meta.thread_id.to_key_string()));
        Self {
            session_id,
            work_dirs: Some(meta.folder_paths().paths().to_vec()),
            title: meta.title(),
            updated_at: Some(meta.updated_at),
            created_at: meta.created_at,
            meta: None,
        }
    }
}
