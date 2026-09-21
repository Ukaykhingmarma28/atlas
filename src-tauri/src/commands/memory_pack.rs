//! Shared Cross-Agent Memory — pack + handoff builders.
//!
//! Two pieces of context get prepended to an agent's first message:
//!   1. **Curated pack** — high-signal facts from Atlas's per-project memory
//!      (`collect_corpus`), filtered to the curated kinds, recency-ranked, and
//!      budget-bounded. Built by [`build_memory_pack`] / [`curate_pack`].
//!   2. **Recent-session handoff** — the tail of the most recent *other*
//!      session for this scope, whichever agent ran it, read from what Atlas
//!      recorded (capture, then its own transcripts) — never from an agent's
//!      private files. Built by [`build_session_handoff`]; the optional
//!      summariser is applied by [`handoff_block`].
//!
//! [`compose_injection`] stitches every present block in front of the user's
//! text, inside one `<atlas-memory>` envelope that tells the agent the content
//! is background and must not be saved. Every builder returns `Option`/empty so
//! an absent source is a true no-op (no delimiters, no envelope, no allocation)
//! — see the empty-pack hardening rule.
//!
//! Disk-touching entry points are kept thin around pure functions
//! (`curate_pack`, `handoff_turns`) so the ranking, filtering, and budgeting
//! logic is unit-testable without a filesystem.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use atlas_checkpoint::{Mode, Role, Store};
use chrono::{DateTime, Utc};

use super::agent_memory::{collect_corpus, MemoryDoc};

/// Kinds that belong in a curated pack (from frontmatter `metadata.type`).
/// Deliberately excludes `index`, `instruction`, `thread`, `file`, `memory` —
/// those are either redundant, raw code, or too noisy for cross-agent priming.
const PACK_KINDS: [&str; 4] = ["feedback", "user", "project", "reference"];

/// Total character budget for the curated pack body.
pub(crate) const PACK_MAX_CHARS: usize = 8_000;

/// Per-entry body cap so one long fact can't dominate the pack.
const ENTRY_MAX_CHARS: usize = 400;

/// How many trailing turns of the previous session to carry over.
const HANDOFF_MAX_TURNS: usize = 8;

/// Per-turn cap for the raw handoff so a giant message can't blow the budget.
const TURN_MAX_CHARS: usize = 800;

/// The raw handoff body's ceiling: every carried turn at its cap, with its
/// role prefix, truncation mark and line break.
#[cfg(test)]
pub(crate) const HANDOFF_MAX_CHARS: usize = HANDOFF_MAX_TURNS * (TURN_MAX_CHARS + 16);

// ── Curated pack ─────────────────────────────────────────────────────────────

/// Build the curated pack for a project within `max_chars` of body (at most
/// [`PACK_MAX_CHARS`]; the session-start briefing hands the pack what it left
/// of that budget). Async because `collect_corpus` is async (it does its own
/// `spawn_blocking` internally). Returns `None` when no curated facts exist —
/// caller treats that as "inject nothing".
pub async fn build_memory_pack(project_path: &str, max_chars: usize) -> Option<String> {
    let docs = collect_corpus(project_path).await;
    curate_pack(docs, max_chars)
}

/// Pure core of the pack builder: filter to curated kinds, rank newest-first,
/// and accumulate entries until the `max_chars` body budget is hit. Returns the
/// full block (delimiters + footer) or `None` if nothing qualifies or fits.
pub fn curate_pack(mut docs: Vec<MemoryDoc>, max_chars: usize) -> Option<String> {
    docs.retain(|d| PACK_KINDS.contains(&d.kind.as_str()));
    if docs.is_empty() {
        return None;
    }
    // Newest first — the most recent conventions/decisions matter most.
    docs.sort_by_key(|doc| std::cmp::Reverse(doc.timestamp_ms));

    let mut body = String::new();
    let mut count = 0usize;
    for d in &docs {
        let raw = if d.text.trim().is_empty() {
            d.summary.as_str()
        } else {
            d.text.as_str()
        };
        let entry = format!(
            "[{}] {}\n{}\n\n",
            d.kind,
            d.title,
            truncate_chars(raw.trim(), ENTRY_MAX_CHARS)
        );
        // Always include at least one entry; stop before exceeding the budget.
        // (The briefing never leaves less than the old shared block's budget,
        // well above one capped entry.)
        if count > 0 && body.len() + entry.len() > max_chars {
            break;
        }
        body.push_str(&entry);
        count += 1;
    }
    if count == 0 {
        return None;
    }
    let footer = format!("({} memories · {} chars)", count, body.trim_end().len());
    Some(format!(
        "--- PROJECT MEMORY ---\n{body}{footer}\n--- END PROJECT MEMORY ---"
    ))
}

// ── Recent-session handoff ───────────────────────────────────────────────────

/// The tail of the most recent *other* session in this scope, whichever agent
/// ran it, as `(raw_body, turn_count)` — at most [`HANDOFF_MAX_TURNS`] turns,
/// each capped at [`TURN_MAX_CHARS`]. Sync — call via `spawn_blocking`.
/// Returns `None` when no other session has anything to hand off.
///
/// Reads only what Atlas recorded itself, never an agent's private files:
///   1. the **capture store** (`atlas-checkpoint`) of every worktree of the
///      repository — which also holds transcripts its importer brought in;
///   2. Atlas's own **session transcripts** (`transcripts_dir`, the
///      [`agent_transcript`] store), which record every agent whether or not
///      capture was ever enabled. A session present in both is read from
///      capture (its bodies are redacted).
///
/// "Most recent" is the session's last activity; the current session is
/// skipped, and so is a session with nothing to hand off (a newer, empty one
/// does not hide an older real one).
///
/// [`agent_transcript`]: super::agent_transcript
pub fn build_session_handoff(
    cwd: &str,
    current_session_id: &str,
    transcripts_dir: &Path,
) -> Option<(String, usize)> {
    let roots = scope_roots(cwd, transcripts_dir);
    // A root whose capture was never enabled has no store and is skipped.
    let stores: Vec<(&PathBuf, Store)> = roots
        .iter()
        .filter_map(|root| {
            let store = crate::commands::capture::open_reader(&root.to_string_lossy()).ok().flatten()?;
            Some((root, store))
        })
        .collect();

    let mut heads: Vec<SessionHead> = Vec::new();
    for (store_idx, (root, store)) in stores.iter().enumerate() {
        heads.extend(capture_heads(root, store, store_idx));
    }
    let captured: Vec<String> = heads.iter().map(|h| h.native_id.clone()).collect();
    heads.extend(
        transcript_heads(transcripts_dir, &roots)
            .into_iter()
            .filter(|h| !captured.iter().any(|id| same_session(&h.native_id, id))),
    );
    // Newest first; `sort_by` is stable, so capture wins a tie.
    heads.sort_by(|a, b| b.last_activity.cmp(&a.last_activity));

    heads
        .iter()
        .filter(|h| !same_session(&h.native_id, current_session_id))
        .find_map(|h| {
            let entries = match &h.origin {
                Origin::Capture { store_idx, session_id } => capture_entries(&stores[*store_idx].1, session_id),
                Origin::Transcript { path } => transcript_entries(path),
            };
            let turns = handoff_turns(entries, HANDOFF_MAX_TURNS);
            (!turns.is_empty()).then(|| (format_turns(&turns), turns.len()))
        })
}

/// One recorded session, before its messages are read.
struct SessionHead {
    native_id: String,
    last_activity: DateTime<Utc>,
    origin: Origin,
}

enum Origin {
    Capture { store_idx: usize, session_id: String },
    Transcript { path: PathBuf },
}

/// Every launch directory whose recordings belong to this scope. Outside git
/// that is `cwd` alone. In a repository it is every worktree (worktrees share
/// a scope) and every subdirectory of one that Atlas has recorded a session in
/// (subdirectory launches share it too) — found through the transcripts Atlas
/// keeps for every session, since each launch directory keeps its own capture
/// store.
fn scope_roots(cwd: &str, transcripts_dir: &Path) -> Vec<PathBuf> {
    let mut roots = vec![PathBuf::from(cwd)];
    let mut seen: HashSet<PathBuf> = HashSet::from([canonical(Path::new(cwd))]);
    let worktrees: Vec<PathBuf> = atlas_checkpoint::git::worktree_paths(Path::new(cwd))
        .iter()
        .map(|w| canonical(w))
        .collect();
    if worktrees.is_empty() {
        return roots;
    }
    for wt in &worktrees {
        if seen.insert(wt.clone()) {
            roots.push(wt.clone());
        }
    }
    let scope = canonical(&atlas_checkpoint::git::scope_root(Path::new(cwd)));
    for (launched, _) in super::agent_transcript::recorded_projects(transcripts_dir) {
        let dir = canonical(Path::new(&launched));
        // The prefix test is cheap and rules out almost everything; the scope
        // check keeps out a nested repository (a submodule) under a worktree.
        if !seen.contains(&dir)
            && worktrees.iter().any(|wt| dir.starts_with(wt))
            && canonical(&atlas_checkpoint::git::scope_root(&dir)) == scope
        {
            seen.insert(dir);
            roots.push(PathBuf::from(launched));
        }
    }
    roots
}

fn canonical(p: &Path) -> PathBuf {
    dunce::canonicalize(p).unwrap_or_else(|_| p.to_path_buf())
}

/// Is a recorded session id this session? A transcript file is named by the
/// id with unsafe characters replaced, so it matches either spelling.
fn same_session(recorded: &str, id: &str) -> bool {
    recorded == id || recorded == super::agent_transcript::sanitize_id(id)
}

fn capture_heads(root: &Path, store: &Store, store_idx: usize) -> Vec<SessionHead> {
    // Live capture keys a Workspace by its canonical path; the importer by the
    // path as given. Read both, once each.
    let mut ids = vec![crate::commands::capture::project_id_for(root)];
    let lexical = root.to_string_lossy().to_string();
    if !ids.contains(&lexical) {
        ids.push(lexical);
    }
    let mut seen = HashSet::new();
    ids.iter()
        .flat_map(|id| store.sessions_for_project(id).unwrap_or_default())
        .filter(|s| seen.insert(s.id.clone()))
        .map(|s| SessionHead {
            native_id: s.native_session_id,
            last_activity: s.last_activity_at.unwrap_or(s.updated_at),
            origin: Origin::Capture { store_idx, session_id: s.id },
        })
        .collect()
}

/// The session's conversation in order: user prompts and assistant replies
/// only — tool calls, thinking and system rows are not a handoff.
fn capture_entries(store: &Store, session_id: &str) -> Vec<(Speaker, String)> {
    store
        .messages_for_session(session_id)
        .unwrap_or_default()
        .iter()
        .filter(|m| m.mode == Mode::Text)
        .filter_map(|m| {
            let speaker = match m.role {
                Role::User => Speaker::User,
                Role::Assistant => Speaker::Assistant,
                Role::System => return None,
            };
            let body = store.message_body(m).unwrap_or_else(|e| {
                // A spilled body whose blob is gone: the always-inline
                // preview is the most that is left of the turn.
                tracing::warn!(target: "atlas::memory_sharing", "handoff read a turn's preview, its body is unreadable: {e}");
                m.preview.clone()
            });
            Some((speaker, body))
        })
        .collect()
}

fn transcript_heads(transcripts_dir: &Path, roots: &[PathBuf]) -> Vec<SessionHead> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    for root in roots {
        for cwd in [root.to_string_lossy().to_string(), canonical(root).to_string_lossy().to_string()] {
            let dir = super::agent_transcript::dir_for(transcripts_dir, &cwd);
            if !dirs.contains(&dir) {
                dirs.push(dir);
            }
        }
    }
    dirs.iter()
        .flat_map(|dir| super::agent_transcript::session_files(dir))
        .map(|f| SessionHead {
            native_id: f.file_id,
            last_activity: DateTime::<Utc>::from(f.modified),
            origin: Origin::Transcript { path: f.path },
        })
        .collect()
}

fn transcript_entries(path: &Path) -> Vec<(Speaker, String)> {
    let Some(t) = super::agent_transcript::read_file(path) else {
        return Vec::new();
    };
    t.messages
        .into_iter()
        .filter_map(|m| match m.role.as_str() {
            "user" => Some((Speaker::User, m.content)),
            "assistant" => Some((Speaker::Assistant, m.content)),
            _ => None,
        })
        .collect()
}

/// Who said a recorded line.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Speaker {
    User,
    Assistant,
}

impl Speaker {
    /// The line prefix the handoff has always used.
    fn label(self) -> &'static str {
        match self {
            Self::User => "User",
            Self::Assistant => "Assistant",
        }
    }
}

/// Pure: the last `max_turns` handoff-worthy turns of a recorded conversation.
/// A user turn keeps only what the user said ([`prose_only`]); an assistant
/// turn is its trimmed text. Empty turns drop.
fn handoff_turns(entries: Vec<(Speaker, String)>, max_turns: usize) -> Vec<(Speaker, String)> {
    let mut turns: Vec<(Speaker, String)> = entries
        .into_iter()
        .filter_map(|(speaker, text)| {
            let text = match speaker {
                Speaker::User => prose_only(&text)?,
                Speaker::Assistant => text.trim().to_string(),
            };
            (!text.is_empty()).then_some((speaker, text))
        })
        .collect();
    if turns.len() > max_turns {
        turns = turns.split_off(turns.len() - max_turns);
    }
    turns
}

/// What the user actually said in a recorded user turn, or `None` if they said
/// nothing.
///
/// The turn on disk is the *wire* prompt, so it carries whatever Atlas
/// prepended. Stripping first and judging second is what keeps the question
/// inside a context-carrying turn eligible for the handoff: the envelope opens
/// with `<`, which [`is_injected_user_text`] reads as machinery, so testing the
/// raw text would drop the user's words along with the scaffolding.
///
/// [`is_injected_user_text`]: atlas_agent_transcript::is_injected_user_text
fn prose_only(raw: &str) -> Option<String> {
    let text = atlas_agent_transcript::strip_injected_context(raw);
    if atlas_agent_transcript::is_injected_user_text(&text) {
        return None;
    }
    Some(text.trim().to_string())
}

fn format_turns(turns: &[(Speaker, String)]) -> String {
    turns
        .iter()
        .map(|(speaker, text)| format!("{}: {}", speaker.label(), truncate_chars(text, TURN_MAX_CHARS)))
        .collect::<Vec<_>>()
        .join("\n")
}

/// The handoff block for a first send, from [`build_session_handoff`]'s raw
/// tail: summarised when the preference asks for the BYOK provider and names
/// one, verbatim otherwise. A summariser that hands back the raw text (its
/// failure fallback) is attributed as raw, not as a summary.
pub async fn handoff_block<S, SF>(
    raw: Option<(String, usize)>,
    pref: &super::memory_sharing::SummarizerPref,
    summarize: S,
) -> Option<String>
where
    S: FnOnce(String, String, String) -> SF,
    SF: std::future::Future<Output = String>,
{
    let (raw_body, turns) = raw?;
    let (body, attribution) =
        if pref.mode == "provider" && !pref.provider.is_empty() && !pref.model.is_empty() {
            let summary = summarize(raw_body.clone(), pref.provider.clone(), pref.model.clone()).await;
            if summary == raw_body {
                (raw_body, "raw".to_string())
            } else {
                (summary, format!("summarized by {}/{}", pref.provider, pref.model))
            }
        } else {
            (raw_body, "raw".to_string())
        };
    Some(wrap_handoff(&body, turns, &attribution))
}

/// Wrap a raw handoff body in the labelled block with an attribution footer.
pub fn wrap_handoff(body: &str, turn_count: usize, attribution: &str) -> String {
    format!(
        "--- RECENT SESSION ---\n{body}\n(last {turn_count} turns · {attribution})\n--- END RECENT SESSION ---"
    )
}

// ── Composition ──────────────────────────────────────────────────────────────

/// Prepend the already-wrapped `blocks` to the user's text inside one
/// `<atlas-memory>` envelope. With no block present this returns `user_text`
/// unchanged (zero-overhead no-op).
///
/// One envelope for the whole prompt, not one per block: the note line that
/// opens it tells the agent the content is background and must not be saved,
/// and repeating that per block would spend the budget on the same sentence
/// four times. Every Atlas reader strips the envelope again
/// (`atlas_agent_transcript::strip_injected_context`), so an agent that saves
/// the prompt anyway cannot feed it back into the corpus.
pub fn compose_injection(blocks: &[&str], user_text: &str) -> String {
    match atlas_agent_transcript::wrap_memory_envelope(blocks) {
        Some(envelope) => format!("{envelope}\n\n{user_text}"),
        None => user_text.to_string(),
    }
}

/// Does this turn's text open with a slash command (`/skill-name [args]`)?
///
/// Load-bearing for correctness, not a nicety. Claude Code resolves slash
/// commands — including skills — only when the command sits at **byte 0 of the
/// first text block** (`claude-agent-acp` gates on `firstText.startsWith("/")`,
/// and `promptToClaude` anchors its rewrites with `^`). Every context block
/// Atlas *prepends* therefore pushes the command off byte 0 and demotes it to
/// prose: the command silently never fires. It is most visible on skills marked
/// `disable-model-invocation: true`, because the model cannot see those in its
/// own skill list either, so the turn dead-ends in "that skill isn't installed"
/// instead of the model quietly invoking it anyway and masking the failure.
///
/// Deliberately rejects absolute paths — `/Users/me/foo.rs is broken` opens with
/// a slash but is prose, and the interior `/` is what tells the two apart. A
/// command token runs to whitespace or end-of-string over
/// `[A-Za-z0-9_:-]` (`:` so plugin commands like `/codex:rescue` qualify).
pub fn is_slash_command(text: &str) -> bool {
    let Some(rest) = text.strip_prefix('/') else {
        return false;
    };
    let mut chars = rest.chars();
    // A command name opens alphanumeric: rules out `/ hello`, `/-x`, and `//`.
    match chars.next() {
        Some(c) if c.is_ascii_alphanumeric() => {}
        _ => return false,
    }
    for c in chars {
        if c.is_whitespace() {
            return true; // token closed cleanly, args may follow
        }
        if !(c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == ':') {
            return false; // e.g. the `/` in `/Users/me` — a path, not a command
        }
    }
    true
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/// Truncate to at most `max` characters (char-boundary safe), appending `…`.
fn truncate_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max).collect();
    out.push('…');
    out
}

// ── Tests ────────────────────────────────────────────────────────────────────

/// Fixture capture sessions, recorded through the real capture recorder into a
/// scratch Workspace — what the handoff reads in production.
#[cfg(test)]
pub(crate) mod test_support {
    use atlas_checkpoint::{model::ProjectMode, Capture, Mode, Role, SessionKey, Source, Store, TurnContent};

    /// A fresh scratch directory standing in for a project.
    pub(crate) fn scratch_project(label: &str) -> String {
        let dir = std::env::temp_dir().join(format!("atlas-handoff-{label}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.to_string_lossy().to_string()
    }

    /// Record one session for `agent` into the capture store at `project`:
    /// every `User` entry opens a turn (as a send does), everything else is
    /// recorded inside the turn it follows.
    pub(crate) fn record_session(project: &str, native_id: &str, agent: &str, entries: &[(Role, Mode, &str)]) {
        let mut store = Store::open(atlas_checkpoint::atlas_dir(project)).expect("capture store opens");
        let mut capture = Capture::new(&mut store, ProjectMode::Local);
        let key = SessionKey {
            workspace_id: crate::commands::capture::project_id_for(std::path::Path::new(project)),
            // As live capture files it: the native agent under its own source.
            source: if agent == atlas_native_agent::CERSEI_AGENT_ID { Source::Cersei } else { Source::Acp },
            native_session_id: native_id.into(),
        };
        let (mut turn, mut row) = (0i64, String::new());
        for (i, (role, mode, body)) in entries.iter().enumerate() {
            if *role == Role::User && *mode == Mode::Text {
                turn += 1;
                row = capture
                    .record_prompt(&key, body, turn, Some(agent), None, Some(project))
                    .expect("prompt recorded");
            } else {
                capture
                    .record_turn(
                        &row,
                        TurnContent {
                            turn_seq: turn,
                            native_message_id: Some(format!("{native_id}-{i}")),
                            role: *role,
                            mode: *mode,
                            body: body.to_string(),
                            created_at: None,
                        },
                    )
                    .expect("turn recorded");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::{record_session, scratch_project};
    use super::*;
    use atlas_checkpoint::{Mode, Role};

    const U: (Role, Mode) = (Role::User, Mode::Text);
    const A: (Role, Mode) = (Role::Assistant, Mode::Text);

    /// Where Atlas's own transcripts would live — empty unless a test writes one.
    fn no_transcripts() -> PathBuf {
        PathBuf::from(scratch_project("transcripts"))
    }

    /// Record `messages` as Atlas's own transcript of a session run in `cwd`.
    fn save_transcript(transcripts: &Path, cwd: &str, id: &str, agent: &str, messages: &[(&str, &str)]) {
        use super::super::agent_transcript::{save, StoredMessage, StoredTranscript};
        let at = "2026-09-19T10:00:00Z".to_string();
        save(
            transcripts,
            &StoredTranscript {
                id: id.into(),
                plugin_id: agent.into(),
                cwd: cwd.into(),
                created_at: at.clone(),
                updated_at: at.clone(),
                messages: messages
                    .iter()
                    .map(|(role, content)| StoredMessage {
                        role: (*role).into(),
                        content: (*content).into(),
                        timestamp: at.clone(),
                        model: None,
                        live_id: None,
                    })
                    .collect(),
            },
        )
        .unwrap();
    }

    /// Run git in `dir`, with an identity so commits work anywhere.
    fn git(dir: &str, args: &[&str]) {
        let out = std::process::Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"])
            .args(args)
            .output()
            .expect("git runs");
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    }

    /// A fresh repository with one commit; returns its main worktree.
    fn scratch_repo(label: &str) -> String {
        let main = scratch_project(label);
        git(&main, &["init", "-q"]);
        git(&main, &["commit", "-q", "--allow-empty", "-m", "init"]);
        main
    }

    /// A Codex session followed by a Claude session: Claude's first send
    /// carries Codex's tail, read from capture rather than any agent's files.
    #[test]
    fn a_codex_session_hands_off_to_claude() {
        let p = scratch_project("codex-claude");
        record_session(
            &p,
            "codex-1",
            "codex",
            &[(U.0, U.1, "add rate limiting to login"), (A.0, A.1, "Added a token bucket in src/limit.rs")],
        );
        record_session(&p, "claude-now", "claude-code", &[(U.0, U.1, "carry on")]);

        assert_eq!(
            build_session_handoff(&p, "claude-now", &no_transcripts()),
            Some((
                "User: add rate limiting to login\nAssistant: Added a token bucket in src/limit.rs".to_string(),
                2
            ))
        );
    }

    fn doc(kind: &str, title: &str, text: &str, ts: i64) -> MemoryDoc {
        MemoryDoc {
            id: format!("claude:{title}"),
            title: title.into(),
            summary: text.into(),
            kind: kind.into(),
            source: "claude".into(),
            file_path: None,
            timestamp_ms: ts,
            text: text.into(),
            aliases: Vec::new(),
            links: Vec::new(),
        }
    }

    /// A Claude session followed by Atlas Agent (stored agent id `cersei`):
    /// the same handoff, with no agent-identity special-casing either way.
    #[test]
    fn a_claude_session_hands_off_to_atlas_agent() {
        let p = scratch_project("claude-cersei");
        record_session(
            &p,
            "claude-1",
            "claude-code",
            &[(U.0, U.1, "why does the build fail on CI?"), (A.0, A.1, "The lockfile was stale; regenerated it.")],
        );
        record_session(&p, "cersei-now", "cersei", &[(U.0, U.1, "what next")]);

        assert_eq!(
            build_session_handoff(&p, "cersei-now", &no_transcripts()),
            Some((
                "User: why does the build fail on CI?\nAssistant: The lockfile was stale; regenerated it.".to_string(),
                2
            ))
        );
    }

    /// Today's budgets, unchanged: the last 8 conversational turns, each cut to
    /// 800 characters with `…`; tool calls and thinking are not turns.
    #[test]
    fn the_handoff_keeps_todays_turn_and_character_budgets() {
        let p = scratch_project("budgets");
        let long: Vec<String> = (0..20).map(|i| format!("m{i:02} {}", "x".repeat(900))).collect();
        let mut entries: Vec<(Role, Mode, &str)> = Vec::new();
        for m in &long {
            entries.push((Role::User, Mode::Text, m));
            entries.push((Role::Assistant, Mode::Tool, "ran cargo test"));
            entries.push((Role::Assistant, Mode::Thinking, "pondering"));
        }
        record_session(&p, "codex-long", "codex", &entries);

        let (body, turns) = build_session_handoff(&p, "someone-else", &no_transcripts()).expect("handoff");
        assert_eq!(turns, 8);
        let expected: Vec<String> = (12..20)
            .map(|i| format!("User: m{i} {}…", "x".repeat(800 - 4)))
            .collect();
        assert_eq!(body, expected.join("\n"));
        assert!(body.chars().count() <= HANDOFF_MAX_CHARS);
    }

    /// Capture holds the prompt as typed, but an imported transcript holds the
    /// *wire* prompt: a turn that carried context hands off the user's words
    /// and none of the scaffolding; a turn that was only context is dropped.
    #[test]
    fn a_recorded_turn_drops_the_envelope_and_keeps_the_question() {
        let p = scratch_project("envelope");
        let wire = compose_injection(
            &["--- PROJECT MEMORY ---\nuse RS256\n--- END PROJECT MEMORY ---"],
            "why is auth failing?",
        );
        let only_context = compose_injection(&["--- PROJECT MEMORY ---\nx\n--- END PROJECT MEMORY ---"], "");
        record_session(
            &p,
            "imported-1",
            "claude-code",
            &[
                (U.0, U.1, &wire),
                (A.0, A.1, "Clock skew on the verifier."),
                (U.0, U.1, &only_context),
                (U.0, U.1, "<system-reminder>injected</system-reminder>"),
            ],
        );
        assert_eq!(
            build_session_handoff(&p, "now", &no_transcripts()),
            Some(("User: why is auth failing?\nAssistant: Clock skew on the verifier.".to_string(), 2))
        );
    }

    /// The most recent *other* session wins, whichever agent ran it; the
    /// current session is never handed to itself, and a newer session with
    /// nothing to say does not hide an older one that has.
    #[test]
    fn the_most_recent_other_session_wins() {
        let p = scratch_project("newest");
        record_session(&p, "old", "claude-code", &[(U.0, U.1, "old question")]);
        record_session(&p, "mid", "gemini", &[(U.0, U.1, "gemini question")]);
        record_session(&p, "empty", "codex", &[(U.0, U.1, "<system-reminder>x</system-reminder>")]);
        record_session(&p, "now", "codex", &[(U.0, U.1, "current question")]);

        assert_eq!(
            build_session_handoff(&p, "now", &no_transcripts()),
            Some(("User: gemini question".to_string(), 1))
        );
        assert_eq!(build_session_handoff(&scratch_project("nothing"), "now", &no_transcripts()), None);
    }

    /// Capture is opt-in. Where it was never enabled, the handoff still works
    /// for any agent from the transcripts Atlas records for every session.
    #[test]
    fn without_capture_the_handoff_reads_atlas_transcripts() {
        let p = scratch_project("no-capture");
        let transcripts = no_transcripts();
        save_transcript(
            &transcripts,
            &p,
            "codex-1",
            "codex",
            &[("user", "rename the crate"), ("assistant", "Renamed to atlas-core.")],
        );

        assert_eq!(
            build_session_handoff(&p, "claude-now", &transcripts),
            Some(("User: rename the crate\nAssistant: Renamed to atlas-core.".to_string(), 2))
        );
        assert_eq!(build_session_handoff(&p, "codex-1", &transcripts), None, "never a self-handoff");
    }

    /// Worktrees of one repository share a scope: a session run in a linked
    /// worktree hands off to the next session in the main checkout.
    #[test]
    fn worktrees_of_one_repository_share_the_handoff() {
        let main = scratch_repo("repo");
        let linked = format!("{main}-wt");
        git(&main, &["worktree", "add", "-q", &linked]);

        record_session(&linked, "codex-wt", "codex", &[(U.0, U.1, "fix the flaky test")]);
        assert_eq!(
            build_session_handoff(&main, "claude-main", &no_transcripts()),
            Some(("User: fix the flaky test".to_string(), 1))
        );
    }

    /// A subdirectory launch shares the repository's scope too: the previous
    /// session ran from `crates/core`, the next one opens at the root, and the
    /// handoff finds it — from that launch's capture store, which wins over
    /// the transcript copy of the same session.
    #[test]
    fn a_subdirectory_launch_shares_the_handoff() {
        let main = scratch_repo("subdir");
        let sub = format!("{main}/crates/core");
        std::fs::create_dir_all(&sub).unwrap();
        let transcripts = no_transcripts();

        record_session(&sub, "gemini-sub", "gemini", &[(U.0, U.1, "token sk-live-secret leaked?")]);
        save_transcript(&transcripts, &sub, "gemini-sub", "gemini", &[("user", "transcript copy")]);

        let (body, turns) = build_session_handoff(&main, "claude-root", &transcripts).expect("handoff");
        assert_eq!(turns, 1);
        assert!(body.starts_with("User: token "), "{body}");
        assert!(!body.contains("transcript copy"), "capture wins over the transcript copy: {body}");

        // Outside git the scope is the launch directory alone.
        let plain = scratch_project("plain");
        let plain_sub = format!("{plain}/sub");
        std::fs::create_dir_all(&plain_sub).unwrap();
        save_transcript(&transcripts, &plain_sub, "codex-sub", "codex", &[("user", "elsewhere")]);
        assert_eq!(build_session_handoff(&plain, "now", &transcripts), None);
    }

    /// Summariser behaviour, as today: raw by default; the BYOK provider when
    /// the preference names one; raw again when the summariser falls back.
    #[tokio::test]
    async fn the_optional_summariser_is_applied_as_today() {
        use super::super::memory_sharing::SummarizerPref;
        let raw = || Some(("User: hi\nAssistant: yo".to_string(), 2));
        let provider = SummarizerPref { mode: "provider".into(), provider: "anthropic".into(), model: "m1".into() };

        let never = |_: String, _: String, _: String| async { unreachable!("raw mode never summarises") };
        assert_eq!(
            handoff_block(raw(), &SummarizerPref::default(), never).await.as_deref(),
            Some("--- RECENT SESSION ---\nUser: hi\nAssistant: yo\n(last 2 turns · raw)\n--- END RECENT SESSION ---")
        );
        let incomplete = SummarizerPref { model: String::new(), ..provider.clone() };
        assert!(handoff_block(raw(), &incomplete, never).await.unwrap().contains("(last 2 turns · raw)"));

        let summarised = handoff_block(raw(), &provider, |text: String, p: String, m: String| async move {
            assert_eq!((text.as_str(), p.as_str(), m.as_str()), ("User: hi\nAssistant: yo", "anthropic", "m1"));
            "- greeted".to_string()
        })
        .await;
        assert_eq!(
            summarised.as_deref(),
            Some("--- RECENT SESSION ---\n- greeted\n(last 2 turns · summarized by anthropic/m1)\n--- END RECENT SESSION ---")
        );

        let fell_back = handoff_block(raw(), &provider, |text: String, _: String, _: String| async move { text }).await;
        assert!(fell_back.unwrap().contains("User: hi\nAssistant: yo\n(last 2 turns · raw)"));
        assert_eq!(handoff_block(None, &provider, never).await, None);
    }

    #[test]
    fn test_kind_filter() {
        let docs = vec![
            doc("feedback", "Fb", "f", 1),
            doc("user", "Us", "u", 2),
            doc("project", "Pr", "p", 3),
            doc("reference", "Rf", "r", 4),
            doc("file", "File", "code", 5),
            doc("thread", "Th", "t", 6),
            doc("index", "Ix", "i", 7),
        ];
        let pack = curate_pack(docs, PACK_MAX_CHARS).expect("pack");
        assert!(pack.contains("[feedback] Fb"));
        assert!(pack.contains("[user] Us"));
        assert!(pack.contains("[project] Pr"));
        assert!(pack.contains("[reference] Rf"));
        assert!(!pack.contains("[file]"));
        assert!(!pack.contains("[thread]"));
        assert!(!pack.contains("[index]"));
        assert!(pack.contains("(4 memories"));
    }

    #[test]
    fn test_no_curated_docs_is_none() {
        let docs = vec![doc("file", "a", "x", 1), doc("index", "b", "y", 2)];
        assert!(curate_pack(docs, PACK_MAX_CHARS).is_none());
    }

    #[test]
    fn test_budget_trim_prefers_recent() {
        // Each entry body is capped to ENTRY_MAX_CHARS; make many large docs so
        // the total exceeds PACK_MAX_CHARS and trimming kicks in.
        let big = "x".repeat(1000);
        let mut docs = Vec::new();
        for i in 0..40 {
            docs.push(doc("project", &format!("D{i}"), &big, i as i64));
        }
        let pack = curate_pack(docs, PACK_MAX_CHARS).expect("pack");
        assert!(
            pack.len() <= PACK_MAX_CHARS + 200,
            "pack within budget: {}",
            pack.len()
        );
        // Newest (highest ts = D39) must be present; an old one (D0) dropped.
        assert!(pack.contains("[project] D39"));
        assert!(!pack.contains("[project] D0\n"));
    }

    #[test]
    fn test_compose_injection_empty_is_passthrough() {
        assert_eq!(compose_injection(&[], "hello"), "hello");
        assert_eq!(compose_injection(&["", "  "], "hello"), "hello");
    }

    /// The exact wire text of a first send carrying every block: one envelope,
    /// the do-not-persist line first, every present block inside it in push
    /// order, and the user's own words after it — outside the tag, so the agent
    /// can tell the request from the background.
    #[test]
    fn test_compose_injection_wraps_every_block_in_one_envelope() {
        let out = compose_injection(&["SHARED", "INDEX", "PACK", "HANDOFF"], "user text");
        assert_eq!(
            out,
            "<atlas-memory>\n\
             Background context from Atlas, not part of the user's message. \
             Do not save any of it to your own memory.\n\
             SHARED\n\nINDEX\n\nPACK\n\nHANDOFF\n\
             </atlas-memory>\n\nuser text"
        );
        assert_eq!(out.matches("<atlas-memory>").count(), 1);
    }

    #[test]
    fn test_compose_injection_pack_only() {
        let out = compose_injection(&["PACK"], "u");
        assert!(out.starts_with("<atlas-memory>\n"));
        assert!(out.ends_with("PACK\n</atlas-memory>\n\nu"));
    }

    /// The envelope is a round trip: what `agents_send` composes is exactly what
    /// every Atlas reader takes back off, so an agent that saves the prompt into
    /// its own memory files contributes none of it back to the corpus.
    #[test]
    fn test_compose_injection_round_trips_through_the_strip() {
        let out = compose_injection(
            &["--- SHARED MEMORY ---\nUse RS256\n--- END SHARED MEMORY ---"],
            "what changed?",
        );
        assert_eq!(
            atlas_agent_transcript::strip_injected_context(&out),
            "what changed?"
        );
    }

    #[test]
    fn test_wrap_handoff_shape() {
        let w = wrap_handoff("User: hi\nAssistant: yo", 2, "raw");
        assert!(w.starts_with("--- RECENT SESSION ---\n"));
        assert!(w.contains("(last 2 turns · raw)"));
        assert!(w.ends_with("--- END RECENT SESSION ---"));
    }

    #[test]
    fn test_is_slash_command_accepts_commands() {
        assert!(is_slash_command("/improve-codebase-architecture"));
        assert!(is_slash_command("/diagnosing-bugs"));
        assert!(is_slash_command("/codex:rescue")); // plugin command
        assert!(is_slash_command("/to_spec"));
        assert!(is_slash_command("/grill-with-docs some argument text"));
        assert!(is_slash_command("/handoff\nmultiline args"));
    }

    #[test]
    fn test_is_slash_command_rejects_prose_and_paths() {
        // The discriminator: an interior `/` means path, not command.
        assert!(!is_slash_command(
            "/Users/me/Developer/atlas/src/foo.rs is broken"
        ));
        assert!(!is_slash_command("/etc/hosts"));
        assert!(!is_slash_command("please run /implement for me"));
        assert!(!is_slash_command("no slash here"));
        assert!(!is_slash_command("/"));
        assert!(!is_slash_command("/ leading space"));
        assert!(!is_slash_command(""));
    }

    /// Regression: the composed wire text for a slash-command turn must keep the
    /// command at byte 0. Prepending any context block demotes it to prose and
    /// Claude Code never resolves the skill — the bug this guard exists to stop.
    #[test]
    fn test_injection_would_displace_a_slash_command() {
        let text = "/improve-codebase-architecture";
        assert!(is_slash_command(text));
        let injected = compose_injection(&["--- PROJECT MEMORY ---\nx"], text);
        assert!(
            !injected.starts_with('/'),
            "injection moves the command off byte 0 — callers must skip it for slash turns"
        );
    }
}
