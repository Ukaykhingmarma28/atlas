//! Send composition: the exact text an agent is handed, turn by turn.

use std::cell::Cell;
use std::sync::Arc;

use atlas_agent_wire::AgentId;
use atlas_memory::record::{Entry, EntryKind, NewEntry};

use super::*;
use crate::commands::shared_memory::{store_for, EventKind, RawEvent};

/// Every store write and every ranking in these tests happens at this instant.
const NOW: i64 = 1_800_000_000_000;
const DAY_MS: i64 = 24 * 60 * 60 * 1000;

const NOTE: &str = "Background context from Atlas, not part of the user's message. \
                    Do not save any of it to your own memory.";

fn temp_project(label: &str) -> String {
    let dir = std::env::temp_dir().join(format!("atlas-briefing-{label}-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    dir.to_string_lossy().to_string()
}

fn store() -> SharedMemoryStore {
    SharedMemoryStore::with_clock(Arc::new(|| NOW))
}

fn key() -> SessionKey {
    SessionKey { agent_id: AgentId::new(), session_id: "s-new".into() }
}

fn append(store: &SharedMemoryStore, p: &str, agent: &str, kind: EventKind, key: &str, payload: serde_json::Value) {
    store
        .append_event(
            p,
            RawEvent { agent: agent.into(), session_id: format!("{agent}-session"), kind, key: key.into(), payload },
        )
        .unwrap();
}

/// A memory the one-time memdir migration brought in.
fn import_memdir_fact(p: &str, text: &str) {
    store_for(p)
        .unwrap()
        .upsert(NewEntry {
            kind: EntryKind::Fact,
            key: String::new(),
            content: text.into(),
            source: "import:memdir".into(),
            agent: String::new(),
            session_id: String::new(),
            confidence: 0.7,
            at: NOW,
        })
        .unwrap();
}

fn doc(id: &str, title: &str, source: &str, text: &str) -> RetrievedDoc {
    RetrievedDoc { id: id.into(), title: title.into(), source: source.into(), text: text.into() }
}

/// One turn through the real composition path, with retrieval and the
/// pack/handoff builders stubbed at their seams.
async fn turn(
    store: &SharedMemoryStore,
    sharing: &MemorySharingState,
    key: &SessionKey,
    p: &str,
    text: &str,
    retrieved: Vec<RetrievedDoc>,
) -> String {
    compose_turn(
        store,
        sharing,
        key,
        p,
        text,
        NOW,
        |_query| async move { retrieved },
        |_budget| async { vec!["--- PROJECT MEMORY ---\nPACK\n--- END PROJECT MEMORY ---".to_string(), "--- RECENT SESSION ---\nHANDOFF\n--- END RECENT SESSION ---".to_string()] },
    )
    .await
}

fn seed_project(store: &SharedMemoryStore, p: &str) {
    append(store, p, "claude-code", EventKind::PlanSet, "plan", serde_json::json!({"text": "Migrate auth to JWT"}));
    append(store, p, "codex", EventKind::FileChanged, "src/auth.rs", serde_json::json!({"path": "src/auth.rs", "summary": "sign with RS256"}));
    append(store, p, "codex", EventKind::FileChanged, "src/token.rs", serde_json::json!({"path": "src/token.rs"}));
    append(store, p, "codex", EventKind::Decision, "auth.alg", serde_json::json!({"text": "Use RS256 for JWT signing"}));
    import_memdir_fact(p, "The staging database resets nightly");
}

/// The exact first send: one envelope; working memory (plan, then files
/// newest first); the ranked index, memdir imports included; this turn's
/// relevant memory where it always sat; the curated pack and the handoff; the
/// user's words last.
#[tokio::test]
async fn first_send_is_the_briefing_in_order() {
    let (store, sharing, key, p) = (store(), MemorySharingState::new(), key(), temp_project("first"));
    seed_project(&store, &p);

    let out = turn(
        &store,
        &sharing,
        &key,
        &p,
        "why is the token rejected?",
        vec![doc("claude:auth.md", "Auth notes", "claude", "Tokens expire after 15 minutes")],
    )
    .await;

    assert_eq!(
        out,
        format!(
            "<atlas-memory>\n{NOTE}\n\
             --- SHARED MEMORY — WORKING MEMORY ---\n\
             [ACTIVE PLAN] (by claude-code)\n\
             Migrate auth to JWT\n\
             \n\
             [FILES CHANGED]\n\
             - src/token.rs (by codex)\n\
             - src/auth.rs — sign with RS256 (by codex)\n\
             --- END SHARED MEMORY ---\n\
             \n\
             --- SHARED MEMORY — INDEX ---\n\
             [DECISIONS]\n\
             - Use RS256 for JWT signing (by codex)\n\
             [FACTS]\n\
             - The staging database resets nightly (by import:memdir)\n\
             --- END SHARED MEMORY ---\n\
             \n\
             --- RELEVANT PROJECT MEMORY ---\n\
             - Auth notes (claude): Tokens expire after 15 minutes\n\
             --- END RELEVANT PROJECT MEMORY ---\n\
             \n\
             --- PROJECT MEMORY ---\nPACK\n--- END PROJECT MEMORY ---\n\
             \n\
             --- RECENT SESSION ---\nHANDOFF\n--- END RECENT SESSION ---\n\
             </atlas-memory>\n\nwhy is the token rejected?"
        )
    );
    // Every Atlas reader takes all of it back off again.
    assert_eq!(atlas_agent_transcript::strip_injected_context(&out), "why is the token rejected?");
}

/// Turns 2..N carry the delta by sync clock and the relevant-memory block —
/// no working memory, no index, no pack, no handoff — and a turn with neither
/// ships the user's words bare.
#[tokio::test]
async fn later_turns_carry_only_the_delta_and_relevant_memory() {
    let (store, sharing, key, p) = (store(), MemorySharingState::new(), key(), temp_project("later"));
    seed_project(&store, &p);
    turn(&store, &sharing, &key, &p, "start on the auth migration", Vec::new()).await;

    // Another agent records a failure between turns.
    append(&store, &p, "gemini", EventKind::Failure, "", serde_json::json!({"text": "HS256 keys leak in logs"}));
    let second = turn(
        &store,
        &sharing,
        &key,
        &p,
        "what should the key rotation look like?",
        vec![doc("codex:t1", "Rotation thread", "codex", "Rotate keys every 90 days")],
    )
    .await;
    assert_eq!(
        second,
        format!(
            "<atlas-memory>\n{NOTE}\n\
             --- SHARED MEMORY — UPDATES SINCE LAST TURN ---\n\
             [FAILURES / AVOID]\n\
             - HS256 keys leak in logs (by gemini)\n\
             --- END SHARED MEMORY ---\n\
             \n\
             --- RELEVANT PROJECT MEMORY ---\n\
             - Rotation thread (codex): Rotate keys every 90 days\n\
             --- END RELEVANT PROJECT MEMORY ---\n\
             </atlas-memory>\n\nwhat should the key rotation look like?"
        )
    );

    // Nothing new, nothing relevant: the turn ships bare.
    let third = turn(&store, &sharing, &key, &p, "and the refresh tokens then?", Vec::new()).await;
    assert_eq!(third, "and the refresh tokens then?");
}

/// A user's edit from the Memory panel reaches the agent on its very next
/// turn: a running session gets it as a delta, attributed to the user, and a
/// new session's briefing indexes the corrected wording, never the old one.
#[tokio::test]
async fn a_user_edit_reaches_the_next_turn() {
    let (store, sharing, key, p) = (store(), MemorySharingState::new(), key(), temp_project("edit"));
    seed_project(&store, &p);
    turn(&store, &sharing, &key, &p, "start on the auth migration", Vec::new()).await;

    let id = store.entries(&p).into_iter().find(|e| e.key == "auth.alg").unwrap().id;
    store.edit_entry(&p, id, "Use EdDSA for JWT signing").unwrap();

    let next = turn(&store, &sharing, &key, &p, "and the refresh tokens then?", Vec::new()).await;
    assert_eq!(
        next,
        format!(
            "<atlas-memory>\n{NOTE}\n\
             --- SHARED MEMORY — UPDATES SINCE LAST TURN ---\n\
             [DECISIONS]\n\
             - Use EdDSA for JWT signing (by user)\n\
             --- END SHARED MEMORY ---\n\
             </atlas-memory>\n\nand the refresh tokens then?"
        )
    );

    let fresh = SessionKey { agent_id: AgentId::new(), session_id: "s-after-edit".into() };
    let briefing = turn(&store, &sharing, &fresh, &p, "ok", Vec::new()).await;
    assert!(briefing.contains("- Use EdDSA for JWT signing (by user)"), "{briefing}");
    assert!(!briefing.contains("RS256 for JWT"), "{briefing}");
}

/// A memory forgotten from the Memory panel is gone from the next briefing.
#[tokio::test]
async fn a_forgotten_memory_is_not_briefed() {
    let (store, sharing, key, p) = (store(), MemorySharingState::new(), key(), temp_project("forgotten"));
    seed_project(&store, &p);
    let id = store.entries(&p).into_iter().find(|e| e.key == "auth.alg").unwrap().id;
    assert!(store.forget_entry(&p, id).unwrap());

    let briefing = turn(&store, &sharing, &key, &p, "ok", Vec::new()).await;
    assert!(!briefing.contains("RS256 for JWT"), "{briefing}");
    assert!(briefing.contains("The staging database resets nightly"), "{briefing}");
}

/// "continue" and "ok" inject no relevant-memory block — retrieval is not even
/// asked — while a real question does get one.
#[tokio::test]
async fn short_and_continuation_prompts_skip_relevant_memory() {
    let (store, sharing, key, p) = (store(), MemorySharingState::new(), key(), temp_project("floor"));
    turn(&store, &sharing, &key, &p, "set the project up", Vec::new()).await;

    for text in ["continue", "ok", "go on", "Keep going please!", "fix it"] {
        let asked = Cell::new(false);
        let out = compose_turn(
            &store,
            &sharing,
            &key,
            &p,
            text,
            NOW,
            |_q| {
                asked.set(true);
                async { vec![doc("claude:x", "X", "claude", "noise")] }
            },
            |_b| async { Vec::new() },
        )
        .await;
        assert_eq!(out, text, "{text:?} must ship with no relevant-memory block");
        assert!(!asked.get(), "{text:?} must not trigger retrieval");
    }

    let out = turn(
        &store,
        &sharing,
        &key,
        &p,
        "why does login fail on staging?",
        vec![doc("claude:staging.md", "Staging", "claude", "Staging resets nightly")],
    )
    .await;
    assert!(out.contains("--- RELEVANT PROJECT MEMORY ---\n- Staging (claude): Staging resets nightly\n"), "{out}");
}

/// A memdir memory is in the record (so the index lists it) and may still be in
/// the legacy retrieval graph: it reaches the agent once, through the index.
#[tokio::test]
async fn an_imported_memory_surfaces_once() {
    let (store, sharing, key, p) = (store(), MemorySharingState::new(), key(), temp_project("once"));
    seed_project(&store, &p);
    let decision_id = store_for(&p).unwrap().list(EntryKind::Decision, 1, Origin::Any).unwrap()[0].id;

    let out = turn(
        &store,
        &sharing,
        &key,
        &p,
        "does the staging database keep data?",
        vec![
            doc("graph::00ab", "The staging database", "graph", "resets nightly"),
            doc(&format!("shared:decision:{decision_id}"), "Use RS256", "shared", "[codex] Use RS256 for JWT signing"),
        ],
    )
    .await;
    assert_eq!(out.matches("resets nightly").count(), 1, "{out}");
    assert_eq!(out.matches("Use RS256 for JWT signing").count(), 1, "{out}");
    assert!(!out.contains("RELEVANT PROJECT MEMORY"), "{out}");

    // Later turns re-push neither: not the record entry under its own id,
    // not the memdir fact under the graph's.
    let later = turn(
        &store,
        &sharing,
        &key,
        &p,
        "remind me which signing algorithm we chose",
        vec![
            doc(&format!("shared:decision:{decision_id}"), "Use RS256", "shared", "[codex] Use RS256 for JWT signing"),
            doc("graph::00cd", "Staging", "graph", "The staging database resets nightly"),
        ],
    )
    .await;
    assert_eq!(later, "remind me which signing algorithm we chose");

    // A document that says more than an indexed entry is not a repeat.
    let unrelated = turn(
        &store,
        &sharing,
        &key,
        &p,
        "how do the RS256 keys get rotated?",
        vec![doc("claude:rotation.md", "Rotation", "claude", "We use RS256 for JWT signing keys and rotate them quarterly")],
    )
    .await;
    assert!(unrelated.contains("- Rotation (claude): We use RS256 for JWT signing keys"), "{unrelated}");
}

// ── Ranking and caps ─────────────────────────────────────────────────────────

fn entry(id: i64, kind: EntryKind, content: &str, confidence: f64, uses: u32, updated_at: i64, last_used_at: Option<i64>) -> Entry {
    Entry {
        id,
        kind,
        key: String::new(),
        content: content.into(),
        status: String::new(),
        source: "codex".into(),
        agent: "codex".into(),
        session_id: String::new(),
        confidence,
        created_at: updated_at,
        updated_at,
        last_used_at,
        uses,
        content_hash: String::new(),
        seq: None,
    }
}

/// A recently used high-confidence entry outranks an old unused one, even when
/// the old one was written later than the recent one was.
#[test]
fn ranking_prefers_recently_used_high_confidence() {
    let old_unused = entry(1, EntryKind::Decision, "Old unused", 0.5, 0, NOW - 90 * DAY_MS, None);
    let used = entry(2, EntryKind::Decision, "Recently used", 1.0, 4, NOW - 200 * DAY_MS, Some(NOW - DAY_MS));
    let block = compose_durable_index(&[old_unused, used], NOW, BRIEFING_MAX_CHARS).unwrap();
    assert_eq!(
        block,
        "--- SHARED MEMORY — INDEX ---\n\
         [DECISIONS]\n\
         - Recently used (by codex)\n\
         - Old unused (by codex)\n\
         --- END SHARED MEMORY ---"
    );
}

/// Each kind shows at most its display cap — its best entries — and the whole
/// index stays within 200 lines.
#[test]
fn caps_are_respected_per_kind() {
    let mut entries = Vec::new();
    for i in 0..60 {
        // Higher i = more recent = better.
        entries.push(entry(i, EntryKind::Decision, &format!("d{i}"), 1.0, 0, NOW - (60 - i) * DAY_MS, None));
    }
    for i in 0..40 {
        entries.push(entry(100 + i, EntryKind::Failure, &format!("f{i}"), 1.0, 0, NOW - (40 - i) * DAY_MS, None));
    }
    let block = compose_durable_index(&entries, NOW, usize::MAX).unwrap();
    let decisions = block.lines().filter(|l| l.starts_with("- d")).count();
    let failures = block.lines().filter(|l| l.starts_with("- f")).count();
    assert_eq!((decisions, failures), (50, 30));
    assert!(block.contains("- d59 (by codex)") && !block.contains("- d9 (by codex)"));
    assert!(block.contains("- f39 (by codex)") && !block.contains("- f9 (by codex)"));
    assert!(block.lines().count() <= INDEX_MAX_LINES);
}

// ── Budget ───────────────────────────────────────────────────────────────────

/// With every source at its ceiling — a long plan, fifty file changes, every
/// durable kind far past its cap with long entries, a full pack, a full
/// handoff and a full relevant-memory block — the whole first-send injection
/// stays within today's budget.
#[tokio::test]
async fn the_first_send_stays_within_todays_budget() {
    let (store, sharing, key, p) = (store(), MemorySharingState::new(), key(), temp_project("budget"));
    let long = |tag: &str, i: usize| format!("{tag} {i} {}", "lorem ipsum dolor sit amet ".repeat(20));
    append(&store, &p, "claude-code", EventKind::PlanSet, "plan", serde_json::json!({"text": long("plan", 0).repeat(5)}));
    for i in 0..60 {
        let path = format!("src/module_{i}/file.rs");
        append(&store, &p, "codex", EventKind::FileChanged, &path, serde_json::json!({"path": path, "summary": long("edit", i)}));
    }
    for (kind, n) in [(EventKind::Decision, 80), (EventKind::Fact, 80), (EventKind::Failure, 50), (EventKind::Architecture, 50)] {
        for i in 0..n {
            append(&store, &p, "codex", kind, &format!("{kind:?}-{i}"), serde_json::json!({"text": long(&format!("{kind:?}"), i)}));
        }
    }

    let budget_seen = Cell::new(0usize);
    let text = "summarise where the auth migration stands";
    let out = compose_turn(
        &store,
        &sharing,
        &key,
        &p,
        text,
        NOW,
        |_q| async {
            (0..3).map(|i| doc(&format!("claude:{i}"), "Doc", "claude", &"x".repeat(2_000))).collect()
        },
        |budget| {
            budget_seen.set(budget);
            // A pack that fills exactly the budget it was given, and a handoff
            // at today's ceiling.
            let docs = (0..60)
                .map(|i| agent_memory::MemoryDoc {
                    id: format!("claude:{i}"),
                    title: format!("T{i}"),
                    summary: String::new(),
                    kind: "project".into(),
                    source: "claude".into(),
                    file_path: None,
                    timestamp_ms: i,
                    text: "y".repeat(1_000),
                    aliases: Vec::new(),
                    links: Vec::new(),
                })
                .collect();
            let pack = memory_pack::curate_pack(docs, budget);
            let turns = (0..8).map(|_| format!("Assistant: {}", "z".repeat(801))).collect::<Vec<_>>().join("\n");
            let handoff = memory_pack::wrap_handoff(&turns, 8, "raw");
            async move { pack.into_iter().chain(Some(handoff)).collect() }
        },
    )
    .await;

    let injected = out.len() - text.len();
    assert!(injected <= FIRST_SEND_MAX_CHARS, "{injected} > {FIRST_SEND_MAX_CHARS}");
    assert!(budget_seen.get() >= memory_inject::BLOCK_MAX_CHARS, "the pack keeps a real budget: {}", budget_seen.get());
    assert!(out.contains("--- SHARED MEMORY — INDEX ---") && out.contains("--- PROJECT MEMORY ---"));
    let index = out.split("--- SHARED MEMORY — INDEX ---").nth(1).unwrap().split("--- END SHARED MEMORY ---").next().unwrap();
    assert!(index.lines().count() <= INDEX_MAX_LINES);
}

/// The first send after switching agents, end to end through the real handoff
/// builder: Codex ran the previous session (recorded by capture), Claude opens
/// the next one, and Claude's first send carries Codex's tail inside the
/// envelope — the same text whichever agent came before. A second send does
/// not repeat it.
#[tokio::test]
async fn the_first_send_after_an_agent_switch_carries_the_previous_agents_tail() {
    use crate::commands::memory_pack::test_support::{record_session, scratch_project};
    use atlas_checkpoint::{Mode, Role};

    let (store, sharing, key, p) = (store(), MemorySharingState::new(), key(), scratch_project("switch"));
    record_session(
        &p,
        "codex-1",
        "codex",
        &[
            (Role::User, Mode::Text, "add rate limiting to login"),
            (Role::Assistant, Mode::Tool, "edit src/limit.rs"),
            (Role::Assistant, Mode::Text, "Added a token bucket in src/limit.rs"),
        ],
    );
    let transcripts = std::path::PathBuf::from(scratch_project("transcripts"));
    let send = |text: &'static str| {
        let (store, sharing, key, p, transcripts) = (&store, &sharing, &key, &p, &transcripts);
        async move {
            compose_turn(store, sharing, key, p, text, NOW, |_q| async { Vec::new() }, |_budget| async move {
                let raw = memory_pack::build_session_handoff(p, &key.session_id, transcripts);
                let never = |_: String, _: String, _: String| async { unreachable!("raw preference") };
                memory_pack::handoff_block(raw, &crate::commands::memory_sharing::SummarizerPref::default(), never).await.into_iter().collect()
            })
            .await
        }
    };

    assert_eq!(
        send("does the limiter cover signup too?").await,
        format!(
            "<atlas-memory>\n{NOTE}\n\
             --- RECENT SESSION ---\n\
             User: add rate limiting to login\n\
             Assistant: Added a token bucket in src/limit.rs\n\
             (last 2 turns · raw)\n\
             --- END RECENT SESSION ---\n\
             </atlas-memory>\n\ndoes the limiter cover signup too?"
        )
    );
    assert_eq!(send("and the reset endpoint?").await, "and the reset endpoint?");
}
