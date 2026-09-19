//! The **memory tool server**: shared memory as four MCP tools, served by the
//! Tauri backend itself over streamable HTTP on loopback.
//!
//! - **One server per app**, bound to `127.0.0.1` on a port the OS picks. The
//!   app starts it at setup on the async runtime, so the main thread never
//!   waits on it ([`MemoryServerHost::start`]).
//! - **One bearer token per (session, scope)** ([`MemoryTokens`]). A session
//!   runs in one launch directory, hence one scope, so the table is keyed by
//!   session; a session rebound elsewhere gets a fresh token for the new
//!   scope and the old one is revoked. A session's
//!   token is minted when the session starts and revoked when it ends, through
//!   the same [`SessionLifecycle`] hook that records the session in shared
//!   memory. Every HTTP request is checked against the live tokens, so a
//!   revoked token stops working at once, even on an MCP session it opened.
//!   The token says who is writing: its session, that session's agent (the
//!   entry's source) and its launch directory (which scope's record).
//! - **Four tools**: `memory_search(query, kinds?, limit?)` (durable kinds
//!   unless `kinds` asks for working memory too),
//!   `memory_remember(kind, content, key?)` for the four durable kinds only,
//!   `memory_forget(id)` and `memory_list(kind?)`. Every one goes through
//!   [`SharedMemoryStore`], the same write path as the Shared tab, so each
//!   write is redacted, deduplicated (key, content hash, near-duplicate) and
//!   announced with `atlas:memory-changed`.
//! - **Failure is "no memory", never a crash.** A read that fails returns an
//!   empty result; a write that fails returns a tool error the agent can read.
//!   Store work runs on the blocking pool, off the async runtime.
//!
//! - **Handed to every agent that can take it** ([`MemorySessionOffers`]): an
//!   ACP session request carries the server in `mcpServers` when the agent
//!   advertised `mcpCapabilities.http`; the native agent gets it as a
//!   StreamableHttp entry in its thread's engine config. The token is minted
//!   for the *request*, before a new session's id exists, and bound to the id
//!   once the agent answers; an offer that never binds is revoked. Each
//!   decision is logged, one line per session request.
//! - **`memory_search` also searches the project's indexed documents** when an
//!   [`IndexSearch`] is installed — the retrieval the native agent's old
//!   `search_memory` tool answered from, so replacing that tool loses nothing.

use std::borrow::Cow;
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;

use agent_client_protocol::schema::v1 as acp;
use atlas_agent_servers::{SessionMcpOffer, SessionMcpRequest, SessionMcpServers};
use atlas_memory::record::{Entry, EntryKind};
use axum::body::Body;
use axum::extract::State;
use axum::http::header::AUTHORIZATION;
use axum::http::{Request, StatusCode};
use axum::middleware::{self, Next};
use axum::response::Response;
use futures::future::BoxFuture;
use parking_lot::Mutex;
use rmcp::handler::server::ServerHandler;
use rmcp::model::{
    CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock as Content, JsonObject, ListToolsResult,
    PaginatedRequestParams, ServerCapabilities, ServerInfo, Tool,
};
use rmcp::service::{RequestContext, RoleServer};
use rmcp::transport::streamable_http_server::session::local::LocalSessionManager;
use rmcp::transport::{StreamableHttpServerConfig, StreamableHttpService};
use rmcp::ErrorData as McpError;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::oneshot;

use super::agent_host::SessionLifecycle;
use super::shared_memory::{SharedMemoryStore, Writer};

/// The path the MCP endpoint is served at.
pub const MCP_PATH: &str = "/mcp";

/// `memory_search`'s default and largest result count.
const SEARCH_DEFAULT_LIMIT: usize = 10;
const SEARCH_MAX_LIMIT: usize = 50;

/// How many indexed documents `memory_search` adds, by default and at most —
/// the old `search_memory` tool's bounds: documents are long, and an unbounded
/// number of them crowds out the conversation they were meant to inform.
const INDEX_DEFAULT_LIMIT: usize = 6;
const INDEX_MAX_LIMIT: usize = 20;

/// The name the server goes by in every agent's MCP configuration.
pub const MEMORY_SERVER_NAME: &str = "atlas_memory";

/// One indexed project document (a doc, a knowledge note, a codebase summary),
/// as `memory_search` returns it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IndexDoc {
    pub title: String,
    pub source: String,
    pub text: String,
}

/// `(cwd, query, limit) -> ranked documents` over the project's on-device
/// index. Empty on any failure.
pub type IndexSearch = Arc<dyn Fn(String, String, usize) -> BoxFuture<'static, Vec<IndexDoc>> + Send + Sync>;

// ── Tokens ───────────────────────────────────────────────────────────────────

/// What a token grants: tool access to one scope's memory, as one session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Grant {
    pub session_id: String,
    /// The durable agent id owning the session; the source of its writes.
    pub agent: String,
    /// The session's launch directory; resolves to the scope's record.
    pub cwd: String,
}

#[derive(Default)]
struct TokenTable {
    by_token: HashMap<String, Grant>,
    by_session: HashMap<String, String>,
}

/// The live bearer tokens: one per session, minted at session start and
/// revoked at session end. Cheap to share (`Arc`).
#[derive(Default)]
pub struct MemoryTokens {
    table: Mutex<TokenTable>,
}

impl MemoryTokens {
    /// Mint `session_id`'s token, revoking any earlier one it had (a session
    /// rebound in another directory gets a token for that scope).
    // Outside tests only the lifecycle mints (through `mint_locked`).
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn mint(&self, session_id: &str, agent: &str, cwd: &str) -> String {
        Self::mint_locked(&mut self.table.lock(), session_id, agent, cwd)
    }

    fn mint_locked(table: &mut TokenTable, session_id: &str, agent: &str, cwd: &str) -> String {
        let token = format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple());
        if let Some(old) = table.by_session.remove(session_id) {
            table.by_token.remove(&old);
        }
        table.by_token.insert(
            token.clone(),
            Grant {
                session_id: session_id.to_string(),
                agent: agent.to_string(),
                cwd: cwd.to_string(),
            },
        );
        table.by_session.insert(session_id.to_string(), token.clone());
        token
    }

    /// Mint a token for a session request whose session id is not known yet
    /// (a new session's arrives with the agent's answer). Live at once, so an
    /// agent that connects while opening the session is admitted; it names no
    /// session until [`bind`](Self::bind).
    pub fn mint_unbound(&self, agent: &str, cwd: &str) -> String {
        let token = format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple());
        self.table.lock().by_token.insert(
            token.clone(),
            Grant {
                session_id: String::new(),
                agent: agent.to_string(),
                cwd: cwd.to_string(),
            },
        );
        token
    }

    /// Make `token` the token of `session_id`, revoking any other it had.
    /// Does nothing for a token that is no longer live.
    pub fn bind(&self, token: &str, session_id: &str) {
        let mut table = self.table.lock();
        let Some(grant) = table.by_token.get_mut(token) else {
            return;
        };
        grant.session_id = session_id.to_string();
        if let Some(old) = table.by_session.insert(session_id.to_string(), token.to_string()) {
            if old != token {
                table.by_token.remove(&old);
            }
        }
    }

    /// Revoke one token, whichever session (if any) it belongs to. Idempotent.
    pub fn revoke_token(&self, token: &str) {
        let mut table = self.table.lock();
        if let Some(grant) = table.by_token.remove(token) {
            if table.by_session.get(&grant.session_id).is_some_and(|t| t == token) {
                table.by_session.remove(&grant.session_id);
            }
        }
    }

    /// The live token of `session_id`, if it has one — what the session's MCP
    /// server entry carries.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn token_for(&self, session_id: &str) -> Option<String> {
        self.table.lock().by_session.get(session_id).cloned()
    }

    /// Revoke `session_id`'s token. Idempotent.
    pub fn revoke(&self, session_id: &str) {
        let mut table = self.table.lock();
        if let Some(token) = table.by_session.remove(session_id) {
            table.by_token.remove(&token);
        }
    }

    /// What `token` grants, if it is live.
    pub fn grant(&self, token: &str) -> Option<Grant> {
        self.table.lock().by_token.get(token).cloned()
    }
}

/// A session gets its token when it starts and loses it when it ends.
impl SessionLifecycle for MemoryTokens {
    fn session_started(&self, session_id: &str, agent: &str, cwd: &str) {
        if cwd.is_empty() {
            return;
        }
        // A rebind of a live session in the same place keeps its token — and
        // so does the start reported right after an offer was bound to it:
        // that token is the one the agent holds. Compared as paths, so a
        // trailing separator is not a move.
        let mut table = self.table.lock();
        let same = table
            .by_session
            .get(session_id)
            .and_then(|t| table.by_token.get(t))
            .is_some_and(|g| std::path::Path::new(&g.cwd) == std::path::Path::new(cwd) && g.agent == agent);
        if !same {
            Self::mint_locked(&mut table, session_id, agent, cwd);
        }
    }

    fn session_ended(&self, session_id: &str) {
        self.revoke(session_id);
    }
}

// ── Server ───────────────────────────────────────────────────────────────────

/// Whether shared memory is switched on for a launch directory (the Memory
/// panel's sharing toggle). Checked on every tool call, so flipping it off
/// mid-session takes effect at once.
pub type SharingGate = Arc<dyn Fn(&str) -> bool + Send + Sync>;

/// The running server. Dropping it (or [`shutdown`](Self::shutdown)) stops it.
pub struct MemoryServer {
    addr: SocketAddr,
    stop: Option<oneshot::Sender<()>>,
}

impl MemoryServer {
    /// Bind `127.0.0.1:0` and serve the four tools over `memory`, admitting
    /// only requests bearing a live token from `tokens`. Returns once bound;
    /// serving continues on the runtime.
    #[cfg_attr(not(test), allow(dead_code))]
    pub async fn start(
        memory: SharedMemoryStore,
        tokens: Arc<MemoryTokens>,
        gate: SharingGate,
    ) -> std::io::Result<Self> {
        Self::start_with_index(memory, tokens, gate, None).await
    }

    /// [`start`](Self::start), with `memory_search` also searching the
    /// project's indexed documents through `index`.
    pub async fn start_with_index(
        memory: SharedMemoryStore,
        tokens: Arc<MemoryTokens>,
        gate: SharingGate,
        index: Option<IndexSearch>,
    ) -> std::io::Result<Self> {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?;
        let addr = listener.local_addr()?;
        let tools = MemoryTools { memory, gate, index };
        let service = StreamableHttpService::new(
            move || Ok(tools.clone()),
            Arc::new(LocalSessionManager::default()),
            StreamableHttpServerConfig::default(),
        );
        let router = axum::Router::new()
            .nest_service(MCP_PATH, service)
            .layer(middleware::from_fn_with_state(tokens, require_token));
        let (stop, stopped) = oneshot::channel::<()>();
        tokio::spawn(async move {
            let served = axum::serve(listener, router)
                .with_graceful_shutdown(async move {
                    let _ = stopped.await;
                })
                .await;
            if let Err(e) = served {
                tracing::warn!(target: "atlas::memory_server", "memory tool server stopped: {e}");
            }
        });
        tracing::info!(target: "atlas::memory_server", "memory tool server on http://{addr}{MCP_PATH}");
        Ok(Self { addr, stop: Some(stop) })
    }

    /// The MCP endpoint, e.g. `http://127.0.0.1:53124/mcp`.
    pub fn url(&self) -> String {
        format!("http://{}{MCP_PATH}", self.addr)
    }

    /// Stop serving.
    pub fn shutdown(&mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
    }
}

impl Drop for MemoryServer {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// The app's one memory tool server and its tokens, as managed state. The
/// tokens exist from the start; the server's URL once it has bound.
#[derive(Default)]
pub struct MemoryServerHost {
    tokens: Arc<MemoryTokens>,
    server: std::sync::OnceLock<MemoryServer>,
}

impl MemoryServerHost {
    pub fn new() -> Self {
        Self::default()
    }

    /// The live session tokens (minted and revoked by the session lifecycle).
    pub fn tokens(&self) -> &Arc<MemoryTokens> {
        &self.tokens
    }

    /// The MCP endpoint, once the server has bound; `None` before that or if
    /// binding failed (sessions then run without memory tools).
    pub fn url(&self) -> Option<String> {
        self.server.get().map(MemoryServer::url)
    }

    /// Start the server on the async runtime; returns at once. A failure to
    /// bind is logged and leaves [`url`](Self::url) `None`.
    pub fn start(self: &Arc<Self>, memory: SharedMemoryStore, gate: SharingGate, index: Option<IndexSearch>) {
        let host = self.clone();
        tauri::async_runtime::spawn(async move {
            match MemoryServer::start_with_index(memory, host.tokens.clone(), gate, index).await {
                Ok(server) => {
                    let _ = host.server.set(server);
                }
                Err(e) => tracing::warn!(target: "atlas::memory_server", "memory tool server did not start: {e}"),
            }
        });
    }
}

// ── Handing the server to sessions ───────────────────────────────────────────

/// Whether one session request is handed the memory tool server.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OfferDecision {
    Included,
    /// Left out, and why.
    Omitted(&'static str),
}

impl OfferDecision {
    /// The one log line per session request: the agent, whether it advertised
    /// HTTP MCP, and whether the server was included (and if not, why).
    pub fn log_line(self, agent: &str, http_mcp: bool) -> String {
        match self {
            Self::Included => format!("memory tool server offer: agent={agent} http_mcp={http_mcp} memory_server=included"),
            Self::Omitted(reason) => format!(
                "memory tool server offer: agent={agent} http_mcp={http_mcp} memory_server=omitted reason=\"{reason}\""
            ),
        }
    }

    /// Included only for an agent that advertised HTTP MCP, in a project with
    /// shared memory on (the tools would hold nothing otherwise), once the
    /// server is running. Never decided by which agent it is.
    pub fn decide(http_mcp: bool, sharing_on: bool, server_running: bool) -> Self {
        if !http_mcp {
            Self::Omitted("agent did not advertise mcpCapabilities.http")
        } else if !sharing_on {
            Self::Omitted("shared memory is off for this project")
        } else if !server_running {
            Self::Omitted("memory tool server is not running")
        } else {
            Self::Included
        }
    }
}

/// Offers each session the memory tool server with a token of its own
/// ([`SessionMcpServers`], installed on every agent connection).
pub struct MemorySessionOffers {
    host: Arc<MemoryServerHost>,
    gate: SharingGate,
}

impl MemorySessionOffers {
    pub fn new(host: Arc<MemoryServerHost>, gate: SharingGate) -> Self {
        Self { host, gate }
    }
}

impl SessionMcpServers for MemorySessionOffers {
    fn offer(&self, request: &SessionMcpRequest) -> SessionMcpOffer {
        let cwd = request.cwd.to_string_lossy().into_owned();
        let agent = request.agent_id.as_str().to_string();
        // The gate reads the sharing file; only asked when it can matter.
        let sharing_on = request.http_mcp && (self.gate)(&cwd);
        let url = self.host.url();
        let decision = OfferDecision::decide(request.http_mcp, sharing_on, url.is_some());
        tracing::info!(
            target: "atlas::memory_server",
            session = request.session_id.as_ref().map(ToString::to_string).unwrap_or_default(),
            "{}",
            decision.log_line(&agent, request.http_mcp),
        );
        let (OfferDecision::Included, Some(url)) = (decision, url) else {
            return SessionMcpOffer::none();
        };
        let tokens = self.host.tokens().clone();
        let token = tokens.mint_unbound(&agent, &cwd);
        let server = acp::McpServer::Http(
            acp::McpServerHttp::new(MEMORY_SERVER_NAME, url)
                .headers(vec![acp::HttpHeader::new("Authorization", format!("Bearer {token}"))]),
        );
        SessionMcpOffer::new(vec![server], move |session| match session {
            Some(id) => tokens.bind(&token, &id.to_string()),
            None => tokens.revoke_token(&token),
        })
    }
}

/// Admit a request only with `Authorization: Bearer <live token>`; hand the
/// token's [`Grant`] to the tool handler through the request extensions.
async fn require_token(
    State(tokens): State<Arc<MemoryTokens>>,
    mut request: Request<Body>,
    next: Next,
) -> Result<Response, StatusCode> {
    let grant = request
        .headers()
        .get(AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .and_then(|token| tokens.grant(token.trim()));
    match grant {
        Some(grant) => {
            request.extensions_mut().insert(grant);
            Ok(next.run(request).await)
        }
        None => Err(StatusCode::UNAUTHORIZED),
    }
}

// ── Tools ────────────────────────────────────────────────────────────────────

#[derive(Clone)]
struct MemoryTools {
    memory: SharedMemoryStore,
    gate: SharingGate,
    /// The project's indexed documents, searched alongside the record.
    index: Option<IndexSearch>,
}

/// An index search a `memory_search` call asks for: `(query, limit)`.
type IndexQuery = Option<(String, usize)>;

/// The spellings of every kind, or of the durable ones.
fn kind_names(durable_only: bool) -> Vec<&'static str> {
    EntryKind::ALL
        .into_iter()
        .filter(|k| !durable_only || k.is_durable())
        .map(EntryKind::as_str)
        .collect()
}

fn durable_kinds() -> Vec<EntryKind> {
    EntryKind::ALL.into_iter().filter(|k| k.is_durable()).collect()
}

fn schema(value: Value) -> Arc<JsonObject> {
    match value {
        Value::Object(map) => Arc::new(map),
        _ => Arc::new(JsonObject::new()),
    }
}

fn tools() -> Vec<Tool> {
    vec![
        Tool::new(
            Cow::Borrowed("memory_search"),
            Cow::Borrowed(
                "Search this repository's shared memory — the decisions, facts, failures and architecture notes \
                 recorded by every agent — and its indexed project memory (docs, conventions, feature notes, \
                 codebase summaries). Returns the best matches first: `entries` from shared memory, `documents` \
                 from the index. Use it BEFORE asking the user about project history or established patterns. \
                 Pass kinds [\"plan\", \"file_changed\"] to search working memory (the active plan, recent file \
                 changes) instead.",
            ),
            schema(json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "What to look for." },
                    "kinds": { "type": "array", "items": { "type": "string", "enum": kind_names(false) },
                               "description": "Only these kinds (default: the four durable kinds)." },
                    "limit": { "type": "integer", "minimum": 1, "maximum": SEARCH_MAX_LIMIT,
                               "description": "At most this many results (default 10)." }
                },
                "required": ["query"]
            })),
        ),
        Tool::new(
            Cow::Borrowed("memory_remember"),
            Cow::Borrowed(
                "Record a durable memory for every agent on this repository: a decision, a fact, a failure \
                 (something tried that did not work) or an architecture note. Give a key to make a later \
                 remember with the same key replace this one. The plan and file changes are captured \
                 automatically and cannot be remembered.",
            ),
            schema(json!({
                "type": "object",
                "properties": {
                    "kind": { "type": "string", "enum": kind_names(true) },
                    "content": { "type": "string", "description": "The memory, stated on its own." },
                    "key": { "type": "string", "description": "Optional topic key; the same key replaces." }
                },
                "required": ["kind", "content"]
            })),
        ),
        Tool::new(
            Cow::Borrowed("memory_forget"),
            Cow::Borrowed("Delete one shared-memory entry by its id (from memory_search or memory_list)."),
            schema(json!({
                "type": "object",
                "properties": { "id": { "type": "integer" } },
                "required": ["id"]
            })),
        ),
        Tool::new(
            Cow::Borrowed("memory_list"),
            Cow::Borrowed("List the newest shared-memory entries, of one kind or of every kind."),
            schema(json!({
                "type": "object",
                "properties": { "kind": { "type": "string", "enum": kind_names(false) } }
            })),
        ),
    ]
}

#[derive(Deserialize)]
struct SearchArgs {
    query: String,
    #[serde(default)]
    kinds: Vec<String>,
    limit: Option<usize>,
}

#[derive(Deserialize)]
struct RememberArgs {
    kind: String,
    content: String,
    #[serde(default)]
    key: String,
}

#[derive(Deserialize)]
struct ForgetArgs {
    id: i64,
}

#[derive(Deserialize)]
struct ListArgs {
    kind: Option<String>,
}

fn parse_kind(raw: &str) -> Result<EntryKind, String> {
    EntryKind::parse(raw.trim()).ok_or_else(|| format!("unknown kind `{raw}`; one of {}", kind_names(false).join(", ")))
}

fn entry_json(e: &Entry) -> Value {
    json!({
        "id": e.id,
        "kind": e.kind.as_str(),
        "key": e.key,
        "content": e.content,
        "source": e.source,
        "confidence": e.confidence,
        "updatedAt": e.updated_at,
        "uses": e.uses,
    })
}

fn ok_json(value: Value) -> CallToolResult {
    CallToolResult::success(vec![Content::text(value.to_string())])
}

fn tool_error(message: impl Into<String>) -> CallToolResult {
    CallToolResult::error(vec![Content::text(message.into())])
}

/// `result`'s JSON object with the index's `documents` added.
fn with_documents(result: CallToolResult, docs: &[IndexDoc]) -> CallToolResult {
    let parsed = result
        .content
        .iter()
        .find_map(|c| c.as_text().map(|t| t.text.clone()))
        .and_then(|text| serde_json::from_str::<Value>(&text).ok());
    let Some(Value::Object(mut object)) = parsed else {
        return result;
    };
    let documents: Vec<Value> = docs
        .iter()
        .map(|d| json!({ "title": d.title, "source": d.source, "text": d.text.trim() }))
        .collect();
    object.insert("documents".to_string(), Value::Array(documents));
    ok_json(Value::Object(object))
}

fn args<T: for<'de> Deserialize<'de>>(request: &CallToolRequestParams) -> Result<T, CallToolResult> {
    let object = request.arguments.clone().unwrap_or_default();
    serde_json::from_value(Value::Object(object)).map_err(|e| tool_error(format!("invalid arguments: {e}")))
}

impl MemoryTools {
    /// Run one tool for `grant`. Blocking: touches the record. A search also
    /// says which index search to add (run by the caller: it is async).
    fn call(&self, grant: &Grant, request: &CallToolRequestParams) -> (CallToolResult, IndexQuery) {
        let empty = |key: &str| ok_json(json!({ key: [] }));
        if !(self.gate)(&grant.cwd) {
            return match request.name.as_ref() {
                "memory_search" | "memory_list" => (empty("entries"), None),
                _ => (tool_error("shared memory is switched off for this project"), None),
            };
        }
        if request.name.as_ref() == "memory_search" {
            return self.search(grant, request);
        }
        (self.call_record(grant, request), None)
    }

    /// `memory_search` over the record, plus the index search to add when no
    /// kinds narrow it to working memory.
    fn search(&self, grant: &Grant, request: &CallToolRequestParams) -> (CallToolResult, IndexQuery) {
        let args: SearchArgs = match args(request) {
            Ok(a) => a,
            Err(refused) => return (refused, None),
        };
        let kinds = match args.kinds.iter().map(|k| parse_kind(k)).collect::<Result<Vec<_>, _>>() {
            Ok(k) if k.is_empty() => durable_kinds(),
            Ok(k) => k,
            Err(e) => return (tool_error(e), None),
        };
        let limit = args.limit.unwrap_or(SEARCH_DEFAULT_LIMIT).clamp(1, SEARCH_MAX_LIMIT);
        let hits = self.memory.search_entries(&grant.cwd, &args.query, &kinds, limit);
        let index = (self.index.is_some() && args.kinds.is_empty()).then(|| {
            let limit = args.limit.unwrap_or(INDEX_DEFAULT_LIMIT).clamp(1, INDEX_MAX_LIMIT);
            (args.query.clone(), limit)
        });
        (ok_json(json!({ "entries": hits.iter().map(entry_json).collect::<Vec<_>>() })), index)
    }

    /// The record-only tools.
    fn call_record(&self, grant: &Grant, request: &CallToolRequestParams) -> CallToolResult {
        let memory = &self.memory;
        match request.name.as_ref() {
            "memory_remember" => {
                let args: RememberArgs = match args(request) {
                    Ok(a) => a,
                    Err(refused) => return refused,
                };
                let kind = match parse_kind(&args.kind) {
                    Ok(k) => k,
                    Err(e) => return tool_error(e),
                };
                let writer = Writer {
                    agent: grant.agent.clone(),
                    session_id: grant.session_id.clone(),
                };
                match memory.remember(&grant.cwd, &writer, kind, &args.content, &args.key) {
                    Ok(r) => ok_json(json!({ "outcome": r.outcome.as_str(), "entry": entry_json(&r.entry) })),
                    Err(e) => tool_error(format!("not remembered: {e}")),
                }
            }
            "memory_forget" => {
                let args: ForgetArgs = match args(request) {
                    Ok(a) => a,
                    Err(refused) => return refused,
                };
                match memory.forget(&grant.cwd, args.id) {
                    Ok(gone) => ok_json(json!({ "forgotten": gone.is_some(), "id": args.id })),
                    Err(e) => tool_error(format!("not forgotten: {e}")),
                }
            }
            "memory_list" => {
                let args: ListArgs = match args(request) {
                    Ok(a) => a,
                    Err(refused) => return refused,
                };
                let kind = match args.kind.as_deref().map(parse_kind).transpose() {
                    Ok(k) => k,
                    Err(e) => return tool_error(e),
                };
                let entries = memory.list_entries(&grant.cwd, kind);
                ok_json(json!({ "entries": entries.iter().map(entry_json).collect::<Vec<_>>() }))
            }
            other => tool_error(format!("unknown tool `{other}`")),
        }
    }
}

impl ServerHandler for MemoryTools {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build()).with_instructions(
            "Atlas shared memory: what every agent on this repository has learned. Search it before \
             deciding something another agent may already have decided; remember durable decisions, \
             facts, failures and architecture notes.",
        )
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, McpError> {
        Ok(ListToolsResult::with_all_items(tools()))
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, McpError> {
        let grant = context
            .extensions
            .get::<axum::http::request::Parts>()
            .and_then(|parts| parts.extensions.get::<Grant>())
            .cloned()
            .ok_or_else(|| McpError::invalid_request("no session token", None))?;
        let tools = self.clone();
        let cwd = grant.cwd.clone();
        let (result, index_query) = tokio::task::spawn_blocking(move || tools.call(&grant, &request))
            .await
            .unwrap_or_else(|e| (tool_error(format!("memory unavailable: {e}")), None));
        let result = match (index_query, self.index.as_ref()) {
            (Some((query, limit)), Some(index)) => with_documents(result, &index(cwd, query, limit).await),
            _ => result,
        };
        Ok(result.into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::shared_memory::MemoryChanged;
    use atlas_memory::record::{Embedder, Embedding};
    use rmcp::service::RunningService;
    use rmcp::transport::streamable_http_client::StreamableHttpClientTransportConfig;
    use rmcp::transport::StreamableHttpClientTransport;
    use rmcp::{RoleClient, ServiceExt};
    use std::sync::atomic::{AtomicI64, Ordering};

    fn temp_project(label: &str) -> String {
        let dir = std::env::temp_dir().join(format!("atlas-memory-server-{label}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.to_string_lossy().into_owned()
    }

    fn ticking_memory() -> SharedMemoryStore {
        let t = Arc::new(AtomicI64::new(1_000));
        SharedMemoryStore::with_clock(Arc::new(move || t.fetch_add(1_000, Ordering::SeqCst)))
    }

    fn always_on() -> SharingGate {
        Arc::new(|_| true)
    }

    async fn connect(url: &str, token: &str) -> Result<RunningService<RoleClient, ()>, String> {
        let transport = StreamableHttpClientTransport::from_config(
            StreamableHttpClientTransportConfig::with_uri(url.to_string()).auth_header(token.to_string()),
        );
        ().serve(transport).await.map_err(|e| format!("{e:?}"))
    }

    async fn call(client: &RunningService<RoleClient, ()>, name: &'static str, args: Value) -> (bool, Value) {
        let Value::Object(args) = args else { panic!("object args") };
        let result = client
            .call_tool(CallToolRequestParams::new(name).with_arguments(args))
            .await
            .expect("the tool call completes");
        let text = result
            .content
            .iter()
            .find_map(|c| c.as_text().map(|t| t.text.clone()))
            .unwrap_or_default();
        let value = serde_json::from_str(&text).unwrap_or(Value::String(text));
        (result.is_error.unwrap_or(false), value)
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_session_token_exercises_all_four_tools_over_loopback() {
        let project = temp_project("tools");
        let memory = ticking_memory();
        let tokens = Arc::new(MemoryTokens::default());
        let server = MemoryServer::start(memory.clone(), tokens.clone(), always_on()).await.unwrap();
        assert!(server.url().starts_with("http://127.0.0.1:"), "{}", server.url());
        let token = tokens.mint("s1", "claude", &project);
        let client = connect(&server.url(), &token).await.expect("a live token connects");

        let names: Vec<String> =
            client.list_all_tools().await.unwrap().into_iter().map(|t| t.name.to_string()).collect();
        assert_eq!(names, ["memory_search", "memory_remember", "memory_forget", "memory_list"]);

        let (err, remembered) = call(
            &client,
            "memory_remember",
            json!({ "kind": "decision", "key": "jwt", "content": "Sign JWTs with RS256" }),
        )
        .await;
        assert!(!err, "{remembered}");
        assert_eq!(remembered["outcome"], "inserted");
        assert_eq!(remembered["entry"]["source"], "claude");
        assert_eq!(remembered["entry"]["confidence"], 1.0);
        let id = remembered["entry"]["id"].as_i64().unwrap();

        let (_, found) = call(&client, "memory_search", json!({ "query": "jwt rs256" })).await;
        assert_eq!(found["entries"][0]["id"], id, "{found}");
        assert_eq!(found["entries"][0]["content"], "Sign JWTs with RS256");

        let (_, listed) = call(&client, "memory_list", json!({ "kind": "decision" })).await;
        assert_eq!(listed["entries"].as_array().unwrap().len(), 1, "{listed}");

        let (err, forgotten) = call(&client, "memory_forget", json!({ "id": id })).await;
        assert!(!err);
        assert_eq!(forgotten["forgotten"], true);
        let (_, listed) = call(&client, "memory_list", json!({})).await;
        assert_eq!(listed["entries"], json!([]));

        client.cancel().await.ok();
        let _ = std::fs::remove_dir_all(&project);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn an_unknown_or_revoked_token_is_refused() {
        let project = temp_project("auth");
        let memory = ticking_memory();
        let tokens = Arc::new(MemoryTokens::default());
        let server = MemoryServer::start(memory.clone(), tokens.clone(), always_on()).await.unwrap();

        assert!(connect(&server.url(), "not-a-token").await.is_err(), "an unknown token connects");

        // Revoked through the session lifecycle, while the MCP session is open.
        tokens.session_started("s1", "codex", &project);
        let token = tokens.token_for("s1").expect("minted at session start");
        let client = connect(&server.url(), &token).await.expect("a live token connects");
        let (err, _) = call(&client, "memory_list", json!({})).await;
        assert!(!err);
        tokens.session_ended("s1");
        assert_eq!(tokens.token_for("s1"), None);
        let refused = client
            .call_tool(CallToolRequestParams::new("memory_list").with_arguments(JsonObject::new()))
            .await;
        assert!(refused.is_err(), "a revoked token still calls tools: {refused:?}");
        assert!(connect(&server.url(), &token).await.is_err(), "a revoked token reconnects");
        let _ = std::fs::remove_dir_all(&project);
    }

    /// Two near-identical phrasings embed to vectors with cosine 0.96.
    struct TwoPhrasings;
    impl Embedder for TwoPhrasings {
        fn embed(&self, text: &str) -> Option<Embedding> {
            let vector = match text {
                "Postgres is the only database" => vec![1.0, 0.0],
                "The only database is Postgres" => vec![0.96, 0.28],
                _ => return None,
            };
            Some(Embedding {
                model: "test-2".into(),
                vector,
            })
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn remember_replaces_by_key_merges_near_duplicates_and_rejects_working_memory() {
        let project = temp_project("remember");
        let memory = ticking_memory();
        let tokens = Arc::new(MemoryTokens::default());
        let server = MemoryServer::start(memory.clone(), tokens.clone(), always_on()).await.unwrap();
        let client = connect(&server.url(), &tokens.mint("s1", "gemini", &project)).await.unwrap();
        crate::commands::shared_memory::store_for(&project)
            .unwrap()
            .set_embedder(Some(Arc::new(TwoPhrasings)));

        let (_, first) =
            call(&client, "memory_remember", json!({ "kind": "decision", "key": "alg", "content": "HS256" })).await;
        let (_, second) =
            call(&client, "memory_remember", json!({ "kind": "decision", "key": "alg", "content": "RS256" })).await;
        assert_eq!(second["outcome"], "replaced");
        assert_eq!(second["entry"]["id"], first["entry"]["id"]);
        assert_eq!(second["entry"]["content"], "RS256");

        let (_, fact) =
            call(&client, "memory_remember", json!({ "kind": "fact", "content": "Postgres is the only database" }))
                .await;
        let (_, near) =
            call(&client, "memory_remember", json!({ "kind": "fact", "content": "The only database is Postgres" }))
                .await;
        assert_eq!(near["outcome"], "merged", "{near}");
        assert_eq!(near["entry"]["id"], fact["entry"]["id"]);
        assert_eq!(near["entry"]["uses"], 1);

        for kind in ["plan", "file_changed"] {
            let (err, refused) =
                call(&client, "memory_remember", json!({ "kind": kind, "content": "do the thing" })).await;
            assert!(err, "{kind} was remembered: {refused}");
        }
        let (_, plans) = call(&client, "memory_list", json!({ "kind": "plan" })).await;
        assert_eq!(plans["entries"], json!([]));
        let _ = std::fs::remove_dir_all(&project);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_write_through_the_server_shows_in_the_shared_tab_and_is_announced() {
        let project = temp_project("visible");
        let memory = ticking_memory();
        let announced: Arc<Mutex<Vec<MemoryChanged>>> = Arc::default();
        memory.on_change({
            let announced = announced.clone();
            Arc::new(move |c: &MemoryChanged| announced.lock().push(c.clone()))
        });
        let tokens = Arc::new(MemoryTokens::default());
        let server = MemoryServer::start(memory.clone(), tokens.clone(), always_on()).await.unwrap();
        let client = connect(&server.url(), &tokens.mint("s9", "codex", &project)).await.unwrap();

        let secret = "sk-proj-AbCdEf0123456789GhIjKlMnOpQrStUv";
        let (err, _) = call(
            &client,
            "memory_remember",
            json!({ "kind": "failure", "content": format!("Retrying with {secret} did not help") }),
        )
        .await;
        assert!(!err);

        // The Shared tab's commands see it: the state view and the event list.
        let state = memory.get_state(&project);
        assert_eq!(state.failures.len(), 1, "{state:?}");
        assert_eq!(state.failures[0].agent, "codex");
        assert!(!state.failures[0].text.contains(secret), "{}", state.failures[0].text);
        let events = memory.list_events(&project);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].session_id, "s9");
        assert!(!memory.query(&project, "did not help", 10).is_empty());

        let announced = announced.lock().clone();
        assert_eq!(announced.len(), 1, "{announced:?}");
        assert_eq!(announced[0].kinds, ["failure"]);
        let _ = std::fs::remove_dir_all(&project);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn with_sharing_off_the_tools_hold_no_memory() {
        let project = temp_project("gated");
        let memory = ticking_memory();
        let tokens = Arc::new(MemoryTokens::default());
        let server = MemoryServer::start(memory.clone(), tokens.clone(), Arc::new(|_| false)).await.unwrap();
        let client = connect(&server.url(), &tokens.mint("s1", "claude", &project)).await.unwrap();
        let (err, _) = call(&client, "memory_remember", json!({ "kind": "fact", "content": "x" })).await;
        assert!(err);
        let (err, found) = call(&client, "memory_search", json!({ "query": "x" })).await;
        assert!(!err);
        assert_eq!(found["entries"], json!([]));
        assert!(memory.list_events(&project).is_empty());
        let _ = std::fs::remove_dir_all(&project);
    }

    // ── Handing the server to sessions (#83) ─────────────────────────────────

    async fn running_host(gate: SharingGate) -> Arc<MemoryServerHost> {
        let host = Arc::new(MemoryServerHost::new());
        let server = MemoryServer::start(ticking_memory(), host.tokens().clone(), gate.clone()).await.unwrap();
        let _ = host.server.set(server);
        host
    }

    fn request(http_mcp: bool, cwd: &str, session: Option<&str>) -> SessionMcpRequest {
        SessionMcpRequest {
            agent_id: atlas_acp_thread::AgentId::new("claude-code"),
            http_mcp,
            cwd: std::path::PathBuf::from(cwd),
            session_id: session.map(acp::SessionId::new),
        }
    }

    /// The one server an offer carries, as `(name, url, bearer token)`.
    fn offered(offer: &SessionMcpOffer) -> Option<(String, String, String)> {
        match offer.servers() {
            [acp::McpServer::Http(http)] => {
                let token = http
                    .headers
                    .iter()
                    .find(|h| h.name == "Authorization")
                    .and_then(|h| h.value.strip_prefix("Bearer "))
                    .expect("the entry carries a bearer token")
                    .to_string();
                Some((http.name.clone(), http.url.clone(), token))
            }
            [] => None,
            other => panic!("one server at most: {other:?}"),
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn an_http_agent_is_offered_the_server_with_a_token_that_binds_to_its_session() {
        let project = temp_project("offer");
        let host = running_host(always_on()).await;
        let offers = MemorySessionOffers::new(host.clone(), always_on());

        let offer = offers.offer(&request(true, &project, None));
        let (name, url, token) = offered(&offer).expect("an HTTP agent with sharing on gets the server");
        assert_eq!(name, MEMORY_SERVER_NAME);
        assert_eq!(Some(url.clone()), host.url());
        let client = connect(&url, &token).await.expect("the offered token is live before the id exists");
        client.cancel().await.ok();

        offer.bind(&acp::SessionId::new("s1"));
        assert_eq!(host.tokens().token_for("s1").as_deref(), Some(token.as_str()));
        let grant = host.tokens().grant(&token).unwrap();
        assert_eq!((grant.session_id.as_str(), grant.agent.as_str(), grant.cwd.as_str()), ("s1", "claude-code", project.as_str()));

        // The session start the host reports next keeps the token the agent
        // holds, however the directory is spelled.
        host.tokens().session_started("s1", "claude-code", &format!("{project}/"));
        assert_eq!(host.tokens().token_for("s1").as_deref(), Some(token.as_str()));

        // And the session's end revokes it.
        host.tokens().session_ended("s1");
        assert!(connect(&url, &token).await.is_err(), "a revoked token is refused");
        let _ = std::fs::remove_dir_all(&project);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn an_agent_without_http_mcp_is_offered_nothing() {
        let host = running_host(always_on()).await;
        let offers = MemorySessionOffers::new(host, always_on());
        assert_eq!(offered(&offers.offer(&request(false, "/p", None))), None);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn with_sharing_off_nothing_is_offered() {
        let host = running_host(always_on()).await;
        let offers = MemorySessionOffers::new(host, Arc::new(|_| false));
        assert_eq!(offered(&offers.offer(&request(true, "/p", None))), None);
    }

    #[test]
    fn before_the_server_binds_nothing_is_offered() {
        let offers = MemorySessionOffers::new(Arc::new(MemoryServerHost::new()), always_on());
        assert_eq!(offered(&offers.offer(&request(true, "/p", None))), None);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn an_offer_that_never_binds_leaves_no_live_token() {
        let host = running_host(always_on()).await;
        let offers = MemorySessionOffers::new(host.clone(), always_on());
        let offer = offers.offer(&request(true, "/p", Some("stored-1")));
        let (_, _, token) = offered(&offer).unwrap();
        drop(offer);
        assert_eq!(host.tokens().grant(&token), None);
        assert_eq!(host.tokens().token_for("stored-1"), None);
    }

    #[test]
    fn the_decision_says_whether_the_server_is_included_and_why_not() {
        assert_eq!(OfferDecision::decide(true, true, true), OfferDecision::Included);
        assert_eq!(OfferDecision::decide(false, true, true), OfferDecision::Omitted("agent did not advertise mcpCapabilities.http"));
        assert_eq!(OfferDecision::decide(true, false, true), OfferDecision::Omitted("shared memory is off for this project"));
        assert_eq!(OfferDecision::decide(true, true, false), OfferDecision::Omitted("memory tool server is not running"));
    }

    #[test]
    fn each_decision_is_one_log_line_naming_the_agent_its_capability_and_the_outcome() {
        assert_eq!(
            OfferDecision::Included.log_line("claude-code", true),
            "memory tool server offer: agent=claude-code http_mcp=true memory_server=included",
        );
        assert_eq!(
            OfferDecision::decide(false, false, true).log_line("gemini", false),
            "memory tool server offer: agent=gemini http_mcp=false memory_server=omitted \
             reason=\"agent did not advertise mcpCapabilities.http\"",
        );
        assert_eq!(
            OfferDecision::decide(true, false, true).log_line("cersei", true),
            "memory tool server offer: agent=cersei http_mcp=true memory_server=omitted \
             reason=\"shared memory is off for this project\"",
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn memory_search_also_returns_indexed_project_documents() {
        // What the native agent's `search_memory` answered from, so its
        // replacement loses nothing: the project's indexed documents.
        let project = temp_project("index");
        let tokens = Arc::new(MemoryTokens::default());
        let asked = Arc::new(Mutex::new(Vec::new()));
        let seen = asked.clone();
        let index: IndexSearch = Arc::new(move |cwd: String, query: String, limit: usize| {
            seen.lock().push((cwd, query.clone(), limit));
            Box::pin(async move {
                vec![IndexDoc {
                    title: "ADR-0003".to_string(),
                    source: "docs/adr/0003.md".to_string(),
                    text: format!("about {query}"),
                }]
            })
        });
        let server = MemoryServer::start_with_index(ticking_memory(), tokens.clone(), always_on(), Some(index))
            .await
            .unwrap();
        let client = connect(&server.url(), &tokens.mint("s1", "cersei", &project)).await.unwrap();

        let (err, found) = call(&client, "memory_search", json!({ "query": "the engine fork" })).await;
        assert!(!err, "{found}");
        assert_eq!(found["entries"], json!([]));
        assert_eq!(
            found["documents"],
            json!([{ "title": "ADR-0003", "source": "docs/adr/0003.md", "text": "about the engine fork" }]),
        );
        assert_eq!(*asked.lock(), vec![(project.clone(), "the engine fork".to_string(), 6)]);

        // A working-memory search is a search of the record alone.
        let (_, found) = call(&client, "memory_search", json!({ "query": "x", "kinds": ["plan"] })).await;
        assert_eq!(found.get("documents"), None, "{found}");
        client.cancel().await.ok();
        let _ = std::fs::remove_dir_all(&project);
    }

    #[test]
    fn a_rebind_keeps_the_token_and_a_move_replaces_it() {
        let tokens = MemoryTokens::default();
        tokens.session_started("s1", "claude", "/a");
        let first = tokens.token_for("s1").unwrap();
        tokens.session_started("s1", "claude", "/a");
        assert_eq!(tokens.token_for("s1").as_deref(), Some(first.as_str()));
        tokens.session_started("s1", "claude", "/b");
        let moved = tokens.token_for("s1").unwrap();
        assert_ne!(moved, first);
        assert_eq!(tokens.grant(&first), None);
        assert_eq!(tokens.grant(&moved).unwrap().cwd, "/b");
    }
}
