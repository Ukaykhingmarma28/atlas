//! Reads other features build on: what memory needs to place a write inside
//! a turn (memory plan M3).

use atlas_checkpoint::model::ProjectMode;
use atlas_checkpoint::{Capture, SessionKey, Source, Store, TurnState};

#[test]
fn turn_spans_report_every_turn_with_its_state_and_times() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(dir.path().join(".atlas")).expect("store opens");
    let key = SessionKey {
        workspace_id: "ws-atlas".to_string(),
        source: Source::Acp,
        native_session_id: "sess-1".to_string(),
    };
    let id = {
        let mut capture = Capture::new(&mut store, ProjectMode::Local);
        let id = capture
            .record_prompt(&key, "First", 1, Some("claude-code"), None, None)
            .unwrap();
        capture
            .record_prompt(&key, "Second", 2, Some("claude-code"), None, None)
            .unwrap();
        capture
            .record_prompt(&key, "Third", 3, Some("claude-code"), None, None)
            .unwrap();
        id
    };
    store.complete_turn(&id, 1).unwrap();
    store.mark_turns_rewound(&id, 1).unwrap();

    let spans = store.turn_spans(&id).unwrap();
    let states: Vec<(i64, TurnState, bool)> = spans
        .iter()
        .map(|s| (s.turn_seq, s.state, s.ended_at.is_some()))
        .collect();
    assert_eq!(
        states,
        vec![
            (1, TurnState::Completed, true),
            (2, TurnState::Open, false),
            (3, TurnState::Rewound, true),
        ]
    );
    assert!(spans
        .iter()
        .all(|s| s.ended_at.is_none_or(|e| e >= s.started_at)));
    assert!(store.turn_spans("no-such-session").unwrap().is_empty());
}

#[test]
fn failed_calls_and_written_paths_read_newest_first_and_bounded() {
    use atlas_checkpoint::tools::{resolve_path, ToolName};
    use atlas_checkpoint::{FileWrite, ToolCallContent, ToolStatus};
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(dir.path().join(".atlas")).expect("store opens");
    let key = SessionKey {
        workspace_id: "ws-atlas".to_string(),
        source: Source::Acp,
        native_session_id: "sess-1".to_string(),
    };
    let mut capture = Capture::new(&mut store, ProjectMode::Local);
    let row = capture
        .record_prompt(&key, "First", 1, Some("claude-code"), None, None)
        .unwrap();
    let none = serde_json::json!([]);
    for (i, status) in [
        ToolStatus::Failed,
        ToolStatus::Completed,
        ToolStatus::Failed,
    ]
    .into_iter()
    .enumerate()
    {
        capture
            .record_tool_call(
                &row,
                ToolCallContent {
                    turn_seq: 1,
                    native_call_id: Some(&format!("c{i}")),
                    tool_name: ToolName::Bash,
                    title: Some("Bash(cargo test)"),
                    kind: Some("execute"),
                    status,
                    locations: &none,
                    arguments: Some(r#"{"command":"cargo test -p auth"}"#),
                    result: Some(b"error: test failed\nmore"),
                },
            )
            .unwrap();
    }
    for (path, deleted) in [("src/a.rs", false), ("src/b.rs", false), ("src/a.rs", true)] {
        let call = capture
            .record_tool_call(
                &row,
                ToolCallContent {
                    turn_seq: 1,
                    native_call_id: Some(&format!("w-{path}-{deleted}")),
                    tool_name: ToolName::Edit,
                    title: None,
                    kind: Some("edit"),
                    status: ToolStatus::Completed,
                    locations: &none,
                    arguments: None,
                    result: None,
                },
            )
            .unwrap();
        let resolved = resolve_path(path, dir.path());
        capture
            .record_file_write(
                &row,
                &call,
                1,
                FileWrite {
                    path: &resolved,
                    sha256_after: None,
                    sketch_after: None,
                    existed_before: true,
                    deleted,
                },
            )
            .unwrap();
    }
    let failed = store.failed_tool_calls(&row, 10).unwrap();
    assert_eq!(failed.len(), 2);
    assert_eq!(failed[0].tool_name, ToolName::Bash);
    assert!(failed[0]
        .result
        .as_deref()
        .is_some_and(|r| r.starts_with("error: test failed")));
    assert_eq!(
        store.written_paths(&row, 10).unwrap(),
        [
            ("src/a.rs".to_string(), true),
            ("src/b.rs".to_string(), false)
        ]
    );
    assert_eq!(store.written_paths(&row, 1).unwrap().len(), 1, "bounded");
}
