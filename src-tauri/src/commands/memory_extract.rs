//! The extractor's app side: which model a pass asks, and where its entries
//! land.
//!
//! `atlas_memory::extract` owns the gates, the prompt and the parser. This
//! module decides, per pass:
//!
//! - **whether it runs** — only while sharing is on for the project;
//! - **which model** ([`route_for`], from the summariser preference file):
//!   `provider` → the user's BYOK provider and model; `local` → nothing yet (the
//!   slot stays reserved); anything else — `gateway`, the default `raw`, a file
//!   that does not exist — → the Atlas gateway, when the user is signed in. Not
//!   signed in and no BYOK provider chosen means no pass, silently;
//! - **where the entries go** — [`SharedMemoryStore::record_extracted`]: source
//!   `extractor`, the model's confidence, redaction and dedup in the record,
//!   an event in the log (the Shared tab shows it) and a memory-changed
//!   announcement. The retrieval index is nudged afterwards by the caller.
//!
//! The model is behind [`ExtractionModel`] so tests drive every path with a
//! fake; [`AppExtractionModel`] is the real one (the gateway over the account
//! token, or the BYOK one-shot completion the handoff summariser uses).
//!
//! It runs at turn finished (gated) and once at session end. The session's
//! turns are gone from the host by the time its end is reported, so each
//! turn-finished pass keeps the latest turns it saw for the end pass to use.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::{Duration, Instant};

use atlas_memory::extract::{self, Trigger};
use atlas_memory::TranscriptTurn;
use parking_lot::Mutex;
use tauri::{AppHandle, Manager};

use super::memory_sharing::{MemorySharingState, SummarizerPref};
use super::shared_memory::{SharedMemoryStore, Writer};

/// Ceiling on one extraction call — generous (a pass sends up to 6000 chars
/// and asks for structured output), but a hung call must not park the
/// background queue.
const EXTRACT_TIMEOUT: Duration = Duration::from_secs(60);

/// How long after a session's end a turn job from it still counts as that
/// session's last turn (the two are queued from different threads, so the
/// end can be handled a moment before its last turn).
const LATE_TURN_WINDOW: Duration = Duration::from_secs(120);

/// Which model one pass asks.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Route {
    /// The Atlas gateway, over the signed-in account.
    Gateway,
    /// The user's own provider key (the summariser preference's `provider`).
    Byok { provider: String, model: String },
}

/// The model a pass asks, from the project's summariser preference and whether
/// the user is signed in. `None` = no pass.
pub fn route_for(pref: &SummarizerPref, signed_in: bool) -> Option<Route> {
    match pref.mode.as_str() {
        "provider" => (!pref.provider.is_empty() && !pref.model.is_empty()).then(|| Route::Byok {
            provider: pref.provider.clone(),
            model: pref.model.clone(),
        }),
        // Reserved: an on-device model is a future mode, and choosing it must
        // not send the transcript anywhere in the meantime.
        "local" => None,
        _ => signed_in.then_some(Route::Gateway),
    }
}

/// A model call in flight.
pub type Completion<'a> = Pin<Box<dyn Future<Output = Result<String, String>> + Send + 'a>>;

/// The model the extractor asks. Injected so tests are deterministic.
pub trait ExtractionModel: Send + Sync {
    /// Whether an Atlas account is signed in (the gateway is usable).
    fn signed_in(&self) -> bool;
    /// One completion of `prompt` on `route`.
    fn complete(&self, route: Route, prompt: String) -> Completion<'_>;
}

/// Runs extraction passes and lands their entries in shared memory.
pub struct Extractor {
    memory: SharedMemoryStore,
    model: Arc<dyn ExtractionModel>,
    /// Each live session's latest turns, for its end-of-session pass.
    turns: Mutex<HashMap<String, Vec<TranscriptTurn>>>,
    /// Sessions whose end was handled, and when. A turn job that arrives
    /// shortly after its session's end (the two come from different threads)
    /// runs as the end pass instead of waiting for an end that already
    /// happened.
    ended: Mutex<HashMap<String, Instant>>,
}

impl Extractor {
    pub fn new(memory: SharedMemoryStore, model: Arc<dyn ExtractionModel>) -> Self {
        Self {
            memory,
            model,
            turns: Mutex::new(HashMap::new()),
            ended: Mutex::new(HashMap::new()),
        }
    }

    /// A turn of `writer`'s session in `cwd` finished with `turns` as its
    /// conversation so far: extract when the gates are met. Returns how many
    /// entries were recorded.
    pub async fn turn_finished(
        &self,
        sharing: &MemorySharingState,
        cwd: &str,
        writer: &Writer,
        turns: Vec<TranscriptTurn>,
    ) -> usize {
        // Only a session that could have a pass keeps its turns for the end
        // one: nothing is held for a project with sharing off or no model.
        let Some(route) = self.route(sharing, cwd) else {
            self.turns.lock().remove(&writer.session_id);
            return 0;
        };
        // The end was handled before this turn's job: this is the session's
        // last word, so run it as the end pass and keep nothing for an end
        // that already happened.
        let late = self
            .ended
            .lock()
            .remove(&writer.session_id)
            .is_some_and(|at| at.elapsed() < LATE_TURN_WINDOW);
        if late {
            self.turns.lock().remove(&writer.session_id);
            return self
                .run(route, cwd, writer, &turns, Trigger::SessionEnd)
                .await;
        }
        self.turns
            .lock()
            .insert(writer.session_id.clone(), turns.clone());
        self.run(route, cwd, writer, &turns, Trigger::TurnFinished)
            .await
    }

    /// `writer`'s session in `cwd` ended: one last pass over whatever arrived
    /// since the previous one. At most once per session. Returns how many
    /// entries were recorded.
    pub async fn session_ended(
        &self,
        sharing: &MemorySharingState,
        cwd: &str,
        writer: &Writer,
    ) -> usize {
        // Marked first, so a turn job still in flight is recognised as late
        // even when this returns early. Marks older than the window are
        // dropped here, so a session resumed later is not mistaken for late.
        {
            let mut ended = self.ended.lock();
            ended.retain(|_, at| at.elapsed() < LATE_TURN_WINDOW);
            ended.insert(writer.session_id.clone(), Instant::now());
        }
        let Some(turns) = self.turns.lock().remove(&writer.session_id) else {
            return 0;
        };
        let Some(route) = self.route(sharing, cwd) else {
            return 0;
        };
        self.run(route, cwd, writer, &turns, Trigger::SessionEnd)
            .await
    }

    /// The model a pass in `cwd` would ask, or `None` when no pass runs there
    /// (sharing off, the reserved local mode, no account and no BYOK choice).
    /// The model passes ask (the dream pass asks it too, with the same
    /// consent).
    pub fn model(&self) -> Arc<dyn ExtractionModel> {
        self.model.clone()
    }

    /// The route a pass for `cwd` takes: `None` when sharing is off or no
    /// model is configured.
    pub(crate) fn route(&self, sharing: &MemorySharingState, cwd: &str) -> Option<Route> {
        if !sharing.is_enabled(cwd) {
            return None;
        }
        route_for(&sharing.summarizer_pref(cwd), self.model.signed_in())
    }

    async fn run(
        &self,
        route: Route,
        cwd: &str,
        writer: &Writer,
        turns: &[TranscriptTurn],
        trigger: Trigger,
    ) -> usize {
        // The gate counters, from the scope's memory directory (git lookup
        // and file reads: off the async runtime).
        let loaded = {
            let (cwd, session) = (cwd.to_string(), writer.session_id.clone());
            tokio::task::spawn_blocking(move || {
                let store = super::shared_memory::store_for(&cwd)?;
                let dir = atlas_memory::record::memory_dir(store.root());
                let state = atlas_memory::ExtractState::load(&dir, &session);
                Ok::<_, String>((dir, state))
            })
            .await
        };
        let (memory_dir, mut state) = match loaded.map_err(|e| e.to_string()).and_then(|r| r) {
            Ok(loaded) => loaded,
            Err(e) => {
                tracing::debug!(target: "atlas::shared_memory", "extraction skipped: {e}");
                return 0;
            }
        };
        let passes_before = state.extraction_count;

        let model = self.model.clone();
        let found = extract::extract(turns, &mut state, trigger, |prompt| async move {
            match tokio::time::timeout(EXTRACT_TIMEOUT, model.complete(route, prompt)).await {
                Ok(result) => result.map_err(|e| anyhow::anyhow!(e)),
                Err(_) => Err(anyhow::anyhow!(
                    "timed out after {}s",
                    EXTRACT_TIMEOUT.as_secs()
                )),
            }
        })
        .await;
        let found = match found {
            Ok(found) => found,
            Err(e) => {
                tracing::debug!(target: "atlas::shared_memory", "extraction pass failed: {e:#}");
                return 0;
            }
        };
        if state.extraction_count == passes_before {
            return 0; // no pass ran (the gates are not met yet): nothing to save
        }

        let external = turns.iter().any(|t| t.external);
        // Persist the counters and land the entries (SQLite writes: off the
        // async runtime).
        let (memory, cwd, writer) = (self.memory.clone(), cwd.to_string(), writer.clone());
        tokio::task::spawn_blocking(move || {
            if let Err(e) = state.save(&memory_dir, &writer.session_id) {
                tracing::debug!(target: "atlas::shared_memory", "extraction state not saved: {e:#}");
            }
            let mut recorded = 0;
            for entry in found {
                // A pass over a session that read outside content proposes,
                // it does not decide: its entries are candidates (M0, 12c).
                let confidence = if external {
                    entry.confidence.min(atlas_memory::record::CANDIDATE_CONFIDENCE)
                } else {
                    entry.confidence
                };
                match memory.record_extracted(&cwd, &writer, entry.kind, &entry.content, confidence) {
                    Ok(_) => recorded += 1,
                    Err(e) => tracing::debug!(target: "atlas::shared_memory", "extracted entry not recorded: {e}"),
                }
            }
            recorded
        })
        .await
        .unwrap_or(0)
    }
}

/// A session's conversation as the extractor reads it: one neutral turn per
/// message (the `AgentHost` snapshot already normalises every agent), with
/// Atlas's own injected blocks stripped so memory is never re-extracted from
/// memory.
pub fn transcript_turns(messages: &[atlas_agent_wire::Message]) -> Vec<TranscriptTurn> {
    use atlas_agent_wire::MessageRole;
    messages
        .iter()
        .map(|m| TranscriptTurn {
            role: match m.role {
                MessageRole::User => "user",
                MessageRole::Assistant => "assistant",
                MessageRole::System => "system",
            }
            .to_string(),
            text: atlas_agent_transcript::strip_injected_context(&m.content),
            tool_calls: m.tool_calls.len(),
            external: m.tool_calls.iter().any(is_external),
        })
        .collect()
}

/// Atlas's own tool servers: their results are not outside content.
const OWN_SERVERS: [&str; 4] = ["atlas_memory", "atlas_code", "atlas_ui", "atlas_org"];

/// Whether a tool call brought outside content into the session: a web fetch
/// or search, or an MCP tool of a server other than Atlas's own. MCP calls
/// are spelled `mcp__<server>__<tool>` by ACP agents and `<server>.<tool>` by
/// the native agent, in the tool name or the title.
fn is_external(call: &atlas_agent_wire::ToolCall) -> bool {
    if call.kind.as_deref() == Some("fetch") {
        return true;
    }
    // The native agent's MCP calls carry kind `other`. A shell command, read
    // or edit whose title starts with a dotted word (`python3.12 -m pytest`,
    // `Cargo.toml`) is not one.
    let dotted = !matches!(
        call.kind.as_deref(),
        Some("execute" | "read" | "edit" | "search" | "delete" | "move")
    );
    let mut names = std::iter::once(call.tool_name.as_str()).chain(call.title.as_deref());
    names.any(|name| {
        let lower = name.to_ascii_lowercase();
        let first = lower
            .split(|c: char| c.is_whitespace() || matches!(c, '(' | ':' | '[' | '<'))
            .next()
            .unwrap_or("");
        ["web_search", "websearch", "web_fetch", "webfetch"]
            .iter()
            .any(|w| first.contains(w))
            || mcp_server(first, dotted).is_some_and(|server| !OWN_SERVERS.contains(&server))
    })
}

/// The server half of an MCP call's name (see [`is_external`]); `None` for
/// anything else. The `<server>.<tool>` form is read only when `dotted`, and
/// never from a token with a `/` in it or an all-digit tool half, so a file
/// path or a version (`python3.12`) is never read as a call.
fn mcp_server(token: &str, dotted: bool) -> Option<&str> {
    if let Some(rest) = token.strip_prefix("mcp__") {
        return rest.split_once("__").map(|(server, _)| server);
    }
    if !dotted || token.contains('/') {
        return None;
    }
    let ident = |s: &str| {
        !s.is_empty()
            && s.chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    };
    let (server, tool) = token.split_once('.')?;
    (ident(server) && ident(tool) && !tool.bytes().all(|b| b.is_ascii_digit())).then_some(server)
}

// ── The real model ───────────────────────────────────────────────────────────

/// The app's models: the Atlas gateway over the signed-in account, or the
/// user's BYOK provider.
pub struct AppExtractionModel {
    app: AppHandle,
}

impl AppExtractionModel {
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }
}

impl ExtractionModel for AppExtractionModel {
    fn signed_in(&self) -> bool {
        self.app
            .try_state::<super::auth::AuthState>()
            .is_some_and(|auth| {
                matches!(
                    auth.core().snapshot(),
                    crate::auth::AuthSnapshot::SignedIn { .. }
                )
            })
    }

    fn complete(&self, route: Route, prompt: String) -> Completion<'_> {
        Box::pin(async move {
            match route {
                Route::Byok { provider, model } => {
                    super::memory_summarize::run_completion(&self.app, prompt, &provider, &model)
                        .await
                }
                Route::Gateway => gateway_completion(&self.app, prompt).await,
            }
        })
    }
}

/// One non-streamed chat completion on the gateway, on the model the gateway
/// lists first for this account (the native agent's default).
async fn gateway_completion(app: &AppHandle, prompt: String) -> Result<String, String> {
    use atlas_native_agent::engine::catalog_cache::{project, resolve};
    use atlas_native_agent::engine::config::GATEWAY_BASE_URL;
    use atlas_native_agent::engine::{EngineHome, GatewayCatalogueFetcher, SystemClock};

    let core = app
        .try_state::<super::auth::AuthState>()
        .ok_or("auth is not ready")?
        .core();
    let org = match core.snapshot() {
        crate::auth::AuthSnapshot::SignedIn { active_org_id, .. } => active_org_id,
        _ => return Err("not signed in".into()),
    };
    let token = core
        .mint_access_token()
        .await
        .map_err(|e| format!("no account token: {e:?}"))?;

    let config_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    let home = EngineHome::under_config_dir(&config_dir);
    let fetcher = GatewayCatalogueFetcher::registered(GATEWAY_BASE_URL);
    let catalogue = resolve(home.path(), &fetcher, &SystemClock, false)
        .await
        .map_err(|e| e.to_string())?;
    let model = project(catalogue.cache())
        .ok_or("the gateway lists no model this account may use")?
        .default_model;

    let url = format!(
        "{}/chat/completions",
        GATEWAY_BASE_URL.trim_end_matches('/')
    );
    let mut request = reqwest::Client::new()
        .post(&url)
        .bearer_auth(&token)
        .timeout(EXTRACT_TIMEOUT)
        .json(&serde_json::json!({
            "model": model,
            "messages": [{ "role": "user", "content": prompt }],
            "stream": false,
        }));
    // Bill the org the user is working in, as every gateway request does.
    if let Some(org) = org {
        request = request.header("atlas-org", org);
    }
    let response = request.send().await.map_err(|e| e.to_string())?;
    let status = response.status();
    let body = response.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("the gateway answered {status}"));
    }
    completion_text(&body).ok_or_else(|| "the gateway's answer had no message".into())
}

/// The assistant text of a chat-completions response body.
fn completion_text(body: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(body).ok()?;
    value
        .pointer("/choices/0/message/content")
        .and_then(|c| c.as_str())
        .map(str::to_string)
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::shared_memory::MemoryChanged;
    use atlas_memory::record::EntryKind;

    const CANNED: &str = r#"{"entries":[
        {"kind":"decision","content":"Sign JWTs with RS256","confidence":0.9},
        {"kind":"fact","content":"The API speaks JSON over REST","confidence":0.85},
        {"kind":"failure","content":"HS256 needs a shared secret; avoid it","confidence":0.7},
        {"kind":"architecture","content":"Server components render the todo list","confidence":0.6}
    ]}"#;

    /// A fake gateway / provider: answers every call with [`CANNED`] and
    /// records which route each call took.
    struct FakeModel {
        signed_in: bool,
        calls: Mutex<Vec<Route>>,
    }

    impl FakeModel {
        fn new(signed_in: bool) -> Arc<Self> {
            Arc::new(Self {
                signed_in,
                calls: Mutex::new(Vec::new()),
            })
        }
        fn calls(&self) -> Vec<Route> {
            self.calls.lock().clone()
        }
    }

    impl ExtractionModel for FakeModel {
        fn signed_in(&self) -> bool {
            self.signed_in
        }
        fn complete(&self, route: Route, _prompt: String) -> Completion<'_> {
            self.calls.lock().push(route);
            Box::pin(async { Ok(CANNED.to_string()) })
        }
    }

    struct Harness {
        memory: SharedMemoryStore,
        sharing: MemorySharingState,
        model: Arc<FakeModel>,
        extractor: Extractor,
        project: String,
        heard: Arc<Mutex<Vec<MemoryChanged>>>,
    }

    fn harness(label: &str, signed_in: bool) -> Harness {
        let dir =
            std::env::temp_dir().join(format!("atlas-extract-{label}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let memory = SharedMemoryStore::new();
        let heard = Arc::new(Mutex::new(Vec::new()));
        memory.on_change({
            let heard = heard.clone();
            Arc::new(move |c: &MemoryChanged| heard.lock().push(c.clone()))
        });
        let model = FakeModel::new(signed_in);
        Harness {
            extractor: Extractor::new(memory.clone(), model.clone()),
            memory,
            sharing: MemorySharingState::new(),
            model,
            project: dir.to_string_lossy().into_owned(),
            heard,
        }
    }

    fn writer() -> Writer {
        Writer {
            agent: "claude-code".into(),
            session_id: "sess-1".into(),
        }
    }

    /// A session of `n` turns, alternating user and assistant.
    fn session(n: usize) -> Vec<TranscriptTurn> {
        (0..n)
            .map(|i| TranscriptTurn {
                role: if i % 2 == 0 { "user" } else { "assistant" }.into(),
                text: format!("turn {i}"),
                tool_calls: 0,
                external: false,
            })
            .collect()
    }

    fn set_pref(project: &str, mode: &str, provider: &str, model: &str) {
        crate::commands::memory_sharing::memory_summarizer_set(
            project.to_string(),
            SummarizerPref {
                mode: mode.into(),
                provider: provider.into(),
                model: model.into(),
            },
        )
        .unwrap();
    }

    #[tokio::test]
    async fn a_long_session_without_byok_yields_entries_through_the_gateway() {
        let h = harness("gateway", true);
        let recorded = h
            .extractor
            .turn_finished(&h.sharing, &h.project, &writer(), session(26))
            .await;

        assert_eq!(recorded, 4);
        assert_eq!(h.model.calls(), vec![Route::Gateway]);
        // The Shared tab's state shows them.
        let state = h.memory.get_state(&h.project);
        assert_eq!(state.decisions.len(), 1);
        assert_eq!(state.decisions[0].text, "Sign JWTs with RS256");
        assert_eq!(state.facts[0].text, "The API speaks JSON over REST");
        assert_eq!(state.failures.len(), 1);
        assert_eq!(state.architecture.len(), 1);
        // And each write was announced.
        let kinds: Vec<Vec<String>> = h.heard.lock().iter().map(|c| c.kinds.clone()).collect();
        assert_eq!(
            kinds,
            [
                vec!["decision"],
                vec!["fact"],
                vec!["failure"],
                vec!["architecture"]
            ]
        );
    }

    #[tokio::test]
    async fn extracted_entries_carry_the_models_confidence_and_extractor_provenance() {
        let h = harness("provenance", true);
        h.extractor
            .turn_finished(&h.sharing, &h.project, &writer(), session(26))
            .await;

        let entries = h.memory.list_entries(&h.project, None);
        let by_kind = |k: EntryKind| entries.iter().find(|e| e.kind == k).unwrap();
        assert!(entries.iter().all(|e| e.source == "extractor"
            && e.agent == "claude-code"
            && e.session_id == "sess-1"));
        assert_eq!(by_kind(EntryKind::Decision).confidence, 0.9);
        assert_eq!(by_kind(EntryKind::Fact).confidence, 0.85);
        assert_eq!(by_kind(EntryKind::Failure).confidence, 0.7);
        assert_eq!(by_kind(EntryKind::Architecture).confidence, 0.6);
        // The event log (the Shared tab's events table) shows them too.
        assert_eq!(h.memory.list_events(&h.project).len(), 4);
    }

    #[tokio::test]
    async fn the_summariser_set_to_provider_uses_the_byok_path() {
        let h = harness("byok", true);
        set_pref(&h.project, "provider", "anthropic", "claude-haiku");
        h.extractor
            .turn_finished(&h.sharing, &h.project, &writer(), session(26))
            .await;

        assert_eq!(
            h.model.calls(),
            vec![Route::Byok {
                provider: "anthropic".into(),
                model: "claude-haiku".into()
            }]
        );
        assert_eq!(h.memory.get_state(&h.project).decisions.len(), 1);
    }

    #[tokio::test]
    async fn extraction_waits_for_the_gates_then_runs_once_at_session_end() {
        let h = harness("gates", true);
        for n in [2, 6, 10, 14] {
            h.extractor
                .turn_finished(&h.sharing, &h.project, &writer(), session(n))
                .await;
        }
        assert!(h.model.calls().is_empty(), "no pass before twenty turns");
        assert!(h.memory.get_state(&h.project).decisions.is_empty());

        assert_eq!(
            h.extractor
                .session_ended(&h.sharing, &h.project, &writer())
                .await,
            4
        );
        assert_eq!(h.model.calls().len(), 1, "one pass at session end");
        assert_eq!(h.memory.get_state(&h.project).decisions.len(), 1);

        assert_eq!(
            h.extractor
                .session_ended(&h.sharing, &h.project, &writer())
                .await,
            0
        );
        assert_eq!(h.model.calls().len(), 1, "a session ends once");
    }

    #[tokio::test]
    async fn after_a_gated_pass_the_end_pass_only_runs_on_new_turns() {
        let h = harness("end-after", true);
        h.extractor
            .turn_finished(&h.sharing, &h.project, &writer(), session(26))
            .await;
        assert_eq!(h.model.calls().len(), 1);
        // Nothing new since that pass: the end has nothing to ask about.
        h.extractor
            .session_ended(&h.sharing, &h.project, &writer())
            .await;
        assert_eq!(h.model.calls().len(), 1);
    }

    #[tokio::test]
    async fn not_signed_in_without_byok_extraction_does_not_run() {
        let h = harness("signed-out", false);
        h.extractor
            .turn_finished(&h.sharing, &h.project, &writer(), session(26))
            .await;
        h.extractor
            .session_ended(&h.sharing, &h.project, &writer())
            .await;
        assert!(h.model.calls().is_empty());
        assert!(h.heard.lock().is_empty());
    }

    #[tokio::test]
    async fn sharing_off_or_the_reserved_local_mode_runs_nothing() {
        let h = harness("local", true);
        set_pref(&h.project, "local", "", "");
        h.extractor
            .turn_finished(&h.sharing, &h.project, &writer(), session(26))
            .await;
        assert!(h.model.calls().is_empty());

        let h = harness("off", true);
        let atlas = std::path::Path::new(&h.project).join(".atlas");
        std::fs::create_dir_all(&atlas).unwrap();
        std::fs::write(atlas.join("memory-sharing.json"), r#"{"enabled":false}"#).unwrap();
        h.extractor
            .turn_finished(&h.sharing, &h.project, &writer(), session(26))
            .await;
        assert!(h.model.calls().is_empty());
    }

    #[test]
    fn routes_follow_the_summariser_preference() {
        let pref = |mode: &str, provider: &str, model: &str| SummarizerPref {
            mode: mode.into(),
            provider: provider.into(),
            model: model.into(),
        };
        assert_eq!(
            route_for(&SummarizerPref::default(), true),
            Some(Route::Gateway)
        );
        assert_eq!(
            route_for(&pref("gateway", "", ""), true),
            Some(Route::Gateway)
        );
        assert_eq!(route_for(&SummarizerPref::default(), false), None);
        assert_eq!(
            route_for(&pref("provider", "openai", "gpt"), false),
            Some(Route::Byok {
                provider: "openai".into(),
                model: "gpt".into()
            })
        );
        assert_eq!(
            route_for(&pref("provider", "", ""), true),
            None,
            "provider chosen but not configured"
        );
        assert_eq!(route_for(&pref("local", "", ""), true), None);
    }

    #[test]
    fn the_gateway_answer_is_read_from_the_first_choice() {
        let body = r#"{"choices":[{"message":{"role":"assistant","content":"{\"entries\":[]}"}}]}"#;
        assert_eq!(completion_text(body).as_deref(), Some(r#"{"entries":[]}"#));
        assert_eq!(completion_text("{}"), None);
    }

    /// The end of a session can be handled before its last turn's job (they
    /// come from two threads). That turn still gets an end pass, and its
    /// turns are not kept forever for an end that already happened.
    #[tokio::test]
    async fn a_turn_after_its_session_ended_runs_as_the_end_pass() {
        let h = harness("late-turn", true);
        assert_eq!(
            h.extractor
                .session_ended(&h.sharing, &h.project, &writer())
                .await,
            0
        );
        let recorded = h
            .extractor
            .turn_finished(&h.sharing, &h.project, &writer(), session(4))
            .await;
        assert_eq!(
            recorded, 4,
            "below the turn gate, but an end pass needs only new assistant text"
        );
        assert!(
            !h.extractor.turns.lock().contains_key("sess-1"),
            "not kept after its end"
        );
    }

    #[tokio::test]
    async fn a_pass_over_a_session_that_fetched_the_web_stores_candidates() {
        let h = harness("external", true);
        let mut turns = session(26);
        turns[10].external = true;
        let recorded = h
            .extractor
            .turn_finished(&h.sharing, &h.project, &writer(), turns)
            .await;
        assert!(recorded > 0);
        let entries = h.memory.entries(&h.project);
        assert!(
            entries
                .iter()
                .all(|e| e.confidence <= atlas_memory::record::CANDIDATE_CONFIDENCE),
            "{entries:?}"
        );
    }

    #[test]
    fn outside_content_is_a_web_call_or_a_third_party_mcp_tool() {
        let call =
            |name: &str, title: Option<&str>, kind: Option<&str>| atlas_agent_wire::ToolCall {
                id: "c".into(),
                tool_name: name.into(),
                title: title.map(str::to_string),
                kind: kind.map(str::to_string),
                status: atlas_agent_wire::ToolCallStatus::Completed,
                arguments: serde_json::json!({}),
                result: None,
                locations: vec![],
                raw_output: None,
                content_blocks: vec![],
            };
        assert!(is_external(&call("WebFetch", None, Some("fetch"))));
        assert!(is_external(&call("WebSearch", None, None)));
        assert!(is_external(&call("mcp__acme__deploy", None, None)));
        assert!(is_external(&call(
            "tool",
            Some("github.search_issues"),
            None
        )));
        assert!(!is_external(&call(
            "mcp__atlas_memory__memory_search",
            None,
            None
        )));
        assert!(!is_external(&call("atlas_code.grep", None, None)));
        assert!(!is_external(&call(
            "Edit src/foo.rs",
            Some("Edit src/foo.rs"),
            Some("edit")
        )));
        assert!(!is_external(&call(
            "Read",
            Some("Read /repo/README.md"),
            Some("read")
        )));
        // A dotted first word of a command or a bare file name is no MCP call.
        assert!(!is_external(&call(
            "python3.12 -m pytest",
            Some("python3.12 -m pytest"),
            Some("execute")
        )));
        assert!(!is_external(&call("python3.12 -m pytest", None, None)));
        assert!(!is_external(&call(
            "Cargo.toml",
            Some("Cargo.toml"),
            Some("read")
        )));
        assert!(is_external(&call(
            "github.search_issues",
            None,
            Some("other")
        )));
    }
}
