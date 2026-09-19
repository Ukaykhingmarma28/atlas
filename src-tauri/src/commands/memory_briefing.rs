//! Shared memory — what one conversational turn carries to an agent.
//!
//! [`compose_turn`] is the single place that decides the memory handed to an
//! agent with a user's message (`agents_send`, native and ACP alike). Every
//! block rides inside one `<atlas-memory>` envelope ([`memory_pack::compose_injection`]):
//!
//! - **First send of a session — the briefing.** Working memory (the active
//!   plan, then files changed newest first); a **durable index**, one line per
//!   entry, ranked by [`score`] and grouped by kind with today's display caps as
//!   limits, the whole index within [`INDEX_MAX_LINES`]; then the curated pack
//!   and the recent-session handoff. The briefing replaces the clock-0 "full
//!   state" shared block it grew out of.
//! - **Turns 2..N.** The shared-memory delta by the session's sync clock
//!   ([`memory_inject::compose_shared_block`], unchanged) and nothing else from
//!   the store.
//! - **Every turn.** The relevant-memory block (existing retrieval, per-doc and
//!   total budgets, per-session dedup), unless the prompt is short or a
//!   continuation phrase ([`wants_relevant_memory`]).
//!
//! **Budget.** The first send costs no more than it did before the briefing:
//! working memory and the index together fit today's pack budget
//! ([`BRIEFING_MAX_CHARS`]), and the curated pack takes what is left of the pack
//! and old shared-block budgets ([`pack_budget`]). Handoff and relevant-memory
//! budgets are untouched. `FIRST_SEND_MAX_CHARS` (the tests' ceiling) is the sum of today's
//! ceilings, which every first send stays within.
//!
//! **One source per memory.** The index reads every entry in the record,
//! memdir imports and tool writes included — the record is the source for a
//! durable memory. Retrieval can still reach the same memory by another path:
//! the record's own corpus documents (`shared:<kind>:<id>`), and, for memdir
//! facts, the legacy extraction graph that was written alongside the memdir.
//! So for the rest of the session a retrieved document that repeats an indexed
//! entry — the same entry id, or the same text under another source's id — is
//! not pushed again ([`repeats_briefing`]).

use std::future::Future;

use atlas_memory::record::{self, Entry, EntryKind, Origin};

use super::agent_host::SessionKey;
use super::memory_retrieve::{self, RetrievedDoc};
use super::memory_sharing::MemorySharingState;
use super::shared_memory::{self, SharedMemoryStore};
use super::{agent_memory, memory_inject, memory_pack};

/// The index never runs past this many lines, headings included.
pub(crate) const INDEX_MAX_LINES: usize = 200;

/// Working memory + durable index, delimiters included: today's pack budget.
pub(crate) const BRIEFING_MAX_CHARS: usize = memory_pack::PACK_MAX_CHARS;

/// Working memory's share of the briefing: what the old clock-0 shared block
/// could carry.
const WORKING_MAX_CHARS: usize = memory_inject::BLOCK_MAX_CHARS;

/// One index line's content cap — an index names what exists, the entry itself
/// is a search away.
const INDEX_LINE_MAX_CHARS: usize = 160;

/// Delimiters, footers and the envelope note line, as today's blocks carry
/// them.
#[cfg(test)]
const FRAMING_CHARS: usize = 512;

/// The most a first send injected before the briefing, and the most it may
/// inject now: shared block + relevant memory + curated pack + handoff
/// ceilings, plus their framing. The budget tests hold every first send to it.
#[cfg(test)]
pub(crate) const FIRST_SEND_MAX_CHARS: usize = memory_inject::BLOCK_MAX_CHARS
    + memory_retrieve::BLOCK_MAX_CHARS
    + memory_pack::PACK_MAX_CHARS
    + memory_pack::HANDOFF_MAX_CHARS
    + FRAMING_CHARS;

/// Recency half-life for ranking: two weeks.
const HALF_LIFE_MS: f64 = 14.0 * 24.0 * 60.0 * 60.0 * 1000.0;

/// How many entries of one kind are ranked before the cap applies. Storage is
/// unbounded; this only keeps one read bounded.
const RANK_POOL: usize = 5_000;

/// The durable kinds, in the order the index groups them.
const DURABLE_KINDS: [EntryKind; 4] =
    [EntryKind::Decision, EntryKind::Fact, EntryKind::Failure, EntryKind::Architecture];

/// Prompts that ask the agent to carry on; retrieving on them pulls noise
/// ("continue" retrieved noise in a live sample). The one- and two-word
/// phrases are also below the three-word floor — they are listed so the rule
/// reads whole and survives a change to the floor.
const CONTINUATION_PHRASES: &[&str] = &[
    "continue",
    "ok",
    "yes",
    "go on",
    "next",
    "please continue",
    "continue please",
    "keep going please",
    "yes go ahead",
    "ok go ahead",
    "go ahead please",
];

// ── Short-prompt floor ───────────────────────────────────────────────────────

/// Whether a prompt earns a relevant-memory block: three words or more, and not
/// a continuation phrase ("continue", "ok", "go on", …).
pub(crate) fn wants_relevant_memory(text: &str) -> bool {
    let words: Vec<String> = text
        .split_whitespace()
        .map(|w| w.trim_matches(|c: char| !c.is_alphanumeric()).to_lowercase())
        .filter(|w| !w.is_empty())
        .collect();
    if words.len() < 3 {
        return false;
    }
    !CONTINUATION_PHRASES.contains(&words.join(" ").as_str())
}

// ── Ranking ──────────────────────────────────────────────────────────────────

/// An entry's index rank: recency (two-week half-life, from its last use or
/// write, whichever is later) + ln(1 + use count) + confidence.
pub(crate) fn score(e: &Entry, now: i64) -> f64 {
    let last = e.last_used_at.unwrap_or(0).max(e.updated_at);
    let age = now.saturating_sub(last).max(0) as f64;
    0.5f64.powf(age / HALF_LIFE_MS) + (1.0 + f64::from(e.uses)).ln() + e.confidence
}

/// The index block over `entries` (any mix of durable kinds; working-memory
/// kinds are ignored): each kind's best entries up to its display cap, then,
/// best first across kinds, as many as fit `max_chars` and
/// [`INDEX_MAX_LINES`]. Rendered grouped by kind, best first within a kind.
/// `None` when nothing is indexed.
pub(crate) fn compose_durable_index(entries: &[Entry], now: i64, max_chars: usize) -> Option<String> {
    const OPEN: &str = "--- SHARED MEMORY — INDEX ---\n";
    const CLOSE: &str = "--- END SHARED MEMORY ---";
    const KINDS: [EntryKind; 4] = DURABLE_KINDS;

    // Each kind's best, capped.
    let mut pool: Vec<(f64, &Entry)> = Vec::new();
    for kind in KINDS {
        let mut of_kind: Vec<(f64, &Entry)> =
            entries.iter().filter(|e| e.kind == kind).map(|e| (score(e, now), e)).collect();
        of_kind.sort_by(|a, b| b.0.total_cmp(&a.0));
        of_kind.truncate(kind.cap());
        pool.extend(of_kind);
    }
    // Admit best first across kinds while the line and char budgets hold. A
    // kind's heading is paid for by its first admitted entry.
    pool.sort_by(|a, b| b.0.total_cmp(&a.0));
    let mut chars = OPEN.len() + CLOSE.len();
    let mut lines = 2usize;
    let mut admitted: Vec<Vec<String>> = vec![Vec::new(); KINDS.len()];
    for (_, e) in pool {
        let Some(slot) = KINDS.iter().position(|k| *k == e.kind) else { continue };
        let line = index_line(e);
        let heading = if admitted[slot].is_empty() { heading(e.kind).len() + 1 } else { 0 };
        let cost_lines = 1 + usize::from(heading > 0);
        let cost_chars = line.len() + 1 + heading;
        if lines + cost_lines > INDEX_MAX_LINES || chars + cost_chars > max_chars {
            continue;
        }
        lines += cost_lines;
        chars += cost_chars;
        admitted[slot].push(line);
    }
    let body: Vec<String> = KINDS
        .iter()
        .zip(&admitted)
        .filter(|(_, lines)| !lines.is_empty())
        .map(|(kind, lines)| format!("{}\n{}", heading(*kind), lines.join("\n")))
        .collect();
    if body.is_empty() {
        return None;
    }
    Some(format!("{OPEN}{}\n{CLOSE}", body.join("\n")))
}

fn heading(kind: EntryKind) -> &'static str {
    match kind {
        EntryKind::Decision => "[DECISIONS]",
        EntryKind::Fact => "[FACTS]",
        EntryKind::Failure => "[FAILURES / AVOID]",
        EntryKind::Architecture => "[ARCHITECTURE]",
        EntryKind::Plan => "[ACTIVE PLAN]",
        EntryKind::FileChanged => "[FILES CHANGED]",
    }
}

fn index_line(e: &Entry) -> String {
    format!("- {} (by {})", one_line(&e.content, INDEX_LINE_MAX_CHARS), provenance(e))
}

/// Who a memory is from: the agent that wrote it, else its source
/// (`import:memdir`, `user`, …).
fn provenance(e: &Entry) -> &str {
    if e.agent.trim().is_empty() {
        &e.source
    } else {
        &e.agent
    }
}

/// Whitespace collapsed to single spaces, capped at `max` chars with `…`.
fn one_line(s: &str, max: usize) -> String {
    let flat = s.split_whitespace().collect::<Vec<_>>().join(" ");
    truncate_chars(&flat, max)
}

fn truncate_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max).collect();
    out.push('…');
    out
}

// ── Working memory ───────────────────────────────────────────────────────────

/// The working-memory block: the active plan, then files changed newest first
/// (`changes` arrive oldest → newest, as the record lists them), within
/// [`WORKING_MAX_CHARS`] of body. `None` when there is neither.
pub(crate) fn compose_working_memory(plan: Option<&Entry>, changes: &[Entry]) -> Option<String> {
    let mut body = String::new();
    if let Some(p) = plan {
        body.push_str(&format!(
            "[ACTIVE PLAN] (by {})\n{}",
            provenance(p),
            truncate_chars(p.content.trim(), WORKING_MAX_CHARS / 2)
        ));
    }
    let mut files = String::new();
    for c in changes.iter().rev() {
        let line = if c.content.trim().is_empty() {
            format!("\n- {} (by {})", c.key, provenance(c))
        } else {
            format!("\n- {} — {} (by {})", c.key, one_line(&c.content, INDEX_LINE_MAX_CHARS), provenance(c))
        };
        let heading = if files.is_empty() { "[FILES CHANGED]".len() + 2 } else { 0 };
        if body.len() + files.len() + heading + line.len() > WORKING_MAX_CHARS {
            break;
        }
        if files.is_empty() {
            files.push_str(if body.is_empty() { "[FILES CHANGED]" } else { "\n\n[FILES CHANGED]" });
        }
        files.push_str(&line);
    }
    body.push_str(&files);
    if body.is_empty() {
        return None;
    }
    Some(format!("--- SHARED MEMORY — WORKING MEMORY ---\n{body}\n--- END SHARED MEMORY ---"))
}

// ── The turn ─────────────────────────────────────────────────────────────────

/// What the record contributes to one turn.
#[derive(Debug, Default)]
struct SharedBlocks {
    working: Option<String>,
    index: Option<String>,
    delta: Option<String>,
    /// The entries the durable index lists (briefing turn only).
    indexed: Vec<Entry>,
    /// The event `seq` the session's sync clock advances to.
    synced_to: u64,
}

impl SharedBlocks {
    fn briefing_chars(&self) -> usize {
        self.working.as_ref().map_or(0, String::len) + self.index.as_ref().map_or(0, String::len)
    }
}

/// Turns 2..N: the delta since `clock`, unchanged. Blocking (SQLite).
fn read_delta(store: &SharedMemoryStore, cwd: &str, clock: u64) -> SharedBlocks {
    let state = store.get_state(cwd);
    SharedBlocks {
        delta: memory_inject::compose_shared_block(&state, clock),
        synced_to: state.last_seq,
        ..Default::default()
    }
}

/// The briefing's working memory and durable index. Blocking (SQLite). An
/// unreadable record is an error rather than a partial briefing, so the
/// caller can fall back to the delta path and nothing is silently skipped.
fn read_briefing(cwd: &str, now: i64) -> Result<SharedBlocks, String> {
    let rec = shared_memory::store_for(cwd)?;
    let err = |e: anyhow::Error| format!("{e:#}");
    let synced_to = rec.last_event().map_err(err)?.map_or(0, |(seq, _)| seq);
    let plan = rec.list(EntryKind::Plan, 1, Origin::Any).map_err(err)?;
    let changes = rec.list(EntryKind::FileChanged, EntryKind::FileChanged.cap(), Origin::Any).map_err(err)?;
    let working = compose_working_memory(plan.last(), &changes);

    let mut durable = Vec::new();
    for kind in DURABLE_KINDS {
        durable.extend(rec.list(kind, RANK_POOL, Origin::Any).map_err(err)?);
    }
    let room = BRIEFING_MAX_CHARS.saturating_sub(working.as_ref().map_or(0, String::len));
    let index = compose_durable_index(&durable, now, room);
    let indexed = match &index {
        Some(block) => durable.into_iter().filter(|e| block.contains(&index_line(e))).collect(),
        None => Vec::new(),
    };
    Ok(SharedBlocks { working, index, delta: None, indexed, synced_to })
}

/// Whether a retrieved document repeats something the durable index already
/// showed this session (`briefed`: the normalised texts of the indexed
/// entries). Catches the same memory under another source's id — a memdir
/// fact the legacy extraction also left in the retrieval graph, which splits
/// its first line off as a title. Exact text only: a document that says more
/// than the entry is not a repeat.
fn repeats_briefing(doc: &RetrievedDoc, briefed: &[String]) -> bool {
    let text = record::normalize(&format!("{} {}", doc.title, doc.text));
    let body = record::normalize(&doc.text);
    briefed.iter().any(|b| *b == text || *b == body)
}

/// The curated pack's char budget on a briefing whose working memory and index
/// took `briefing_chars`: the pack and the old shared block's budgets, less
/// the briefing.
pub(crate) fn pack_budget(briefing_chars: usize) -> usize {
    (memory_pack::PACK_MAX_CHARS + memory_inject::BLOCK_MAX_CHARS).saturating_sub(briefing_chars)
}

/// Compose the text handed to the agent for one conversational turn (slash
/// commands and sharing-off sends never get here — they ship bare).
///
/// `retrieve(query)` is the relevant-memory retrieval; it is not called on a
/// short or continuation prompt. `bootstrap(pack_budget)` builds the
/// first-send curated pack and handoff, in push order; it is called once per
/// session. Advances the session's sync clock and dedup clock and marks the
/// first send done.
pub(crate) async fn compose_turn<R, RF, B, BF>(
    store: &SharedMemoryStore,
    sharing: &MemorySharingState,
    key: &SessionKey,
    cwd: &str,
    text: &str,
    now: i64,
    retrieve: R,
    bootstrap: B,
) -> String
where
    R: FnOnce(String) -> RF,
    RF: Future<Output = Vec<RetrievedDoc>>,
    B: FnOnce(usize) -> BF,
    BF: Future<Output = Vec<String>>,
{
    let first = !sharing.already_sent(key);
    let clock = sharing.clock_for(key);
    let shared = {
        let (store, cwd) = (store.clone(), cwd.to_string());
        tokio::task::spawn_blocking(move || {
            if !first {
                return read_delta(&store, &cwd, clock);
            }
            read_briefing(&cwd, now).unwrap_or_else(|e| {
                tracing::warn!(target: "atlas::shared_memory", "briefing unreadable, sending the shared block instead: {e}");
                read_delta(&store, &cwd, clock)
            })
        })
        .await
        .unwrap_or_else(|_| SharedBlocks { synced_to: clock, ..Default::default() })
    };
    sharing.advance_clock(key, shared.synced_to);
    // The index put these entries in front of the agent: retrieval must not
    // push them again this session, under their own id or another source's.
    for e in &shared.indexed {
        sharing.note_index_doc(key, &agent_memory::shared_doc_id(e.kind.as_str(), e.id));
    }
    sharing.note_briefed(key, shared.indexed.iter().map(|e| record::normalize(&e.content)));

    let relevant = if wants_relevant_memory(text) {
        let briefed = sharing.briefed(key);
        let mut docs = retrieve(text.to_string()).await;
        docs.retain(|d| !repeats_briefing(d, &briefed) && sharing.note_index_doc(key, &d.id));
        memory_retrieve::compose_index_block(&docs)
    } else {
        None
    };

    let bootstrap = if first {
        let blocks = bootstrap(pack_budget(shared.briefing_chars())).await;
        sharing.mark_sent(key);
        blocks
    } else {
        Vec::new()
    };

    // Today's order is kept: the store's blocks, relevant memory, then the
    // first-send pack and handoff.
    let blocks: Vec<&str> = [
        shared.working.as_deref(),
        shared.index.as_deref(),
        shared.delta.as_deref(),
        relevant.as_deref(),
    ]
    .into_iter()
    .flatten()
    .chain(bootstrap.iter().map(String::as_str))
    .collect();
    memory_pack::compose_injection(&blocks, text)
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
#[path = "memory_briefing_tests.rs"]
mod tests;
