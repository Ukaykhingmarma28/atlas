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
