//! MCP servers the host hands a session.
//!
//! ACP carries MCP servers on the session request itself (`session/new`,
//! `session/load` and `session/resume` each take `mcpServers`), so what a
//! session is offered has to be settled before the request goes out. For a
//! new session that is before its id exists: the host mints whatever the
//! entry needs (a bearer token, say) against the *request*, and learns the id
//! only when the connection [binds](SessionMcpOffer::bind) the offer to the
//! session that came back. An offer that is never bound — the request failed,
//! or the connection never sent it — is released when it drops, so nothing the
//! host minted outlives an attempt that went nowhere.
//!
//! The host decides what to offer; the connection only carries it, and never
//! sends a transport the agent did not advertise ([`admissible`]). ACP makes
//! stdio mandatory for every agent and HTTP/SSE opt-in through
//! `mcpCapabilities`, and that is the only gate: never the agent's identity.

use std::path::PathBuf;
use std::sync::Arc;

use agent_client_protocol::schema::v1 as acp;
use atlas_acp_thread::AgentId;

/// What a session is being opened for, as the host sees it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionMcpRequest {
    pub agent_id: AgentId,
    /// Whether the agent advertised `mcpCapabilities.http` at `initialize`.
    pub http_mcp: bool,
    /// The directory the session runs in.
    pub cwd: PathBuf,
    /// The session being loaded or resumed; `None` for a new session, whose
    /// id arrives with the response.
    pub session_id: Option<acp::SessionId>,
}

/// Decides the MCP servers each session is handed. Supplied by the host
/// through `ConnectOptions`.
pub trait SessionMcpServers: Send + Sync {
    fn offer(&self, request: &SessionMcpRequest) -> SessionMcpOffer;
}

/// Told how an offer ended: `Some(id)` when the session it was made for
/// opened with that id, `None` when it never did.
type Settle = Box<dyn FnOnce(Option<&acp::SessionId>) + Send>;

/// The servers for one session request, and what to do once it is known
/// whether that session opened.
pub struct SessionMcpOffer {
    servers: Vec<acp::McpServer>,
    settle: Option<Settle>,
}

impl SessionMcpOffer {
    /// No servers, nothing to settle.
    pub fn none() -> Self {
        Self {
            servers: Vec::new(),
            settle: None,
        }
    }

    /// `servers`, with `settle` told whether the session opened (see
    /// [`Settle`]). Called exactly once: by [`bind`](Self::bind), or on drop.
    pub fn new(
        servers: Vec<acp::McpServer>,
        settle: impl FnOnce(Option<&acp::SessionId>) + Send + 'static,
    ) -> Self {
        Self {
            servers,
            settle: Some(Box::new(settle)),
        }
    }

    pub fn servers(&self) -> &[acp::McpServer] {
        &self.servers
    }

    /// The session this offer was made for opened as `session_id`.
    pub fn bind(mut self, session_id: &acp::SessionId) {
        if let Some(settle) = self.settle.take() {
            settle(Some(session_id));
        }
    }
}

impl Drop for SessionMcpOffer {
    fn drop(&mut self) {
        if let Some(settle) = self.settle.take() {
            settle(None);
        }
    }
}

impl std::fmt::Debug for SessionMcpOffer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SessionMcpOffer")
            .field("servers", &self.servers.len())
            .finish_non_exhaustive()
    }
}

/// Asks `provider` for `request`'s servers; no provider offers nothing.
pub fn offer_for(
    provider: Option<&Arc<dyn SessionMcpServers>>,
    request: &SessionMcpRequest,
) -> SessionMcpOffer {
    provider.map_or_else(SessionMcpOffer::none, |p| p.offer(request))
}

/// The servers an agent with `capabilities` may be sent: stdio always (ACP
/// requires every agent to take it), HTTP and SSE only when advertised.
pub fn admissible(
    servers: &[acp::McpServer],
    capabilities: &acp::McpCapabilities,
) -> Vec<acp::McpServer> {
    servers
        .iter()
        .filter(|server| match server {
            acp::McpServer::Http(_) => capabilities.http,
            acp::McpServer::Sse(_) => capabilities.sse,
            acp::McpServer::Stdio(_) => true,
            #[allow(unreachable_patterns)]
            _ => false,
        })
        .cloned()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    fn http(name: &str) -> acp::McpServer {
        acp::McpServer::Http(acp::McpServerHttp::new(name, "http://127.0.0.1:1/mcp"))
    }

    /// Every settle call the offer made: one entry each, `None` when the
    /// offer was released unbound.
    type SettleLog = Arc<Mutex<Vec<Option<String>>>>;

    fn recorded() -> (SettleLog, impl FnOnce(Option<&acp::SessionId>) + Send) {
        let log = Arc::new(Mutex::new(Vec::new()));
        let sink = log.clone();
        (log, move |id: Option<&acp::SessionId>| {
            sink.lock().unwrap().push(id.map(std::string::ToString::to_string));
        })
    }

    #[test]
    fn a_bound_offer_is_settled_once_with_its_session() {
        let (log, settle) = recorded();
        SessionMcpOffer::new(vec![http("m")], settle).bind(&acp::SessionId::new("s-1"));
        assert_eq!(*log.lock().unwrap(), vec![Some("s-1".to_string())]);
    }

    #[test]
    fn an_offer_dropped_unbound_is_released() {
        let (log, settle) = recorded();
        drop(SessionMcpOffer::new(vec![http("m")], settle));
        assert_eq!(*log.lock().unwrap(), vec![None]);
    }

    #[test]
    fn http_servers_reach_only_agents_that_advertised_http() {
        let servers = vec![http("m")];
        let mut caps = acp::McpCapabilities::default();
        assert!(admissible(&servers, &caps).is_empty());
        caps.http = true;
        assert_eq!(admissible(&servers, &caps), servers);
    }
}
