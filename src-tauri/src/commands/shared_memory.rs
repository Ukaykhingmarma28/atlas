//! Shared Cross-Agent Memory — the Tauri face of the record store.
//!
//! Every agent on a repository (Claude, Codex, the native agent, …) is a
//! separate subprocess with its own context window; shared memory is the
//! record they all read and write through this backend. The record itself —
//! events, entries, sessions in one SQLite database per scope — is
//! `atlas_memory::record`. This module:
//!
//! - resolves a launch directory to its **scope** (the repository's main
//!   worktree, or the directory itself outside git) and opens that scope's
//!   store once per process, migrating every legacy per-directory store of the
//!   scope into it on first open (`record::legacy`);
//! - keeps the session → (cwd, agent) routing map the capture hot path uses;
//! - serves the five Shared-tab commands with the exact request and response
//!   shapes the JSONL event log had (`shared_memory_contract.rs` pins them).
//!
//! Design invariants carried over from the JSONL store:
//! - **Single backend writer.** One Tauri backend owns every agent subprocess
//!   and is the sole writer; `record::open_scope` hands out one mutex-guarded
//!   connection per scope, so concurrency is a lock, not cross-process
//!   coordination.
//! - **Typed events, not raw transcript.** Capture (`super::memory_delta`)
//!   classifies ACP deltas into `EventKind`s; raw turns stay session-local.
//! - **Supersession at write time.** A newer decision on the same `key`
//!   replaces the old one; the per-kind caps are display limits only.
//!
//! Every method may touch disk. Commands run it on the blocking pool; the
//! capture path already runs off the delta thread.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use atlas_memory::record::{self, Entry, EntryKind, NewEvent, Origin, RecordStore};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::State;

pub use atlas_memory::record::EventKind;

// ── Event model ──────────────────────────────────────────────────────────────

/// A new event as handed to [`SharedMemoryStore::append_event`]. `seq`/`ts` are
/// assigned by the store, so the caller only describes the *content*.
#[derive(Debug, Clone)]
pub struct RawEvent {
    pub agent: String,
    pub session_id: String,
    pub kind: EventKind,
    /// Stable key for supersession/dedup (e.g. `"plan"`, a decision topic, a
    /// file path). Empty string = no dedup key (always appended).
    pub key: String,
    pub payload: serde_json::Value,
}

/// A persisted event. Returned by the event list and queries.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryEvent {
    pub seq: u64,
    pub ts: i64,
    pub agent: String,
    pub session_id: String,
    pub kind: EventKind,
    #[serde(default)]
    pub key: String,
    pub payload: serde_json::Value,
}

impl From<record::EventRow> for MemoryEvent {
    fn from(e: record::EventRow) -> Self {
        Self {
            seq: e.seq,
            ts: e.ts,
            agent: e.agent,
            session_id: e.session_id,
            kind: EventKind::parse(&e.kind),
            key: e.key,
            payload: e.payload,
        }
    }
}

// ── Derived state view ───────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanView {
    pub seq: u64,
    pub agent: String,
    pub text: String,
    #[serde(default = "default_active")]
    pub status: String,
}

fn default_active() -> String {
    "active".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DecisionView {
    pub seq: u64,
    pub agent: String,
    pub key: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeView {
    pub seq: u64,
    pub agent: String,
    pub path: String,
    pub summary: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FactView {
    pub seq: u64,
    pub agent: String,
    pub text: String,
}

/// The "current truth" summary: the active plan and the newest entries of each
/// kind, capped for display (storage keeps everything).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedState {
    pub last_seq: u64,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub active_plan: Option<PlanView>,
    #[serde(default)]
    pub decisions: Vec<DecisionView>,
    #[serde(default)]
    pub recent_changes: Vec<ChangeView>,
    #[serde(default)]
    pub facts: Vec<FactView>,
    #[serde(default)]
    pub failures: Vec<FactView>,
    #[serde(default)]
    pub architecture: Vec<FactView>,
    #[serde(default)]
    pub session_agents: HashMap<String, String>,
    #[serde(default)]
    pub updated_at: i64,
}

fn fact_view(e: Entry) -> FactView {
    FactView {
        seq: e.seq.unwrap_or(0),
        agent: e.agent,
        text: e.content,
    }
}

/// Build the summary view from the record. Only entries folded from the event
/// log are shown here, as before: memdir imports (and, later, direct writes)
/// live in the same record but reach agents through their own paths.
fn read_state(store: &RecordStore) -> anyhow::Result<SharedState> {
    let list = |kind, cap| store.list(kind, cap, Origin::EventLog);
    let (last_seq, updated_at) = store.last_event()?.unwrap_or((0, 0));
    Ok(SharedState {
        last_seq,
        active_plan: list(EntryKind::Plan, 1)?.pop().map(|e| PlanView {
            seq: e.seq.unwrap_or(0),
            agent: e.agent,
            text: e.content,
            status: e.status,
        }),
        decisions: list(EntryKind::Decision, record::CAP_DECISIONS)?
            .into_iter()
            .map(|e| DecisionView {
                seq: e.seq.unwrap_or(0),
                agent: e.agent,
                key: e.key,
                text: e.content,
            })
            .collect(),
        recent_changes: list(EntryKind::FileChanged, record::CAP_FILES_CHANGED)?
            .into_iter()
            .map(|e| ChangeView {
                seq: e.seq.unwrap_or(0),
                agent: e.agent,
                path: e.key,
                summary: e.content,
            })
            .collect(),
        facts: list(EntryKind::Fact, record::CAP_FACTS)?.into_iter().map(fact_view).collect(),
        failures: list(EntryKind::Failure, record::CAP_FAILURES)?.into_iter().map(fact_view).collect(),
        architecture: list(EntryKind::Architecture, record::CAP_ARCHITECTURE)?
            .into_iter()
            .map(fact_view)
            .collect(),
        session_agents: store
            .sessions()?
            .into_iter()
            .filter(|s| s.started_at.is_some())
            .map(|s| (s.session_id, s.agent))
            .collect(),
        updated_at,
    })
}

// ── Scope ────────────────────────────────────────────────────────────────────

/// The record store for a launch directory: resolved to its scope root, opened
/// once per process, with every legacy store of the scope migrated in on the
/// first open (the scope root, every worktree git knows of, and the launch
/// directory itself — a subdirectory launch had its own store too).
pub fn store_for(project_path: &str) -> Result<Arc<RecordStore>, String> {
    static OPENED: OnceLock<Mutex<HashMap<String, Arc<RecordStore>>>> = OnceLock::new();
    let opened = OPENED.get_or_init(|| Mutex::new(HashMap::new()));
    let mut opened = opened.lock();
    if let Some(store) = opened.get(project_path) {
        return Ok(store.clone());
    }
    let dir = Path::new(project_path);
    let root = atlas_checkpoint::git::scope_root(dir);
    let store = record::open_scope(&root).map_err(|e| format!("{e:#}"))?;

    let mut sources: Vec<PathBuf> = vec![root.clone()];
    sources.extend(atlas_checkpoint::git::worktree_paths(dir));
    sources.push(dir.to_path_buf());
    let mut seen = std::collections::HashSet::new();
    for source in sources {
        let key = source.canonicalize().unwrap_or_else(|_| source.clone());
        if !seen.insert(key) {
            continue;
        }
        match store.migrate_legacy(&source) {
            Ok(record::legacy::MigrationOutcome::Migrated { events, memories }) => tracing::info!(
                target: "atlas::shared_memory",
                "migrated {events} events and {memories} memories from {} into {}",
                source.display(),
                root.display()
            ),
            Ok(_) => {}
            Err(e) => tracing::warn!(
                target: "atlas::shared_memory",
                "legacy migration from {} failed: {e:#}",
                source.display()
            ),
        }
    }
    opened.insert(project_path.to_string(), store.clone());
    Ok(store)
}

/// The durable entries the summary view shows (decisions, failures,
/// architecture, facts — in that order, each capped as displayed), plus the
/// record's last-update time. Feeds the retrieval corpus; ids are entry ids.
pub fn durable_entries(project_path: &str) -> (i64, Vec<Entry>) {
    let Ok(store) = store_for(project_path) else {
        return (0, Vec::new());
    };
    let updated_at = store.last_event().ok().flatten().map_or(0, |(_, ts)| ts);
    let mut out = Vec::new();
    for (kind, cap) in [
        (EntryKind::Decision, record::CAP_DECISIONS),
        (EntryKind::Failure, record::CAP_FAILURES),
        (EntryKind::Architecture, record::CAP_ARCHITECTURE),
        (EntryKind::Fact, record::CAP_FACTS),
    ] {
        out.extend(store.list(kind, cap, Origin::EventLog).unwrap_or_default());
    }
    (updated_at, out)
}

// ── Session routing metadata ─────────────────────────────────────────────────

/// Maps a live ACP `session_id` → its project cwd + agent label, so the
/// `DeltaSink::emit` hot path can route a capture without a manager snapshot.
#[derive(Debug, Clone)]
pub struct SessionMeta {
    pub cwd: String,
    pub agent: String,
}

// ── Store ────────────────────────────────────────────────────────────────────

/// Millisecond wall clock used to stamp events.
pub type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;

struct Inner {
    /// cwd → project id cache.
    id_cache: Mutex<HashMap<String, String>>,
    /// session_id → routing metadata (populated by `agents_send`).
    sessions: Mutex<HashMap<String, SessionMeta>>,
    /// Wall clock for event timestamps (ms). Injectable so the command
    /// contract can be pinned byte-for-byte in tests.
    clock: Clock,
}

/// Cheaply-cloneable handle to shared memory (Arc inside, like
/// `AgentManager`). Registered once via `.manage()`.
#[derive(Clone)]
pub struct SharedMemoryStore {
    inner: Arc<Inner>,
}

impl Default for SharedMemoryStore {
    fn default() -> Self {
        Self::new()
    }
}

impl SharedMemoryStore {
    pub fn new() -> Self {
        Self::with_clock(Arc::new(now_ms))
    }

    /// A store whose event timestamps come from `clock` instead of the system
    /// time.
    pub fn with_clock(clock: Clock) -> Self {
        Self {
            inner: Arc::new(Inner {
                id_cache: Mutex::new(HashMap::new()),
                sessions: Mutex::new(HashMap::new()),
                clock,
            }),
        }
    }

    // ── Session routing ──────────────────────────────────────────────────────

    /// Register a live session's cwd + agent so captures can be routed. Called
    /// from `agents_send` (which already resolves cwd). Idempotent.
    pub fn register_session(&self, session_id: &str, cwd: &str, agent: &str) {
        if cwd.is_empty() {
            return;
        }
        self.inner.sessions.lock().insert(
            session_id.to_string(),
            SessionMeta {
                cwd: cwd.to_string(),
                agent: agent.to_string(),
            },
        );
    }

    pub fn session_meta(&self, session_id: &str) -> Option<SessionMeta> {
        self.inner.sessions.lock().get(session_id).cloned()
    }

    // ── Project id ───────────────────────────────────────────────────────────

    /// Stable per-project id = first 12 hex of sha256(canonical cwd). Path
    /// variants (trailing slash) converge to one id.
    pub fn project_id_for(&self, cwd: &str) -> String {
        if let Some(id) = self.inner.id_cache.lock().get(cwd) {
            return id.clone();
        }
        let canonical = cwd.trim_end_matches('/');
        let digest = Sha256::digest(canonical.as_bytes());
        let id: String = digest.iter().take(6).map(|b| format!("{b:02x}")).collect();
        self.inner
            .id_cache
            .lock()
            .insert(cwd.to_string(), id.clone());
        id
    }

    /// Write `.atlas/project.json` if absent. Best-effort.
    fn ensure_project_file(&self, project_path: &str) {
        let path = Path::new(project_path).join(".atlas").join("project.json");
        if path.exists() {
            return;
        }
        let id = self.project_id_for(project_path);
        let payload = serde_json::json!({ "projectId": id }).to_string();
        let _ = atomic_write(&path, &payload);
    }

    // ── Record ───────────────────────────────────────────────────────────────

    /// Append one typed event (redacted and folded into the record by the
    /// store). Returns the assigned `seq`. Errors are propagated so the caller
    /// can decide; capture treats them as best-effort.
    pub fn append_event(&self, project_path: &str, raw: RawEvent) -> Result<u64, String> {
        let store = store_for(project_path)?;
        self.ensure_project_file(project_path);
        let row = store
            .append_event(
                NewEvent {
                    agent: raw.agent,
                    session_id: raw.session_id,
                    kind: raw.kind,
                    key: raw.key,
                    payload: raw.payload,
                },
                (self.inner.clock)(),
            )
            .map_err(|e| format!("{e:#}"))?;
        Ok(row.seq)
    }

    /// The summary view. Degrades to empty when the record can't be read.
    pub fn get_state(&self, project_path: &str) -> SharedState {
        match store_for(project_path).and_then(|s| read_state(&s).map_err(|e| format!("{e:#}"))) {
            Ok(state) => state,
            Err(e) => {
                tracing::warn!(target: "atlas::shared_memory", "read state failed: {e}");
                SharedState::default()
            }
        }
    }

    /// Substring/keyword search over the event log (newest-first, capped).
    pub fn query(&self, project_path: &str, query: &str, limit: usize) -> Vec<MemoryEvent> {
        store_for(project_path)
            .and_then(|s| s.search_events(query, limit.max(1)).map_err(|e| format!("{e:#}")))
            .map(|rows| rows.into_iter().map(MemoryEvent::from).collect())
            .unwrap_or_default()
    }

    /// Newest events (capped) — backs the Memory panel's events table. 500
    /// mirrors the Timeline's BOARD_LIMIT; the log itself is unbounded.
    pub fn list_events(&self, project_path: &str) -> Vec<MemoryEvent> {
        const EVENTS_LIMIT: usize = 500;
        store_for(project_path)
            .and_then(|s| s.events_newest(EVENTS_LIMIT).map_err(|e| format!("{e:#}")))
            .map(|rows| rows.into_iter().map(MemoryEvent::from).collect())
            .unwrap_or_default()
    }

    /// Wipe a project's shared memory (events, entries, sessions).
    pub fn clear(&self, project_path: &str) -> Result<(), String> {
        store_for(project_path)?.clear().map_err(|e| format!("{e:#}"))
    }
}

// ── Disk helpers ─────────────────────────────────────────────────────────────

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Atomic write: tmp + rename (mirrors `memory_sharing::atomic_write`).
fn atomic_write(path: &Path, payload: &str) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, payload).map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| e.to_string())
}

// ── Tauri commands ───────────────────────────────────────────────────────────
//
// Async so the record's disk I/O runs on the blocking pool, never on the
// Tauri main thread. Request and response shapes are unchanged.

async fn off_main<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn memory_get_state(
    project_path: String,
    store: State<'_, SharedMemoryStore>,
) -> Result<SharedState, String> {
    let store = store.inner().clone();
    off_main(move || Ok(store.get_state(&project_path))).await
}

#[tauri::command]
pub async fn memory_query(
    project_path: String,
    query: String,
    limit: Option<usize>,
    store: State<'_, SharedMemoryStore>,
) -> Result<Vec<MemoryEvent>, String> {
    let store = store.inner().clone();
    off_main(move || Ok(store.query(&project_path, &query, limit.unwrap_or(20)))).await
}

#[tauri::command]
pub async fn memory_list_events(
    project_path: String,
    store: State<'_, SharedMemoryStore>,
) -> Result<Vec<MemoryEvent>, String> {
    let store = store.inner().clone();
    off_main(move || Ok(store.list_events(&project_path))).await
}

#[tauri::command]
pub async fn memory_clear_project(
    project_path: String,
    store: State<'_, SharedMemoryStore>,
) -> Result<(), String> {
    let store = store.inner().clone();
    off_main(move || store.clear(&project_path)).await
}

/// Manual structured write — used by tests, the UI, and (later) an agent
/// write-tool. `kind` must be a snake_case [`EventKind`].
#[tauri::command]
pub async fn memory_append_event(
    project_path: String,
    agent: String,
    session_id: String,
    kind: EventKind,
    key: Option<String>,
    payload: serde_json::Value,
    store: State<'_, SharedMemoryStore>,
) -> Result<u64, String> {
    let store = store.inner().clone();
    off_main(move || {
        store.append_event(
            &project_path,
            RawEvent {
                agent,
                session_id,
                kind,
                key: key.unwrap_or_default(),
                payload,
            },
        )
    })
    .await
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
#[path = "shared_memory_contract.rs"]
mod contract;

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_project(label: &str) -> String {
        let dir = std::env::temp_dir().join(format!("atlas-shared-{label}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.to_string_lossy().to_string()
    }

    fn append(store: &SharedMemoryStore, p: &str, kind: EventKind, key: &str, payload: serde_json::Value) {
        store
            .append_event(
                p,
                RawEvent {
                    agent: "claude-code".into(),
                    session_id: "s1".into(),
                    kind,
                    key: key.into(),
                    payload,
                },
            )
            .unwrap();
    }

    fn git(dir: &Path, args: &[&str]) {
        let out = atlas_process::command("git").arg("-C").arg(dir).args(args).output().unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    }

    /// Scope is the repository: a decision recorded from one worktree is in
    /// the other worktree's shared memory, and the legacy log of the linked
    /// worktree is migrated into the one store.
    #[test]
    fn two_worktrees_share_one_memory() {
        let main = PathBuf::from(temp_project("wt-main"));
        git(&main, &["init", "--initial-branch=main"]);
        git(&main, &["-c", "user.name=t", "-c", "user.email=t@e", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "init"]);
        let linked = PathBuf::from(temp_project("wt-linked-parent")).join("feature");
        git(&main, &["worktree", "add", "-b", "feature", linked.to_str().unwrap()]);
        // The linked worktree had its own JSONL store before the record store.
        std::fs::create_dir_all(linked.join(".atlas/shared-memory")).unwrap();
        std::fs::write(
            linked.join(".atlas/shared-memory/events.jsonl"),
            r#"{"seq":1,"ts":5,"agent":"codex","sessionId":"old","kind":"fact","key":"","payload":{"text":"legacy fact from the worktree"}}"#,
        )
        .unwrap();

        let store = SharedMemoryStore::new();
        let (m, l) = (main.to_string_lossy().to_string(), linked.to_string_lossy().to_string());
        append(&store, &l, EventKind::Decision, "db", serde_json::json!({"text": "Postgres"}));
        assert!(Arc::ptr_eq(&store_for(&m).unwrap(), &store_for(&l).unwrap()));
        let seen_from_main = store.get_state(&m);
        assert_eq!(seen_from_main.decisions.len(), 1);
        assert_eq!(seen_from_main.facts[0].text, "legacy fact from the worktree");
        // The store lives in the main worktree.
        assert!(main.join(".atlas/memory").join(record::DB_FILE).exists());
        assert!(!linked.join(".atlas/memory").join(record::DB_FILE).exists());
    }

    /// Outside git, the scope is the launch directory.
    #[test]
    fn a_non_git_directory_is_its_own_scope() {
        let p = temp_project("non-git");
        let store = SharedMemoryStore::new();
        append(&store, &p, EventKind::Fact, "", serde_json::json!({"text": "here"}));
        assert!(Path::new(&p).join(".atlas/memory").join(record::DB_FILE).exists());
        assert_eq!(store_for(&p).unwrap().root(), Path::new(&p).canonicalize().unwrap());
    }

    #[test]
    fn plan_set_supersedes() {
        let (store, p) = (SharedMemoryStore::new(), temp_project("plan"));
        append(&store, &p, EventKind::PlanSet, "plan", serde_json::json!({"text": "Plan A"}));
        append(&store, &p, EventKind::PlanSet, "plan", serde_json::json!({"text": "Plan B"}));
        let s = store.get_state(&p);
        assert_eq!(s.active_plan.unwrap().text, "Plan B");
        assert_eq!(s.last_seq, 2);
    }

    #[test]
    fn plan_abandoned_clears() {
        let (store, p) = (SharedMemoryStore::new(), temp_project("plan-done"));
        append(&store, &p, EventKind::PlanSet, "plan", serde_json::json!({"text": "Plan A"}));
        append(&store, &p, EventKind::PlanSet, "plan", serde_json::json!({"text": "Plan A", "status": "done"}));
        assert!(store.get_state(&p).active_plan.is_none());
    }

    #[test]
    fn decision_supersedes_by_key() {
        let (store, p) = (SharedMemoryStore::new(), temp_project("decision-key"));
        append(&store, &p, EventKind::Decision, "auth.alg", serde_json::json!({"text": "HS256"}));
        append(&store, &p, EventKind::Decision, "auth.alg", serde_json::json!({"text": "RS256"}));
        append(&store, &p, EventKind::Decision, "db", serde_json::json!({"text": "Postgres"}));
        let s = store.get_state(&p);
        assert_eq!(s.decisions.len(), 2);
        assert!(s.decisions.iter().any(|d| d.key == "auth.alg" && d.text == "RS256"));
        assert!(!s.decisions.iter().any(|d| d.text == "HS256"));
    }

    #[test]
    fn decision_dedup_by_text_when_keyless() {
        let (store, p) = (SharedMemoryStore::new(), temp_project("decision-text"));
        append(&store, &p, EventKind::Decision, "", serde_json::json!({"text": "Use   RS256"}));
        append(&store, &p, EventKind::Decision, "", serde_json::json!({"text": "use rs256"}));
        assert_eq!(store.get_state(&p).decisions.len(), 1);
    }

    #[test]
    fn file_changed_dedups_by_path() {
        let (store, p) = (SharedMemoryStore::new(), temp_project("files"));
        append(&store, &p, EventKind::FileChanged, "", serde_json::json!({"path": "a.ts", "summary": "x"}));
        append(&store, &p, EventKind::FileChanged, "", serde_json::json!({"path": "a.ts", "summary": "y"}));
        append(&store, &p, EventKind::FileChanged, "", serde_json::json!({"path": "b.ts", "summary": "z"}));
        let s = store.get_state(&p);
        assert_eq!(s.recent_changes.len(), 2);
        assert_eq!(s.recent_changes.iter().find(|c| c.path == "a.ts").unwrap().summary, "y");
    }

    #[test]
    fn project_id_stable_across_trailing_slash() {
        let store = SharedMemoryStore::new();
        assert_eq!(
            store.project_id_for("/Users/x/proj"),
            store.project_id_for("/Users/x/proj/")
        );
        assert_eq!(store.project_id_for("/Users/x/proj").len(), 12);
    }

    #[test]
    fn decision_display_caps_length() {
        let (store, p) = (SharedMemoryStore::new(), temp_project("caps"));
        for i in 1..=record::CAP_DECISIONS + 10 {
            append(&store, &p, EventKind::Decision, &format!("k{i}"), serde_json::json!({"text": format!("d{i}")}));
        }
        assert_eq!(store.get_state(&p).decisions.len(), record::CAP_DECISIONS);
        // Storage keeps every one of them.
        assert_eq!(store_for(&p).unwrap().count(EntryKind::Decision).unwrap(), record::CAP_DECISIONS + 10);
    }

    #[test]
    fn session_start_tracks_agent() {
        let (store, p) = (SharedMemoryStore::new(), temp_project("session"));
        store
            .append_event(
                &p,
                RawEvent {
                    agent: "codex".into(),
                    session_id: "abc".into(),
                    kind: EventKind::SessionStart,
                    key: String::new(),
                    payload: serde_json::json!({}),
                },
            )
            .unwrap();
        let s = store.get_state(&p);
        assert_eq!(s.session_agents.get("abc").map(std::string::String::as_str), Some("codex"));
    }
}
