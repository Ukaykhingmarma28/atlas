//! Persistent chat threads for Session-Chat.
//!
//! One JSON file per thread, atomic write via
//! tmp-and-rename — with one structural difference: threads are filed *under the
//! Session they are about*, at
//! `app_config_dir/session-chat/<agent_session_id>/<chat_id>.json`.
//!
//! That nesting is the whole point. A thread about one Session is meaningless
//! next to another, and the picker has to list only this Session's threads; a
//! flat directory would mean reading and discarding every thread in the app to
//! render one dropdown.

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use super::session_chat::SourceRef;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredMessage {
    pub id: String,
    pub role: String,
    pub content: String,
    pub timestamp: String,
    /// What this answer was grounded in. Saved with the message rather than
    /// alongside it so a citation cannot outlive or be orphaned from its reply.
    /// `default` keeps threads written before this field readable.
    #[serde(default)]
    pub sources: Vec<SourceRef>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionChatThread {
    pub id: String,
    pub title: String,
    /// The recorded Session this thread is about — also its directory.
    pub agent_session_id: String,
    /// Which project's store the Session lives in. Needed to retrieve, since the
    /// Timeline board spans every project in the Organisation.
    #[serde(default)]
    pub project_path: String,
    #[serde(default)]
    pub provider: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub messages: Vec<StoredMessage>,
    /// Commit SHAs this thread is scoped to. `None`/absent = the whole Session.
    /// `default` keeps threads written before scoping shipped readable, and
    /// lets a save that omits the field (there shouldn't be one) not fail.
    #[serde(default)]
    pub checkpoint_scope: Option<Vec<String>>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadMeta {
    pub id: String,
    pub title: String,
    pub updated_at: String,
}

/// Reject anything that could escape the session-chat directory.
///
/// Both ids reach the filesystem as path components, and one of them
/// (`agent_session_id`) originates in an agent's own transcript rather than in
/// Atlas — so it is untrusted input by the same standard as any other.
fn safe(id: &str) -> Result<&str, String> {
    if id.is_empty() || id.contains('/') || id.contains('\\') || id.contains("..") {
        return Err("invalid id".into());
    }
    Ok(id)
}

fn session_dir(app: &AppHandle, agent_session_id: &str) -> Result<PathBuf, String> {
    let d = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("no app config dir: {e}"))?
        .join("session-chat")
        .join(safe(agent_session_id)?);
    fs::create_dir_all(&d).map_err(|e| format!("create session-chat dir: {e}"))?;
    Ok(d)
}

fn thread_path(app: &AppHandle, agent_session_id: &str, id: &str) -> Result<PathBuf, String> {
    Ok(session_dir(app, agent_session_id)?.join(format!("{}.json", safe(id)?)))
}

#[tauri::command(async)]
pub fn session_chat_threads_list(
    app: AppHandle,
    agent_session_id: String,
) -> Result<Vec<ThreadMeta>, String> {
    let d = session_dir(&app, &agent_session_id)?;
    let mut metas: Vec<ThreadMeta> = Vec::new();
    if let Ok(entries) = fs::read_dir(&d) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            if let Ok(raw) = fs::read_to_string(&path) {
                if let Ok(t) = serde_json::from_str::<SessionChatThread>(&raw) {
                    metas.push(ThreadMeta {
                        id: t.id,
                        title: t.title,
                        updated_at: t.updated_at,
                    });
                }
            }
        }
    }
    metas.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(metas)
}

#[tauri::command(async)]
pub fn session_chat_thread_get(
    app: AppHandle,
    agent_session_id: String,
    id: String,
) -> Result<SessionChatThread, String> {
    let path = thread_path(&app, &agent_session_id, &id)?;
    let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn session_chat_thread_save(app: AppHandle, thread: SessionChatThread) -> Result<(), String> {
    let path = thread_path(&app, &thread.agent_session_id, &thread.id)?;
    // Tmp-and-rename: a thread is rewritten on every streamed message, so a
    // crash mid-write is a real possibility and a half-written JSON file is a
    // conversation that never loads again.
    let tmp = path.with_extension("json.tmp");
    let payload = serde_json::to_string_pretty(&thread).map_err(|e| e.to_string())?;
    fs::write(&tmp, &payload).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn session_chat_thread_delete(
    app: AppHandle,
    agent_session_id: String,
    id: String,
) -> Result<(), String> {
    let path = thread_path(&app, &agent_session_id, &id)?;
    if path.exists() {
        fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_rejects_traversal() {
        assert!(safe("..").is_err());
        assert!(safe("a/b").is_err());
        assert!(safe("a\\b").is_err());
        assert!(safe("").is_err());
    }

    #[test]
    fn safe_accepts_a_normal_id() {
        assert!(safe("01J8Z9-abc_DEF").is_ok());
    }

    /// Regression for a bug where `checkpoint_scope` was accepted on the wire
    /// (the frontend always sends it) but the struct had no field for it, so
    /// serde silently dropped it and a thread's checkpoint scope never
    /// survived a reload. Pins both the wire key (must be `checkpointScope`,
    /// matching the frontend's `SessionChatThreadWire`) and that it round-trips.
    #[test]
    fn checkpoint_scope_round_trips_on_the_wire() {
        let thread = SessionChatThread {
            id: "t1".into(),
            title: "About the auth refactor".into(),
            agent_session_id: "s1".into(),
            project_path: "/repo".into(),
            provider: "anthropic".into(),
            model: "claude".into(),
            messages: Vec::new(),
            checkpoint_scope: Some(vec!["abc123".into(), "def456".into()]),
            created_at: "2026-01-01T00:00:00Z".into(),
            updated_at: "2026-01-01T00:00:00Z".into(),
        };
        let json = serde_json::to_string(&thread).unwrap();
        assert!(json.contains("\"checkpointScope\""), "wire key: {json}");

        let round_tripped: SessionChatThread = serde_json::from_str(&json).unwrap();
        assert_eq!(round_tripped.checkpoint_scope, thread.checkpoint_scope);
    }

    /// A thread file written before scoping shipped has no `checkpointScope`
    /// key at all — `#[serde(default)]` must keep it readable rather than
    /// rejecting the file.
    #[test]
    fn checkpoint_scope_defaults_to_none_for_old_threads() {
        let json = r#"{
            "id": "t1",
            "title": "Old thread",
            "agentSessionId": "s1",
            "projectPath": "/repo",
            "provider": "anthropic",
            "model": "claude",
            "messages": [],
            "createdAt": "2025-01-01T00:00:00Z",
            "updatedAt": "2025-01-01T00:00:00Z"
        }"#;
        let thread: SessionChatThread = serde_json::from_str(json).unwrap();
        assert_eq!(thread.checkpoint_scope, None);
    }
}
