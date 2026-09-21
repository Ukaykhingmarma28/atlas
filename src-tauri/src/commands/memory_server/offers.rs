//! Handing the server to sessions.
//!
//! Every agent that can take the server is handed it on each session request
//! ([`MemorySessionOffers`]): an ACP session request carries the server in
//! `mcpServers` when the agent advertised `mcpCapabilities.http`; the native
//! agent gets it as a StreamableHttp entry in its thread's engine config. The
//! token is minted for the *request*, before a new session's id exists, and
//! bound to the id once the agent answers; an offer that never binds is
//! revoked. Each decision is logged, one line per session request.

use std::sync::Arc;

use agent_client_protocol::schema::v1 as acp;
use atlas_agent_servers::{SessionMcpOffer, SessionMcpRequest, SessionMcpServers};

use super::host::{MemoryServerHost, SharingGate};
use super::MEMORY_SERVER_NAME;

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
