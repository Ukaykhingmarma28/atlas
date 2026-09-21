//! The extractor: durable memory distilled from a session's conversation.
//!
//! One pass asks the model directly for the four durable kinds — Decision,
//! Fact, Failure, Architecture — each with a 0–1 confidence (research note
//! R11: no intermediate category table). It runs at two moments:
//!
//! - **Turn finished**, under the gates: at least twenty turns in the session
//!   and, after the first pass, at least three tool calls since the last one;
//!   never while the last assistant turn still has a tool call open.
//! - **Session end**, once, over whatever arrived since the last pass — so a
//!   short session still contributes.
//!
//! This module owns the gates, the prompt and the parser. The model call is
//! injected by the caller (`llm`), and so is the write: [`extract`] returns
//! what the model found and the caller lands it in the record store, which
//! redacts and dedups every write. The crate stays free of any provider.
//!
//! [`ExtractState`] (counts since the last pass) is persisted per session under
//! the scope's memory directory, so the gates survive a restart.

use std::future::Future;
use std::path::Path;

use anyhow::Result;
use serde::{Deserialize, Serialize};

use crate::record::EntryKind;

/// Turns a session needs before the first turn-finished pass.
const MIN_MESSAGES_TO_EXTRACT: usize = 20;
/// Tool calls since the last pass before another turn-finished pass.
const MIN_TOOL_CALLS_BETWEEN_EXTRACTIONS: usize = 3;
/// Cap on the conversation text sent to the model (chars); the most recent
/// text is kept.
const MAX_PROMPT_CHARS: usize = 6000;
/// Shorter items are noise ("ok", "n/a").
const MIN_ITEM_CHARS: usize = 4;
/// Items kept per kind from one pass.
const MAX_PER_KIND: usize = 8;
/// Confidence when the model gave none (or an unreadable one).
const DEFAULT_CONFIDENCE: f64 = 0.5;

const INSTRUCTION: &str = "You are extracting durable shared memory from a conversation between a user and an AI coding agent, so that a DIFFERENT agent working on the same repository later can continue the work. Extract only concrete, reusable items of exactly four kinds:\n- decision: a technical choice that was made (and why, briefly)\n- fact: a durable fact or convention about the project or the user's preferences\n- failure: something that was tried and failed, or an anti-pattern to avoid\n- architecture: a structural note about how the system is built\nOmit anything speculative, conversational or transient, and anything already stated as background memory. Give each item a confidence between 0 and 1 that it is correct and worth remembering.\nRespond with ONLY a JSON object (no prose, no code fences) of exactly this shape:\n{\"entries\":[{\"kind\":\"decision\",\"content\":\"one short sentence\",\"confidence\":0.9}]}\nUse {\"entries\":[]} when nothing qualifies.";

/// Format-neutral transcript turn, adapted from any agent's session by the
/// app layer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TranscriptTurn {
    /// `"user"`, `"assistant"`, or `"system"` (lower-cased role label).
    pub role: String,
    /// Visible text of the turn (tool args/results are summarised out by the adapter).
    pub text: String,
    /// Number of tool calls attached to this turn (drives the gate's tool-call count).
    pub tool_calls: usize,
}

/// When an extraction pass is asked for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Trigger {
    /// A turn finished: runs only when the gates are met.
    TurnFinished,
    /// The session ended: runs once over anything new since the last pass.
    SessionEnd,
}

/// One durable entry the model found.
#[derive(Debug, Clone, PartialEq)]
pub struct Extracted {
    /// Always one of the four durable kinds.
    pub kind: EntryKind,
    pub content: String,
    /// The model's own 0–1 confidence, clamped.
    pub confidence: f64,
}

/// Per-session extraction bookkeeping, persisted under
/// `<memory_dir>/extract-state/<session>.json`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ExtractState {
    /// Transcript length at the last extraction pass.
    pub last_extracted_turn_index: usize,
    /// Tool calls observed since `last_extracted_turn_index` (synced from the
    /// transcript before each gate check).
    pub tool_calls_since_last: usize,
    /// How many extraction passes have run for this session.
    pub extraction_count: u32,
}

impl ExtractState {
    /// Load the persisted state for `session_id`, or a default if absent/corrupt.
    pub fn load(memory_dir: &Path, session_id: &str) -> Self {
        let path = state_path(memory_dir, session_id);
        std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    /// Persist the state for `session_id` (atomic temp + rename).
    pub fn save(&self, memory_dir: &Path, session_id: &str) -> Result<()> {
        let path = state_path(memory_dir, session_id);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let json = serde_json::to_string_pretty(self)?;
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, json.as_bytes())?;
        std::fs::rename(&tmp, &path)?;
        Ok(())
    }

    /// Recompute `tool_calls_since_last` from the turns after the last extraction.
    fn sync_counts(&mut self, turns: &[TranscriptTurn]) {
        let start = self.last_extracted_turn_index.min(turns.len());
        self.tool_calls_since_last = turns[start..].iter().map(|t| t.tool_calls).sum();
    }
}

fn state_path(memory_dir: &Path, session_id: &str) -> std::path::PathBuf {
    memory_dir
        .join("extract-state")
        .join(format!("{}.json", sanitize(session_id)))
}

/// Keep a session id filesystem-safe.
fn sanitize(s: &str) -> String {
    s.chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect()
}

/// The turn-finished gates: ≥20 turns; ≥3 tool calls since the last pass (only
/// once a first pass has happened); no tool call open on the last assistant
/// turn.
///
/// `state.tool_calls_since_last` must already reflect the transcript — callers
/// go through [`extract`], which syncs it first.
pub fn should_extract(turns: &[TranscriptTurn], state: &ExtractState) -> bool {
    if turns.len() < MIN_MESSAGES_TO_EXTRACT {
        return false;
    }
    if state.extraction_count > 0 && state.tool_calls_since_last < MIN_TOOL_CALLS_BETWEEN_EXTRACTIONS
    {
        return false;
    }
    if let Some(last_assistant) = turns.iter().rev().find(|t| t.role == "assistant") {
        if last_assistant.tool_calls > 0 {
            return false;
        }
    }
    true
}

/// The turns since the last pass that carry any text.
fn new_turns<'a>(turns: &'a [TranscriptTurn], state: &ExtractState) -> impl Iterator<Item = &'a TranscriptTurn> {
    let start = state.last_extracted_turn_index.min(turns.len());
    turns[start..].iter().filter(|t| !t.text.trim().is_empty())
}

/// Gate one pass, ask the model, and return what it found — off the hot path.
///
/// `llm` receives the full prompt and returns the model's raw completion. It
/// is called at most once, and only when `trigger` allows a pass: the gates
/// for [`Trigger::TurnFinished`]; any new assistant text for
/// [`Trigger::SessionEnd`]. A pass that ran advances `state` (even when
/// nothing parsed, so a dud turn does not re-trigger at once) — the caller
/// persists it; a failed model call leaves it untouched and is returned as the
/// error. No disk I/O: the caller runs that off the async runtime.
pub async fn extract<F, Fut>(
    turns: &[TranscriptTurn],
    state: &mut ExtractState,
    trigger: Trigger,
    llm: F,
) -> Result<Vec<Extracted>>
where
    F: FnOnce(String) -> Fut,
    Fut: Future<Output = Result<String>>,
{
    state.sync_counts(turns);
    let due = match trigger {
        Trigger::TurnFinished => should_extract(turns, state),
        Trigger::SessionEnd => new_turns(turns, state).any(|t| t.role == "assistant"),
    };
    if !due {
        return Ok(Vec::new());
    }

    let prompt = build_prompt(new_turns(turns, state));
    let output = llm(prompt).await?;

    state.extraction_count += 1;
    state.last_extracted_turn_index = turns.len();
    state.tool_calls_since_last = 0;

    Ok(parse_extracted(&output))
}

/// The instruction followed by the conversation since the last pass, capped to
/// [`MAX_PROMPT_CHARS`] (keeping the most recent text).
fn build_prompt<'a>(turns: impl Iterator<Item = &'a TranscriptTurn>) -> String {
    let mut body = String::new();
    for turn in turns {
        body.push_str(&format!("[{}] {}\n", turn.role, turn.text.trim()));
    }
    if body.len() > MAX_PROMPT_CHARS {
        let start = body.len() - MAX_PROMPT_CHARS;
        let start = (start..body.len())
            .find(|i| body.is_char_boundary(*i))
            .unwrap_or(start);
        body = body[start..].to_string();
    }
    format!("{INSTRUCTION}\n\n--- CONVERSATION ---\n{body}")
}

/// Parse the model's answer. Lenient: the outermost `{…}` is read, so stray
/// prose or code fences around it are ignored; items of any other kind, empty
/// or near-empty items, and anything past [`MAX_PER_KIND`] per kind are
/// dropped. Confidence is clamped to 0–1; a missing one is 0.5.
pub fn parse_extracted(output: &str) -> Vec<Extracted> {
    let (Some(start), Some(end)) = (output.find('{'), output.rfind('}')) else {
        return Vec::new();
    };
    if end <= start {
        return Vec::new();
    }
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&output[start..=end]) else {
        return Vec::new();
    };
    let Some(items) = value.get("entries").and_then(|v| v.as_array()) else {
        return Vec::new();
    };

    let mut out: Vec<Extracted> = Vec::new();
    for item in items {
        let Some(kind) = item
            .get("kind")
            .and_then(|k| k.as_str())
            .and_then(|k| EntryKind::parse(k.trim().to_ascii_lowercase().as_str()))
            .filter(|k| k.is_durable())
        else {
            continue;
        };
        let Some(content) = item.get("content").and_then(|c| c.as_str()).map(str::trim) else {
            continue;
        };
        if content.chars().count() < MIN_ITEM_CHARS {
            continue;
        }
        if out.iter().filter(|e| e.kind == kind).count() >= MAX_PER_KIND {
            continue;
        }
        let confidence = item
            .get("confidence")
            .and_then(serde_json::Value::as_f64)
            .filter(|c| c.is_finite())
            .map_or(DEFAULT_CONFIDENCE, |c| c.clamp(0.0, 1.0));
        out.push(Extracted {
            kind,
            content: content.to_string(),
            confidence,
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn turn(role: &str, text: &str, tool_calls: usize) -> TranscriptTurn {
        TranscriptTurn {
            role: role.into(),
            text: text.into(),
            tool_calls,
        }
    }

    fn make_turns(n: usize) -> Vec<TranscriptTurn> {
        (0..n)
            .map(|i| {
                if i % 2 == 0 {
                    turn("user", &format!("msg {i}"), 0)
                } else {
                    turn("assistant", &format!("reply {i}"), 0)
                }
            })
            .collect()
    }

    fn tmp_dir(name: &str) -> std::path::PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!("atlas-extract-{}-{}", std::process::id(), name));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    const CANNED: &str = r#"Sure:
```json
{"entries":[
 {"kind":"decision","content":"Sign JWTs with RS256","confidence":0.9},
 {"kind":"fact","content":"The API speaks JSON over REST","confidence":0.85},
 {"kind":"failure","content":"HS256 needs a shared secret; avoid","confidence":0.7},
 {"kind":"architecture","content":"Server components render /todos","confidence":0.6}
]}
```"#;

    #[test]
    fn gate_false_below_message_threshold() {
        assert!(!should_extract(&make_turns(10), &ExtractState::default()));
    }

    #[test]
    fn gate_true_above_threshold() {
        assert!(should_extract(&make_turns(26), &ExtractState::default()));
    }

    #[test]
    fn gate_false_during_cooldown() {
        let state = ExtractState {
            extraction_count: 1,
            tool_calls_since_last: 1,
            ..Default::default()
        };
        assert!(!should_extract(&make_turns(26), &state));
    }

    #[test]
    fn gate_true_after_cooldown_met() {
        let state = ExtractState {
            extraction_count: 1,
            tool_calls_since_last: 3,
            ..Default::default()
        };
        assert!(should_extract(&make_turns(26), &state));
    }

    #[test]
    fn gate_false_with_pending_tool_use() {
        let mut turns = make_turns(26);
        turns.push(turn("assistant", "running tool", 1));
        assert!(!should_extract(&turns, &ExtractState::default()));
    }

    #[test]
    fn sync_counts_sums_tool_calls_since_last() {
        let turns = vec![
            turn("user", "a", 0),
            turn("assistant", "b", 2),
            turn("user", "c", 0),
            turn("assistant", "d", 3),
        ];
        let mut state = ExtractState {
            last_extracted_turn_index: 2,
            ..Default::default()
        };
        state.sync_counts(&turns);
        assert_eq!(state.tool_calls_since_last, 3);
    }

    #[test]
    fn the_model_is_asked_for_the_four_kinds_with_a_confidence_each() {
        let found = parse_extracted(CANNED);
        assert_eq!(
            found,
            vec![
                Extracted { kind: EntryKind::Decision, content: "Sign JWTs with RS256".into(), confidence: 0.9 },
                Extracted { kind: EntryKind::Fact, content: "The API speaks JSON over REST".into(), confidence: 0.85 },
                Extracted { kind: EntryKind::Failure, content: "HS256 needs a shared secret; avoid".into(), confidence: 0.7 },
                Extracted { kind: EntryKind::Architecture, content: "Server components render /todos".into(), confidence: 0.6 },
            ]
        );
    }

    #[test]
    fn working_memory_kinds_short_items_and_prose_are_dropped() {
        let out = r#"{"entries":[
            {"kind":"plan","content":"Step one then two","confidence":1},
            {"kind":"file_changed","content":"src/a.rs","confidence":1},
            {"kind":"preference","content":"Likes tabs over spaces","confidence":1},
            {"kind":"fact","content":"ok","confidence":1},
            {"kind":"Fact","content":"Uses pnpm workspaces","confidence":7},
            {"kind":"decision","content":"Keep SQLite in WAL mode"}
        ]}"#;
        let found = parse_extracted(out);
        assert_eq!(
            found,
            vec![
                Extracted { kind: EntryKind::Fact, content: "Uses pnpm workspaces".into(), confidence: 1.0 },
                Extracted { kind: EntryKind::Decision, content: "Keep SQLite in WAL mode".into(), confidence: 0.5 },
            ]
        );
        assert!(parse_extracted("I could not produce JSON.").is_empty());
        assert!(parse_extracted(r#"{"entries":[]}"#).is_empty());
    }

    #[tokio::test]
    async fn a_turn_before_the_gates_never_calls_the_model() {
        let mut state = ExtractState::default();
        let found = extract(&make_turns(4), &mut state, Trigger::TurnFinished, |_| async {
            panic!("the model must not be called before the gates are met");
            #[allow(unreachable_code)]
            Ok(String::new())
        })
        .await
        .unwrap();
        assert!(found.is_empty());
        assert_eq!(state.extraction_count, 0);
    }

    #[tokio::test]
    async fn a_pass_past_the_gates_returns_entries_and_advances_the_state() {
        let dir = tmp_dir("happy");
        let mut state = ExtractState::default();
        let turns = make_turns(26);
        let found = extract(&turns, &mut state, Trigger::TurnFinished, |prompt| async move {
            assert!(prompt.contains("reply 25"), "the conversation rides in the prompt");
            Ok(CANNED.to_string())
        })
        .await
        .unwrap();
        assert_eq!(found.len(), 4);
        assert_eq!(state.extraction_count, 1);
        assert_eq!(state.last_extracted_turn_index, turns.len());
        state.save(&dir, "sess-1").unwrap();
        assert_eq!(ExtractState::load(&dir, "sess-1").extraction_count, 1);

        // The very next finished turn is inside the cooldown.
        let mut more = turns.clone();
        more.push(turn("user", "and now?", 0));
        more.push(turn("assistant", "done", 0));
        let again = extract(&more, &mut state, Trigger::TurnFinished, |_| async {
            panic!("cooldown: fewer than three tool calls since the last pass");
            #[allow(unreachable_code)]
            Ok(String::new())
        })
        .await
        .unwrap();
        assert!(again.is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn session_end_extracts_a_short_session_over_only_the_new_turns() {
        let mut state = ExtractState {
            last_extracted_turn_index: 2,
            extraction_count: 1,
            ..Default::default()
        };
        let turns = make_turns(4);
        let found = extract(&turns, &mut state, Trigger::SessionEnd, |prompt| async move {
            assert!(!prompt.contains("reply 1\n"), "turns already extracted are not sent again");
            assert!(prompt.contains("reply 3"));
            Ok(CANNED.to_string())
        })
        .await
        .unwrap();
        assert_eq!(found.len(), 4);

        // Nothing new since: a second end pass has nothing to ask about.
        let none = extract(&turns, &mut state, Trigger::SessionEnd, |_| async {
            panic!("nothing new since the last pass");
            #[allow(unreachable_code)]
            Ok(String::new())
        })
        .await
        .unwrap();
        assert!(none.is_empty());
    }

    #[tokio::test]
    async fn a_failed_model_call_leaves_the_state_for_the_next_turn() {
        let mut state = ExtractState::default();
        let err = extract(&make_turns(26), &mut state, Trigger::TurnFinished, |_| async {
            Err(anyhow::anyhow!("offline"))
        })
        .await;
        assert!(err.is_err());
        assert_eq!(state.extraction_count, 0);
    }
}
