//! The **organisation tool server**: Atlas Agent's way to read the
//! organisation a session's Project belongs to, and to act in it as the
//! signed-in user (ADR-0014). The third MCP service on the memory tool
//! server's loopback listener, beside the UI tool server, behind the same
//! token check and on the same per-session token — the token store binds one
//! token per session, so a second minted token would revoke the first.
//!
//! - **Offered only to a connection that carries organisation access**
//!   ([`offers`]): today the in-process native connection, never an ACP one,
//!   and never decided by agent identity. Also only while the user lets the
//!   agent act in the organisation, is signed in, and the session's Project is
//!   bound to a Workspace.
//! - **Acts in the organisation the Project is bound to** ([`OrgScope`]),
//!   resolved from the Project's binding when the offer is decided and carried
//!   on the session's grant. The app's active and chat organisations are not
//!   consulted, so a switch in the window cannot redirect a call mid-turn.
//! - **Every remote operation goes through one seam** ([`OrganisationCloud`]):
//!   the production adapter ([`AppOrganisationCloud`]) over the artifacts
//!   client, the chat client and the auth core, which already hold the bearer
//!   in Rust; an in-memory organisation in the tests. The tool handlers
//!   ([`tools`]) never touch a client.
//! - **Gated by the user's organisation-access setting**
//!   ([`OrgAccessGate`]), at offer time and on every call, so switching it off
//!   stops a running session at its next call.
//!
//! Only `org_whoami` exists yet; the rest of the thirteen tools the spec names
//! are added on this skeleton.

mod adapter;
mod cloud;
mod offers;
#[cfg(test)]
mod tests;
mod tools;

use std::sync::Arc;

#[allow(unused_imports)]
pub use adapter::{AppOrganisationCloud, AppSessionOrgs};
#[allow(unused_imports)]
pub use cloud::{Caller, CloudError, CloudFuture, CurrentSessionQuery, OrganisationCloud, RecordedSession};
#[allow(unused_imports)]
pub use offers::{OrgOffer, OrgOfferDecision, SessionOrgs};
#[allow(unused_imports)]
pub use tools::{router, OrgTools, INSTRUCTIONS};

/// The name the server goes by in the agent's MCP configuration; its tools
/// reach the model as `mcp__atlas_org__<tool>`.
pub const ORG_SERVER_NAME: &str = "atlas_org";

/// Where the service is mounted on the tool-server listener.
pub const ORG_PATH: &str = "/org";

/// Whether the user lets Atlas Agent act in the organisation (Settings →
/// General → "Let Atlas Agent act in your organisation"). Checked when a
/// session is offered the server and on every call, so switching it off stops
/// the agent at once.
pub type OrgAccessGate = Arc<dyn Fn() -> bool + Send + Sync>;

/// Where a session's organisation tools act: the organisation its Project is
/// bound to, and the Workspace the binding registered. Resolved once, from the
/// Project's binding, when the session is offered the server, and carried on
/// its grant; the tools read it from there and from nowhere else.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OrgScope {
    /// The organisation's server id.
    pub org_id: String,
    /// The server's Workspace id for the Project — `None` for a binding made
    /// before the server id was recorded, which still names its organisation
    /// but has no Workspace to read.
    pub workspace_id: Option<String>,
}
