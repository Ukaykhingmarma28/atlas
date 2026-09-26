//! The MCP surface of the organisation tool server: the tools, their
//! instructions, and the handler that answers each call through the
//! organisation cloud.
//!
//! Every call is checked twice before anything remote happens: the user's
//! organisation-access setting (off stops a running session at its next
//! call), and the grant's organisation (a token that was not offered the
//! server names none, and is refused). What a tool then asks the cloud, it
//! asks in the grant's organisation and Workspace, never in the window's.
//! Schemas are kept flat, with one-clause descriptions, because every native
//! turn carries them in its fixed prefix.

use std::borrow::Cow;
use std::sync::Arc;

use rmcp::handler::server::ServerHandler;
use rmcp::model::{
    CacheScope, CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock as Content, JsonObject,
    ListToolsResult, PaginatedRequestParams, ServerCapabilities, ServerInfo, Tool,
};
use rmcp::service::{RequestContext, RoleServer};
use rmcp::transport::streamable_http_server::session::local::LocalSessionManager;
use rmcp::transport::{StreamableHttpServerConfig, StreamableHttpService};
use rmcp::ErrorData as McpError;
use serde_json::{json, Value};

use super::cloud::{CurrentSessionQuery, Member, OrgConversation, OrganisationCloud};
use super::resolve::{self, Resolution};
use super::{OrgAccessGate, OrgScope, ORG_PATH};
use crate::commands::memory_server::{Grant, TOOLS_LIST_TTL_MS};

/// What the server tells the agent about itself. The engine shows it as the
/// description of the `atlas_org` tool namespace. It states the protocol,
/// because nothing else will: the tools only answer what they are asked.
pub const INSTRUCTIONS: &str = "\
Atlas organisation. These tools read the organisation this chat's project is bound to (its members, \
recorded sessions, comments and conversations) and act in it as the signed-in user. Call org_whoami \
first whenever the organisation matters: it says who you act as, your role, the Workspace, and the \
current recorded session (the one this chat is written into). Prefer the current session when the \
user says \"this session\" or names none. When a request matches more than one person, session, \
comment or conversation, ask the user which one instead of guessing; a member or conversation named \
by id, name or email that matches several comes back as candidates to ask about. Never mark the user's inbox \
read. Anything that reaches another person (a message, a reply) is an outward action and asks the \
user first; say what you will send. Results are JSON; an error says what was refused or not found.";

/// What a tool answers while the user has switched organisation access off.
const OFF_NOTE: &str =
    "Atlas Agent's organisation access is switched off in Settings → General; ask the user to turn it on.";

/// What a tool answers for a session that was not offered the server — its
/// token names no organisation.
const NO_ORG_NOTE: &str = "This session was not given access to an organisation: its project is not bound to a \
     cloud Workspace, or it was opened before it was. Ask the user to bind the project and start a new chat.";

/// What `org_whoami` says in place of a current session the Workspace does
/// not hold yet.
pub(super) const NOT_RECORDED_YET: &str = "not recorded yet";

fn schema(value: Value) -> Arc<JsonObject> {
    match value {
        Value::Object(map) => Arc::new(map),
        _ => Arc::new(JsonObject::new()),
    }
}

fn tool(name: &'static str, description: &'static str, input: Value) -> Tool {
    Tool::new(Cow::Borrowed(name), Cow::Borrowed(description), schema(input))
}

/// The tools, reads first.
pub(super) fn tools() -> Vec<Tool> {
    vec![
        tool(
            "org_whoami",
            "Who you act as (name, role), the organisation, the Workspace, and the current recorded session \
             (id, title, live, unresolved comments) or why there is none.",
            json!({ "type": "object", "properties": {} }),
        ),
        tool(
            "org_members",
            "The organisation's members with user ids, names, emails and roles, or the one member `name` \
             resolves to.",
            json!({
                "type": "object",
                "properties": {
                    "name": { "type": "string", "description": "A member's id, name or email to resolve." }
                }
            }),
        ),
        tool(
            "org_conversations",
            "Channels, DMs and group DMs with ids, names, kinds and whether you are a member, or the one \
             conversation `name` resolves to.",
            json!({
                "type": "object",
                "properties": {
                    "name": { "type": "string", "description": "A conversation's id or channel name to resolve." }
                }
            }),
        ),
    ]
}

#[cfg(test)]
pub(super) fn tool_names() -> Vec<String> {
    tools().into_iter().map(|t| t.name.to_string()).collect()
}

/// The `tools/list` answer, with the cache fields MCP 2026-07-28 requires
/// (see the memory tool server's `tools_list`).
pub(super) fn tools_list() -> ListToolsResult {
    ListToolsResult::with_all_items(tools())
        .with_ttl_ms(TOOLS_LIST_TTL_MS)
        .with_cache_scope(CacheScope::Private)
}

fn tool_error(message: impl Into<String>) -> CallToolResult {
    CallToolResult::error(vec![Content::text(message.into())])
}

fn tool_json(value: Value) -> CallToolResult {
    CallToolResult::success(vec![Content::text(value.to_string())])
}

/// An optional string argument, blank read as absent.
fn string_arg<'a>(request: &'a CallToolRequestParams, name: &str) -> Option<&'a str> {
    request
        .arguments
        .as_ref()
        .and_then(|args| args.get(name))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

fn member_json(member: &Member) -> Value {
    json!({
        "user_id": member.user_id,
        "name": member.name,
        "email": member.email,
        "role": member.role,
    })
}

/// A conversation as the model reads it. A DM or group DM has no name, so it
/// is described by who is in it, named from the roster when there is one.
fn conversation_json(conversation: &OrgConversation, roster: Option<&[Member]>) -> Value {
    let mut out = json!({
        "id": conversation.id,
        "kind": conversation.kind,
        "name": conversation.name,
        "caller_is_member": conversation.caller_is_member,
    });
    if let Some(ids) = &conversation.member_ids {
        out["members"] = ids
            .iter()
            .map(|id| {
                let name = roster.and_then(|r| r.iter().find(|m| &m.user_id == id)).map(|m| m.name.clone());
                json!({ "user_id": id, "name": name })
            })
            .collect();
    }
    out
}

/// The error for a name that matched more than one: every candidate with its
/// id, and the instruction to ask. JSON, because the model reads the ids out
/// of it once the user has chosen.
fn ambiguous(query: &str, what: &str, candidates: Vec<Value>) -> CallToolResult {
    tool_error(
        json!({
            "error": format!("\"{query}\" matches {} {what}; ask the user which one", candidates.len()),
            "candidates": candidates,
        })
        .to_string(),
    )
}

/// A member named by the model, resolved against the roster
/// ([`resolve::member`]): the one member, or the tool result to answer
/// instead — nobody matched, or several did.
pub(super) fn resolve_member(roster: &[Member], query: &str) -> Result<Member, CallToolResult> {
    match resolve::member(roster, query) {
        Resolution::One(member) => Ok(member.clone()),
        Resolution::None => Err(tool_error(format!(
            "no member matches \"{query}\" by id, name or email; call org_members for the roster"
        ))),
        Resolution::Many(found) => Err(ambiguous(query, "members", found.into_iter().map(member_json).collect())),
    }
}

/// A conversation named by the model, resolved against the conversation list
/// ([`resolve::conversation`]), as [`resolve_member`] does for a member.
pub(super) fn resolve_conversation(
    conversations: &[OrgConversation],
    query: &str,
) -> Result<OrgConversation, CallToolResult> {
    match resolve::conversation(conversations, query) {
        Resolution::One(conversation) => Ok(conversation.clone()),
        Resolution::None => Err(tool_error(format!(
            "no conversation matches \"{query}\" by id or channel name; call org_conversations for the list \
             (a DM is reached through its member)"
        ))),
        Resolution::Many(found) => Err(ambiguous(
            query,
            "conversations",
            found.into_iter().map(|c| conversation_json(c, None)).collect(),
        )),
    }
}

#[derive(Clone)]
pub struct OrgTools {
    cloud: Arc<dyn OrganisationCloud>,
    gate: OrgAccessGate,
}

impl OrgTools {
    pub fn new(cloud: Arc<dyn OrganisationCloud>, gate: OrgAccessGate) -> Self {
        Self { cloud, gate }
    }

    async fn dispatch(&self, grant: Grant, request: CallToolRequestParams) -> CallToolResult {
        if !(self.gate)() {
            return tool_error(OFF_NOTE);
        }
        let Some(scope) = grant.org.clone() else {
            return tool_error(NO_ORG_NOTE);
        };
        match request.name.as_ref() {
            "org_whoami" => self.whoami(&grant, &scope).await,
            "org_members" => self.members(&scope, string_arg(&request, "name")).await,
            "org_conversations" => self.conversations(&scope, string_arg(&request, "name")).await,
            other => tool_error(format!("unknown tool `{other}`")),
        }
    }

    /// `org_whoami`: the caller, the organisation, the Workspace and the
    /// current recorded session. The caller is required — without it there
    /// is no answer — but a comment read that fails leaves the count unknown
    /// rather than failing the identity the agent asked for.
    async fn whoami(&self, grant: &Grant, scope: &OrgScope) -> CallToolResult {
        let caller = match self.cloud.caller(&scope.org_id).await {
            Ok(caller) => caller,
            Err(e) => return tool_error(e.to_string()),
        };
        let query = CurrentSessionQuery { scope, native_session_id: &grant.session_id, cwd: &grant.cwd };
        let current = match self.cloud.current_session(query).await {
            Ok(current) => current,
            Err(e) => return tool_error(e.to_string()),
        };

        let current_session = match current {
            None => Value::Null,
            Some(session) => {
                let mut out = json!({
                    "id": session.id,
                    "title": session.title,
                    "live": session.live,
                });
                match self.cloud.comments(&scope.org_id, &session.workspace_id, &session.id).await {
                    Ok(comments) => {
                        let unresolved = comments
                            .iter()
                            .filter(|c| c.is_root() && !c.is_deleted() && c.resolved_at.is_none())
                            .count();
                        out["unresolved_comments"] = json!(unresolved);
                    }
                    Err(e) => {
                        out["unresolved_comments"] = Value::Null;
                        out["comments_error"] = json!(e.to_string());
                    }
                }
                out
            }
        };

        let mut answer = json!({
            "caller": {
                "user_id": caller.user_id,
                "name": caller.name,
                "role": caller.role,
            },
            "organisation": { "id": scope.org_id, "name": caller.organisation_name },
            "workspace": scope.workspace_id.as_ref().map(|id| json!({ "id": id })),
            "current_session": current_session,
        });
        if answer["current_session"].is_null() {
            answer["current_session_reason"] = json!(NOT_RECORDED_YET);
        }
        tool_json(answer)
    }
}

impl OrgTools {
    /// `org_members`: the roster, or the one member a name resolves to.
    async fn members(&self, scope: &OrgScope, name: Option<&str>) -> CallToolResult {
        let roster = match self.cloud.members(&scope.org_id).await {
            Ok(roster) => roster,
            Err(e) => return tool_error(e.to_string()),
        };
        match name {
            None => tool_json(json!({ "members": roster.iter().map(member_json).collect::<Vec<_>>() })),
            Some(name) => match resolve_member(&roster, name) {
                Ok(member) => tool_json(json!({ "member": member_json(&member) })),
                Err(answer) => answer,
            },
        }
    }

    /// `org_conversations`: the conversations the caller is in, then the
    /// channels they could join, or the one a name resolves to. The roster is
    /// read only to name the people in a DM; when it cannot be, the DMs keep
    /// their member ids and the list still answers.
    async fn conversations(&self, scope: &OrgScope, name: Option<&str>) -> CallToolResult {
        let conversations = match self.cloud.conversations(&scope.org_id).await {
            Ok(conversations) => conversations,
            Err(e) => return tool_error(e.to_string()),
        };
        let chosen = match name {
            None => conversations,
            Some(name) => match resolve_conversation(&conversations, name) {
                Ok(one) => vec![one],
                Err(answer) => return answer,
            },
        };
        let roster = if chosen.iter().any(|c| c.member_ids.is_some()) {
            self.cloud.members(&scope.org_id).await.ok()
        } else {
            None
        };
        let listed: Vec<Value> = chosen.iter().map(|c| conversation_json(c, roster.as_deref())).collect();
        match name {
            None => tool_json(json!({ "conversations": listed })),
            Some(_) => tool_json(json!({ "conversation": listed[0] })),
        }
    }
}

impl ServerHandler for OrgTools {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build()).with_instructions(INSTRUCTIONS)
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, McpError> {
        Ok(tools_list())
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
        Ok(self.dispatch(grant, request).await.into())
    }
}

/// The service, routed at [`ORG_PATH`], for the tool-server listener to merge
/// in front of its token check.
pub fn router(tools: OrgTools) -> axum::Router {
    let service = StreamableHttpService::new(
        move || Ok(tools.clone()),
        Arc::new(LocalSessionManager::default()),
        StreamableHttpServerConfig::default(),
    );
    axum::Router::new().nest_service(ORG_PATH, service)
}
