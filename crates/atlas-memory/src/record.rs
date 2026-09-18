//! The shared-memory **record store**: one SQLite database per scope.
//!
//! Every agent on a repository — native and ACP — writes into this one record,
//! through the Tauri backend, which is its only writer. It replaces the JSONL
//! event log (`.atlas/shared-memory/events.jsonl` + `state.json`) and absorbs
//! the extracted-memory markdown (`.atlas/memory/extracted/*.md`) on first open
//! (see [`legacy`]).
//!
//! Three tables (`<scope root>/.atlas/memory/memory.sqlite`, WAL):
//!
//! - **events** — the append-only log (`seq`, `ts`, `kind`, `key`, `agent`,
//!   `session`, `payload`). The Shared tab's event list, query and append are
//!   served straight from it, byte-compatible with the JSONL log.
//! - **entries** — the record itself: one row per live memory with its kind,
//!   key, content, provenance (`source`, `agent`, `session`), `confidence`,
//!   timestamps, `uses` and a normalised `content_hash`. Appending an event
//!   folds it into entries with the log's replace rules (same key replaces, a
//!   finished plan clears the active plan, a repeat edit to a path replaces the
//!   earlier one). Nothing is ever evicted: the old per-kind caps are display
//!   limits applied by [`RecordStore::list`].
//! - **sessions** — which agent owned which session, and when it started and
//!   ended.
//!
//! Every write passes through `atlas_redact` before it lands, whoever wrote it.
//!
//! **Concurrency.** One connection per scope per process, behind a mutex:
//! [`open_scope`] hands every caller the same `Arc<RecordStore>` for a root, so
//! the single-writer invariant is a lock, never cross-process coordination.
//! Every method is synchronous and may touch disk; async callers run it on the
//! blocking pool.
//!
//! Entry ids are `INTEGER AUTOINCREMENT` and never reused, so a vector index
//! can key embeddings by entry id; a replaced entry keeps its id.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};

use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub mod legacy;

/// File name of the record database inside `<scope root>/.atlas/memory/`.
pub const DB_FILE: &str = "memory.sqlite";

/// Today's display caps, per durable/working kind. Storage is unbounded; these
/// only limit what a summary view shows (newest first).
pub const CAP_DECISIONS: usize = 50;
pub const CAP_FILES_CHANGED: usize = 50;
pub const CAP_FACTS: usize = 50;
pub const CAP_FAILURES: usize = 30;
pub const CAP_ARCHITECTURE: usize = 30;

// ── Vocabulary ───────────────────────────────────────────────────────────────

/// Typed kinds of event in the shared log. The snake_case names are the wire
/// and on-disk spelling (`memory_append_event`'s `kind`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EventKind {
    PlanSet,
    Decision,
    FileChanged,
    Fact,
    /// Something that was tried and failed / an anti-pattern to avoid — so a
    /// second agent doesn't repeat a dead end.
    Failure,
    /// A durable architecture/structure note about the system.
    Architecture,
    SessionStart,
    SessionEnd,
    TodoAdded,
    TodoDone,
    /// Any kind string this build doesn't recognise — e.g. a retired kind
    /// (like the old `skill_used`) still sitting in a migrated log. It folds
    /// into nothing but keeps its place (and its `seq`) in the log; its raw
    /// spelling is kept in the events table.
    #[serde(other)]
    Unknown,
}

impl EventKind {
    /// Parse a stored kind string; anything unrecognised is [`EventKind::Unknown`].
    pub fn parse(raw: &str) -> Self {
        serde_json::from_value(serde_json::Value::String(raw.to_string())).unwrap_or(Self::Unknown)
    }

    /// The snake_case spelling.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::PlanSet => "plan_set",
            Self::Decision => "decision",
            Self::FileChanged => "file_changed",
            Self::Fact => "fact",
            Self::Failure => "failure",
            Self::Architecture => "architecture",
            Self::SessionStart => "session_start",
            Self::SessionEnd => "session_end",
            Self::TodoAdded => "todo_added",
            Self::TodoDone => "todo_done",
            Self::Unknown => "unknown",
        }
    }
}

/// The six kinds of shared-memory entry (CONTEXT.md § "Shared memory domain").
/// Active plan and File changed are working memory; the other four are durable.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EntryKind {
    Plan,
    Decision,
    FileChanged,
    Fact,
    Failure,
    Architecture,
}

impl EntryKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Plan => "plan",
            Self::Decision => "decision",
            Self::FileChanged => "file_changed",
            Self::Fact => "fact",
            Self::Failure => "failure",
            Self::Architecture => "architecture",
        }
    }

    fn parse(raw: &str) -> Option<Self> {
        Some(match raw {
            "plan" => Self::Plan,
            "decision" => Self::Decision,
            "file_changed" => Self::FileChanged,
            "fact" => Self::Fact,
            "failure" => Self::Failure,
            "architecture" => Self::Architecture,
            _ => return None,
        })
    }

    /// The four durable kinds (accumulate, searchable, promotable).
    pub fn is_durable(self) -> bool {
        matches!(self, Self::Decision | Self::Fact | Self::Failure | Self::Architecture)
    }
}

/// One event to append. `seq` and `ts` are assigned by the store.
#[derive(Debug, Clone)]
pub struct NewEvent {
    pub agent: String,
    pub session_id: String,
    pub kind: EventKind,
    /// Supersession key (`"plan"`, a decision topic, a file path). Empty = none.
    pub key: String,
    pub payload: serde_json::Value,
}

/// One stored event.
#[derive(Debug, Clone, PartialEq)]
pub struct EventRow {
    pub seq: u64,
    pub ts: i64,
    pub agent: String,
    pub session_id: String,
    /// The kind as stored — a retired kind keeps its original spelling.
    pub kind: String,
    pub key: String,
    pub payload: serde_json::Value,
}

/// One live entry in the record.
#[derive(Debug, Clone, PartialEq)]
pub struct Entry {
    pub id: i64,
    pub kind: EntryKind,
    /// Writer-supplied key; empty when the writer gave none (identity is then
    /// the content hash). For File changed, the path.
    pub key: String,
    /// The memory text. For File changed, the summary of the edit.
    pub content: String,
    /// Active plan only: its status (`active`, `in_progress`, …); else empty.
    pub status: String,
    /// Provenance: an agent id, `extractor`, `user`, or `import:<origin>`.
    pub source: String,
    pub agent: String,
    pub session_id: String,
    pub confidence: f64,
    pub created_at: i64,
    pub updated_at: i64,
    pub last_used_at: Option<i64>,
    pub uses: u32,
    pub content_hash: String,
    /// The event whose fold last wrote this entry; `None` for entries written
    /// directly (imports, and later tools/extractor/user edits).
    pub seq: Option<u64>,
}

/// One entry to upsert directly (not through the event log).
#[derive(Debug, Clone)]
pub struct NewEntry {
    pub kind: EntryKind,
    /// Empty = identity by normalised content hash.
    pub key: String,
    pub content: String,
    pub source: String,
    pub agent: String,
    pub session_id: String,
    pub confidence: f64,
    /// Write time (ms since epoch).
    pub at: i64,
}

/// One session's bookkeeping row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionRow {
    pub session_id: String,
    pub agent: String,
    pub started_at: Option<i64>,
    pub ended_at: Option<i64>,
}

/// Which entries a listing covers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Origin {
    /// Only entries folded from the event log (what the Shared-tab state view
    /// has always shown).
    EventLog,
    /// Every entry, including imports and direct writes.
    Any,
}

// ── Scope registry ───────────────────────────────────────────────────────────

fn registry() -> &'static Mutex<HashMap<PathBuf, Arc<RecordStore>>> {
    static REG: OnceLock<Mutex<HashMap<PathBuf, Arc<RecordStore>>>> = OnceLock::new();
    REG.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The one in-process handle for the record store rooted at `root` (a scope
/// root: the main worktree, or a non-git launch directory). Opens (and
/// creates) the database on first use; later calls share the handle.
pub fn open_scope(root: &Path) -> Result<Arc<RecordStore>> {
    // Spelling variants of one directory (`/a/b/`, a symlinked `/tmp`) must
    // share one handle, or two connections would race on one sequence.
    let root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    let root = root.as_path();
    let mut reg = registry().lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some(store) = reg.get(root) {
        return Ok(store.clone());
    }
    let store = Arc::new(RecordStore::open(root)?);
    reg.insert(root.to_path_buf(), store.clone());
    Ok(store)
}

/// `<root>/.atlas/memory` — the directory holding the database and markers.
pub fn memory_dir(root: &Path) -> PathBuf {
    root.join(".atlas").join("memory")
}

// ── Store ────────────────────────────────────────────────────────────────────

/// The record store for one scope. See the module docs.
pub struct RecordStore {
    root: PathBuf,
    conn: Mutex<Connection>,
}

impl std::fmt::Debug for RecordStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RecordStore").field("root", &self.root).finish()
    }
}

impl RecordStore {
    /// Open (creating if needed) `<root>/.atlas/memory/memory.sqlite`. Prefer
    /// [`open_scope`], which keeps one handle per root per process.
    pub fn open(root: &Path) -> Result<Self> {
        let dir = memory_dir(root);
        std::fs::create_dir_all(&dir).with_context(|| format!("create {}", dir.display()))?;
        let path = dir.join(DB_FILE);
        let conn = Connection::open(&path).with_context(|| format!("open {}", path.display()))?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        migrate_schema(&conn)?;
        Ok(Self {
            root: root.to_path_buf(),
            conn: Mutex::new(conn),
        })
    }

    /// The scope root this store belongs to.
    pub fn root(&self) -> &Path {
        &self.root
    }

    fn conn(&self) -> MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    // ── Events ───────────────────────────────────────────────────────────────

    /// Append one event at time `ts`, redacted, and fold it into the entries
    /// and sessions it affects — one transaction. Returns the stored row.
    pub fn append_event(&self, ev: NewEvent, ts: i64) -> Result<EventRow> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let seq = last_seq_tx(&tx)? + 1;
        let row = EventRow {
            seq,
            ts,
            agent: ev.agent,
            session_id: ev.session_id,
            kind: ev.kind.as_str().to_string(),
            key: redact_text(&ev.key),
            payload: redact_value(ev.payload),
        };
        insert_event(&tx, &row)?;
        fold(&tx, &row)?;
        tx.commit()?;
        Ok(row)
    }

    /// `(last seq, its ts)`, or `None` for an empty log.
    pub fn last_event(&self) -> Result<Option<(u64, i64)>> {
        let conn = self.conn();
        Ok(conn
            .query_row("SELECT seq, ts FROM events ORDER BY seq DESC LIMIT 1", [], |r| {
                Ok((r.get::<_, i64>(0)? as u64, r.get::<_, i64>(1)?))
            })
            .optional()?)
    }

    /// Up to `limit` events, newest first.
    pub fn events_newest(&self, limit: usize) -> Result<Vec<EventRow>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT seq, ts, agent, session, kind, key, payload FROM events ORDER BY seq DESC LIMIT ?1",
        )?;
        let rows = stmt.query_map([limit as i64], event_from_row)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Events whose payload, key or agent contains `query` (case-insensitive,
    /// Unicode-aware), newest first, at most `limit`. An empty query matches
    /// everything.
    pub fn search_events(&self, query: &str, limit: usize) -> Result<Vec<EventRow>> {
        let q = query.trim().to_lowercase();
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT seq, ts, agent, session, kind, key, payload FROM events ORDER BY seq DESC",
        )?;
        let mut out = Vec::new();
        for row in stmt.query_map([], event_from_row)? {
            let e = row?;
            let hit = q.is_empty()
                || e.payload.to_string().to_lowercase().contains(&q)
                || e.key.to_lowercase().contains(&q)
                || e.agent.to_lowercase().contains(&q);
            if hit {
                out.push(e);
                if out.len() >= limit {
                    break;
                }
            }
        }
        Ok(out)
    }

    // ── Entries ──────────────────────────────────────────────────────────────

    /// The newest `limit` entries of `kind` (by the order they were last
    /// written), returned oldest → newest. `limit` is a display cap only.
    pub fn list(&self, kind: EntryKind, limit: usize, origin: Origin) -> Result<Vec<Entry>> {
        let conn = self.conn();
        let sql = match origin {
            Origin::EventLog => {
                "SELECT * FROM entries WHERE kind = ?1 AND seq IS NOT NULL ORDER BY seq DESC LIMIT ?2"
            }
            Origin::Any => {
                "SELECT * FROM entries WHERE kind = ?1 ORDER BY updated_at DESC, id DESC LIMIT ?2"
            }
        };
        let mut stmt = conn.prepare(sql)?;
        let rows = stmt.query_map(params![kind.as_str(), limit as i64], entry_from_row)?;
        let mut out = rows.collect::<rusqlite::Result<Vec<_>>>()?;
        out.reverse();
        Ok(out)
    }

    /// Every entry of `kind`, however many (storage is unbounded).
    pub fn count(&self, kind: EntryKind) -> Result<usize> {
        let conn = self.conn();
        let n: i64 =
            conn.query_row("SELECT COUNT(*) FROM entries WHERE kind = ?1", [kind.as_str()], |r| r.get(0))?;
        Ok(n as usize)
    }

    /// Entries whose content or key contains `query` (case-insensitive),
    /// optionally restricted to `kinds`, most recently written first.
    pub fn query(&self, query: &str, kinds: &[EntryKind], limit: usize) -> Result<Vec<Entry>> {
        let q = query.trim().to_lowercase();
        let conn = self.conn();
        let mut stmt = conn.prepare("SELECT * FROM entries ORDER BY updated_at DESC, id DESC")?;
        let mut out = Vec::new();
        for row in stmt.query_map([], entry_from_row)? {
            let e = row?;
            if !kinds.is_empty() && !kinds.contains(&e.kind) {
                continue;
            }
            if q.is_empty() || e.content.to_lowercase().contains(&q) || e.key.to_lowercase().contains(&q) {
                out.push(e);
                if out.len() >= limit {
                    break;
                }
            }
        }
        Ok(out)
    }

    /// Write one entry directly (not through the log), redacted. Identity is
    /// the key when given, else the normalised content hash; an existing entry
    /// with the same identity is replaced in place (same id). Re-writing
    /// identical content is a merge: the entry's `uses` is bumped and its
    /// confidence becomes the higher of the two.
    pub fn upsert(&self, e: NewEntry) -> Result<Entry> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let id = upsert_tx(&tx, e)?;
        let entry = tx.query_row("SELECT * FROM entries WHERE id = ?1", [id], entry_from_row)?;
        tx.commit()?;
        Ok(entry)
    }

    // ── Sessions ─────────────────────────────────────────────────────────────

    /// Record that `session_id` (run by `agent`) started at `ts`: a
    /// `session_start` event plus its sessions row.
    pub fn session_started(&self, session_id: &str, agent: &str, ts: i64) -> Result<EventRow> {
        self.append_event(
            NewEvent {
                agent: agent.into(),
                session_id: session_id.into(),
                kind: EventKind::SessionStart,
                key: String::new(),
                payload: serde_json::json!({}),
            },
            ts,
        )
    }

    /// Record that `session_id` ended at `ts`: a `session_end` event and the
    /// row's end time.
    pub fn session_ended(&self, session_id: &str, agent: &str, ts: i64) -> Result<EventRow> {
        self.append_event(
            NewEvent {
                agent: agent.into(),
                session_id: session_id.into(),
                kind: EventKind::SessionEnd,
                key: String::new(),
                payload: serde_json::json!({}),
            },
            ts,
        )
    }

    /// Every session row.
    pub fn sessions(&self) -> Result<Vec<SessionRow>> {
        let conn = self.conn();
        let mut stmt = conn
            .prepare("SELECT session_id, agent, started_at, ended_at FROM sessions ORDER BY session_id")?;
        let rows = stmt.query_map([], |r| {
            Ok(SessionRow {
                session_id: r.get(0)?,
                agent: r.get(1)?,
                started_at: r.get(2)?,
                ended_at: r.get(3)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    // ── Wipe ─────────────────────────────────────────────────────────────────

    /// Wipe the scope's shared memory: events, entries and sessions. The log's
    /// sequence starts again at 1. Migration markers stay, so a cleared scope
    /// is not refilled from legacy files.
    pub fn clear(&self) -> Result<()> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        tx.execute_batch("DELETE FROM events; DELETE FROM entries; DELETE FROM sessions;")?;
        tx.commit()?;
        Ok(())
    }
}

// ── Schema ───────────────────────────────────────────────────────────────────

const SCHEMA_VERSION: i64 = 1;

fn migrate_schema(conn: &Connection) -> Result<()> {
    let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if version >= SCHEMA_VERSION {
        return Ok(());
    }
    conn.execute_batch(
        "BEGIN;
         CREATE TABLE IF NOT EXISTS events (
             seq      INTEGER PRIMARY KEY,
             ts       INTEGER NOT NULL,
             kind     TEXT NOT NULL,
             key      TEXT NOT NULL DEFAULT '',
             agent    TEXT NOT NULL DEFAULT '',
             session  TEXT NOT NULL DEFAULT '',
             payload  TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS entries (
             id            INTEGER PRIMARY KEY AUTOINCREMENT,
             kind          TEXT NOT NULL,
             key           TEXT NOT NULL DEFAULT '',
             content       TEXT NOT NULL,
             status        TEXT NOT NULL DEFAULT '',
             source        TEXT NOT NULL DEFAULT '',
             agent         TEXT NOT NULL DEFAULT '',
             session       TEXT NOT NULL DEFAULT '',
             confidence    REAL NOT NULL DEFAULT 1.0,
             created_at    INTEGER NOT NULL,
             updated_at    INTEGER NOT NULL,
             last_used_at  INTEGER,
             uses          INTEGER NOT NULL DEFAULT 0,
             content_hash  TEXT NOT NULL,
             seq           INTEGER
         );
         CREATE INDEX IF NOT EXISTS entries_kind_seq  ON entries(kind, seq);
         CREATE INDEX IF NOT EXISTS entries_kind_key  ON entries(kind, key);
         CREATE INDEX IF NOT EXISTS entries_kind_hash ON entries(kind, content_hash);
         CREATE TABLE IF NOT EXISTS sessions (
             session_id  TEXT PRIMARY KEY,
             agent       TEXT NOT NULL DEFAULT '',
             started_at  INTEGER,
             ended_at    INTEGER
         );
         CREATE TABLE IF NOT EXISTS legacy_imports (
             source  TEXT PRIMARY KEY,
             at      INTEGER NOT NULL
         );
         PRAGMA user_version = 1;
         COMMIT;",
    )?;
    Ok(())
}

// ── Row mapping ──────────────────────────────────────────────────────────────

fn event_from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<EventRow> {
    let payload: String = r.get(6)?;
    Ok(EventRow {
        seq: r.get::<_, i64>(0)? as u64,
        ts: r.get(1)?,
        agent: r.get(2)?,
        session_id: r.get(3)?,
        kind: r.get(4)?,
        key: r.get(5)?,
        payload: serde_json::from_str(&payload).unwrap_or(serde_json::Value::Null),
    })
}

fn entry_from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Entry> {
    let kind: String = r.get("kind")?;
    Ok(Entry {
        id: r.get("id")?,
        kind: EntryKind::parse(&kind).unwrap_or(EntryKind::Fact),
        key: r.get("key")?,
        content: r.get("content")?,
        status: r.get("status")?,
        source: r.get("source")?,
        agent: r.get("agent")?,
        session_id: r.get("session")?,
        confidence: r.get("confidence")?,
        created_at: r.get("created_at")?,
        updated_at: r.get("updated_at")?,
        last_used_at: r.get("last_used_at")?,
        uses: r.get::<_, i64>("uses")? as u32,
        content_hash: r.get("content_hash")?,
        seq: r.get::<_, Option<i64>>("seq")?.map(|s| s as u64),
    })
}

fn last_seq_tx(tx: &Transaction<'_>) -> Result<u64> {
    let seq: Option<i64> = tx.query_row("SELECT MAX(seq) FROM events", [], |r| r.get(0))?;
    Ok(seq.unwrap_or(0) as u64)
}

fn insert_event(tx: &Transaction<'_>, row: &EventRow) -> Result<()> {
    tx.execute(
        "INSERT INTO events (seq, ts, kind, key, agent, session, payload) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            row.seq as i64,
            row.ts,
            row.kind,
            row.key,
            row.agent,
            row.session_id,
            serde_json::to_string(&row.payload)?,
        ],
    )?;
    Ok(())
}

// ── Redaction ────────────────────────────────────────────────────────────────

/// Scrub a text through `atlas_redact` — the one redactor every record write
/// uses. Returned unchanged when there was nothing to scrub.
pub fn redact(s: &str) -> String {
    redact_text(s)
}

fn redact_text(s: &str) -> String {
    let r = atlas_redact::redact(s);
    if r.changed() {
        r.text
    } else {
        s.to_string()
    }
}

/// Redact every string inside a JSON value; the value is returned untouched
/// (same key order, same numbers) when nothing needed scrubbing.
fn redact_value(v: serde_json::Value) -> serde_json::Value {
    match v {
        serde_json::Value::String(s) => serde_json::Value::String(redact_text(&s)),
        serde_json::Value::Array(items) => {
            serde_json::Value::Array(items.into_iter().map(redact_value).collect())
        }
        serde_json::Value::Object(map) => serde_json::Value::Object(
            map.into_iter().map(|(k, v)| (k, redact_value(v))).collect(),
        ),
        other => other,
    }
}

// ── Identity ─────────────────────────────────────────────────────────────────

/// Whitespace-collapsed, lower-cased — the dedup form of a text.
pub fn normalize(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase()
}

/// Hex sha256 of the normalised text.
pub fn content_hash(s: &str) -> String {
    Sha256::digest(normalize(s).as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

// ── Fold: event → entries ────────────────────────────────────────────────────

fn payload_str<'a>(ev: &'a EventRow, field: &str) -> Option<&'a str> {
    ev.payload.get(field).and_then(|v| v.as_str())
}

/// Fold one event into entries/sessions with the log's replace rules — the
/// same rules the JSONL store applied to its bounded view, minus eviction.
fn fold(tx: &Transaction<'_>, ev: &EventRow) -> Result<()> {
    let text = || payload_str(ev, "text").unwrap_or("").trim().to_string();
    match EventKind::parse(&ev.kind) {
        EventKind::PlanSet => {
            let text = payload_str(ev, "text").unwrap_or("").to_string();
            let status = payload_str(ev, "status").unwrap_or("active").to_string();
            if status == "abandoned" || status == "done" {
                // A finished or abandoned plan clears the active plan.
                tx.execute("DELETE FROM entries WHERE kind = 'plan'", [])?;
            } else if !text.is_empty() {
                let matches = ids(tx, "SELECT id FROM entries WHERE kind = 'plan'", params![])?;
                write_folded(tx, ev, EntryKind::Plan, "plan", &text, &status, &matches)?;
            }
        }
        EventKind::Decision => {
            let text = text();
            if text.is_empty() {
                return Ok(());
            }
            // Same non-empty key supersedes; keyless dedups by normalised text.
            let matches = ids(
                tx,
                "SELECT id FROM entries WHERE kind = 'decision' \
                 AND ((?1 <> '' AND key = ?1) OR content_hash = ?2)",
                params![ev.key, content_hash(&text)],
            )?;
            write_folded(tx, ev, EntryKind::Decision, &ev.key, &text, "", &matches)?;
        }
        EventKind::FileChanged => {
            let path = payload_str(ev, "path").unwrap_or(&ev.key).to_string();
            if path.is_empty() {
                return Ok(());
            }
            let summary = payload_str(ev, "summary").unwrap_or("").to_string();
            let matches = ids(
                tx,
                "SELECT id FROM entries WHERE kind = 'file_changed' AND key = ?1",
                params![path],
            )?;
            write_folded(tx, ev, EntryKind::FileChanged, &path, &summary, "", &matches)?;
        }
        EventKind::Fact => {
            let text = text();
            if text.is_empty() {
                return Ok(());
            }
            let matches = ids(
                tx,
                "SELECT id FROM entries WHERE kind = 'fact' AND content_hash = ?1",
                params![content_hash(&text)],
            )?;
            write_folded(tx, ev, EntryKind::Fact, &ev.key, &text, "", &matches)?;
        }
        kind @ (EventKind::Failure | EventKind::Architecture) => {
            let text = text();
            if text.is_empty() {
                return Ok(());
            }
            let entry_kind = if kind == EventKind::Failure {
                EntryKind::Failure
            } else {
                EntryKind::Architecture
            };
            // The JSONL fold compared an incoming key against the stored
            // entry's *text* for these two kinds; kept as-is so replacement
            // stays identical.
            let matches = ids(
                tx,
                "SELECT id FROM entries WHERE kind = ?1 \
                 AND ((?2 <> '' AND content = ?2) OR content_hash = ?3)",
                params![entry_kind.as_str(), ev.key, content_hash(&text)],
            )?;
            write_folded(tx, ev, entry_kind, &ev.key, &text, "", &matches)?;
        }
        // A start on a known session is a reopen (a resumed conversation keeps
        // its id): it is live again, so its old end no longer holds.
        EventKind::SessionStart => {
            tx.execute(
                "INSERT INTO sessions (session_id, agent, started_at) VALUES (?1, ?2, ?3) \
                 ON CONFLICT(session_id) DO UPDATE SET agent = excluded.agent, started_at = excluded.started_at, \
                 ended_at = NULL",
                params![ev.session_id, ev.agent, ev.ts],
            )?;
        }
        EventKind::SessionEnd => {
            tx.execute(
                "UPDATE sessions SET ended_at = ?2 WHERE session_id = ?1",
                params![ev.session_id, ev.ts],
            )?;
        }
        EventKind::TodoAdded | EventKind::TodoDone | EventKind::Unknown => {
            // Kept in the log for audit; no entry.
        }
    }
    Ok(())
}

fn ids(tx: &Transaction<'_>, sql: &str, p: impl rusqlite::Params) -> Result<Vec<i64>> {
    let mut stmt = tx.prepare(sql)?;
    let rows = stmt.query_map(p, |r| r.get::<_, i64>(0))?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// Replace `matches` with one entry written by `ev`: the oldest match keeps
/// its id (and creation time), the rest are removed; no match inserts.
fn write_folded(
    tx: &Transaction<'_>,
    ev: &EventRow,
    kind: EntryKind,
    key: &str,
    content: &str,
    status: &str,
    matches: &[i64],
) -> Result<()> {
    let hash = content_hash(content);
    if let Some(&keep) = matches.iter().min() {
        for id in matches.iter().filter(|id| **id != keep) {
            tx.execute("DELETE FROM entries WHERE id = ?1", [id])?;
        }
        tx.execute(
            "UPDATE entries SET key = ?2, content = ?3, status = ?4, source = ?5, agent = ?5, session = ?6, \
             confidence = 1.0, updated_at = ?7, content_hash = ?8, seq = ?9 WHERE id = ?1",
            params![keep, key, content, status, ev.agent, ev.session_id, ev.ts, hash, ev.seq as i64],
        )?;
    } else {
        tx.execute(
            "INSERT INTO entries (kind, key, content, status, source, agent, session, confidence, \
             created_at, updated_at, content_hash, seq) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?6, 1.0, ?7, ?7, ?8, ?9)",
            params![kind.as_str(), key, content, status, ev.agent, ev.session_id, ev.ts, hash, ev.seq as i64],
        )?;
    }
    Ok(())
}

fn upsert_tx(tx: &Transaction<'_>, e: NewEntry) -> Result<i64> {
    let key = redact_text(&e.key);
    let content = redact_text(e.content.trim());
    let hash = content_hash(&content);
    let existing: Option<(i64, String)> = if key.is_empty() {
        tx.query_row(
            "SELECT id, content_hash FROM entries WHERE kind = ?1 AND content_hash = ?2 ORDER BY id LIMIT 1",
            params![e.kind.as_str(), hash],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?
    } else {
        tx.query_row(
            "SELECT id, content_hash FROM entries WHERE kind = ?1 AND key = ?2 ORDER BY id LIMIT 1",
            params![e.kind.as_str(), key],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?
    };
    match existing {
        Some((id, old_hash)) if old_hash == hash => {
            tx.execute(
                "UPDATE entries SET uses = uses + 1, confidence = MAX(confidence, ?2), \
                 updated_at = MAX(updated_at, ?3) WHERE id = ?1",
                params![id, e.confidence, e.at],
            )?;
            Ok(id)
        }
        Some((id, _)) => {
            tx.execute(
                "UPDATE entries SET content = ?2, source = ?3, agent = ?4, session = ?5, confidence = ?6, \
                 updated_at = ?7, content_hash = ?8 WHERE id = ?1",
                params![id, content, e.source, e.agent, e.session_id, e.confidence, e.at, hash],
            )?;
            Ok(id)
        }
        None => {
            tx.execute(
                "INSERT INTO entries (kind, key, content, source, agent, session, confidence, created_at, \
                 updated_at, content_hash) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8, ?9)",
                params![e.kind.as_str(), key, content, e.source, e.agent, e.session_id, e.confidence, e.at, hash],
            )?;
            Ok(tx.last_insert_rowid())
        }
    }
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub(crate) fn temp_root(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("atlas-record-{label}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn ev(kind: EventKind, key: &str, payload: serde_json::Value) -> NewEvent {
        NewEvent {
            agent: "codex".into(),
            session_id: "s1".into(),
            kind,
            key: key.into(),
            payload,
        }
    }

    #[test]
    fn a_secret_in_any_write_lands_redacted() {
        let root = temp_root("redact");
        let store = open_scope(&root).unwrap();
        let secret = "sk-proj-AbCdEf0123456789GhIjKlMnOpQrStUv";

        store
            .append_event(ev(EventKind::Fact, "", serde_json::json!({"text": format!("the key is {secret}")})), 1)
            .unwrap();
        store
            .upsert(NewEntry {
                kind: EntryKind::Decision,
                key: String::new(),
                content: format!("rotate {secret} monthly"),
                source: "user".into(),
                agent: String::new(),
                session_id: String::new(),
                confidence: 1.0,
                at: 2,
            })
            .unwrap();

        let events = store.events_newest(10).unwrap();
        assert!(!events[0].payload.to_string().contains(secret), "{:?}", events[0]);
        let everything = store.query("", &[], 100).unwrap();
        assert_eq!(everything.len(), 2);
        for e in everything {
            assert!(!e.content.contains(secret), "{e:?}");
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn caps_are_display_limits_and_nothing_is_evicted() {
        let root = temp_root("caps");
        let store = open_scope(&root).unwrap();
        for i in 1..=60 {
            store
                .append_event(ev(EventKind::Decision, &format!("k{i}"), serde_json::json!({"text": format!("d{i}")})), i)
                .unwrap();
        }
        assert_eq!(store.count(EntryKind::Decision).unwrap(), 60);
        let shown = store.list(EntryKind::Decision, CAP_DECISIONS, Origin::EventLog).unwrap();
        assert_eq!(shown.len(), 50);
        assert_eq!(shown.first().unwrap().content, "d11");
        assert_eq!(shown.last().unwrap().content, "d60");
        // The first decision is still searchable.
        assert_eq!(store.query("d1", &[EntryKind::Decision], 100).unwrap().iter().filter(|e| e.content == "d1").count(), 1);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_replaced_entry_keeps_its_id() {
        let root = temp_root("replace");
        let store = open_scope(&root).unwrap();
        store.append_event(ev(EventKind::Decision, "alg", serde_json::json!({"text": "HS256"})), 1).unwrap();
        let before = store.list(EntryKind::Decision, 10, Origin::Any).unwrap();
        store.append_event(ev(EventKind::Decision, "alg", serde_json::json!({"text": "RS256"})), 2).unwrap();
        let after = store.list(EntryKind::Decision, 10, Origin::Any).unwrap();
        assert_eq!(after.len(), 1);
        assert_eq!(after[0].id, before[0].id);
        assert_eq!(after[0].content, "RS256");
        assert_eq!(after[0].seq, Some(2));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn session_hooks_record_start_and_end() {
        let root = temp_root("sessions");
        let store = open_scope(&root).unwrap();
        store.session_started("s1", "codex", 10).unwrap();
        store.session_ended("s1", "codex", 20).unwrap();
        assert_eq!(
            store.sessions().unwrap(),
            vec![SessionRow { session_id: "s1".into(), agent: "codex".into(), started_at: Some(10), ended_at: Some(20) }]
        );
        let kinds: Vec<String> = store.events_newest(10).unwrap().into_iter().map(|e| e.kind).collect();
        assert_eq!(kinds, vec!["session_end", "session_start"]);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A session reopened after it ended (a resumed conversation keeps its
    /// id) is live again: its row carries the new start and no end.
    #[test]
    fn a_reopened_session_is_live_again() {
        let root = temp_root("sessions-reopen");
        let store = open_scope(&root).unwrap();
        store.session_started("s1", "codex", 10).unwrap();
        store.session_ended("s1", "codex", 20).unwrap();
        store.session_started("s1", "codex", 30).unwrap();
        assert_eq!(
            store.sessions().unwrap(),
            vec![SessionRow { session_id: "s1".into(), agent: "codex".into(), started_at: Some(30), ended_at: None }]
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn one_handle_per_scope() {
        let root = temp_root("handle");
        let a = open_scope(&root).unwrap();
        let b = open_scope(&root).unwrap();
        assert!(Arc::ptr_eq(&a, &b));
        let _ = std::fs::remove_dir_all(&root);
    }
}
