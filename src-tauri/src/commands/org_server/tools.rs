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
use atlas_artifacts::{Comment, InboxEntry, InboxKind, RemoteEntry, RemoteSession};
use chrono::{DateTime, Duration, NaiveDate, NaiveDateTime, Utc};
use serde_json::{json, Value};

use super::audit::{unaudited, OrgActionRecord, OrgAudit};
use super::cloud::{
    BoardQuery, CommentRef, CurrentSessionQuery, InboxQuery, Member, NewReply, OrgConversation, OrganisationCloud,
    PayloadRef, TimelineQuery,
};
use super::resolve::{self, Resolution};
use super::{OrgAccessGate, OrgScope, ORG_PATH};
use crate::commands::memory_server::{Grant, TOOLS_LIST_TTL_MS};
use atlas_agent_servers::CallDescription;

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
        tool(
            "org_inbox",
            "Your inbox, newest first: mentions, replies and comments on your recorded sessions, with unread \
             state, the session and comment, and the unread total. Read-only.",
            json!({
                "type": "object",
                "properties": {
                    "unread_only": { "type": "boolean", "description": "Only entries not yet read." },
                    "cursor": { "type": "string", "description": "A previous answer's next_cursor, for more." },
                    "limit": { "type": "integer", "description": "At most this many entries (up to 100)." }
                }
            }),
        ),
        tool(
            "org_comments",
            "The comment threads on a recorded session (default: the current one): each root with its replies, \
             authors, anchor, body and resolved state.",
            json!({
                "type": "object",
                "properties": {
                    "session": { "type": "string", "description": "A recorded session id, or \"current\" (the default)." },
                    "unresolved_only": { "type": "boolean", "description": "Only threads not yet resolved." }
                }
            }),
        ),
        tool(
            "org_comment_resolve",
            "Resolve, or with `resolved: false` unresolve, a thread by its first comment's id.",
            json!({
                "type": "object",
                "properties": {
                    "comment": { "type": "string", "description": "The thread's first comment's id." },
                    "resolved": { "type": "boolean", "description": "false to unresolve; true by default." },
                    "session": { "type": "string", "description": "Its recorded session id, or \"current\" (the default)." }
                },
                "required": ["comment"]
            }),
        ),
        tool(
            "org_comment_reply",
            "Reply on a comment's thread as the user (asks the user first); answers the posted comment.",
            json!({
                "type": "object",
                "properties": {
                    "comment": { "type": "string", "description": "A comment's id; the reply goes under its thread's first comment." },
                    "body": { "type": "string", "description": "The reply's text." },
                    "mention": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "Members to mention, by id, name or email; `@Name` in the body becomes the mention, else it leads."
                    },
                    "session": { "type": "string", "description": "Its recorded session id, or \"current\" (the default)." }
                },
                "required": ["comment", "body"]
            }),
        ),
        tool(
            "org_sessions",
            "Recorded sessions in the Workspace, most recently active first, with author, agent, model, activity, \
             liveness and size; your last session is `author: \"me\"` with `limit: 1`. Searches the last 14 days \
             unless since/until say otherwise, scanning at most 500 sessions.",
            json!({
                "type": "object",
                "properties": {
                    "author": { "type": "string", "description": "A member's id, name or email, or \"me\"." },
                    "since": { "type": "string", "description": "Active at or after this ISO date or datetime (UTC)." },
                    "until": { "type": "string", "description": "Started at or before this ISO date or datetime (UTC)." },
                    "live": { "type": "boolean", "description": "Only sessions whose agent is (true) or is not (false) still writing." },
                    "q": { "type": "string", "description": "Keywords the server searches titles, messages, tools and checkpoints for." },
                    "limit": { "type": "integer", "description": "At most this many sessions (default 20, up to 100)." }
                }
            }),
        ),
        tool(
            "org_session",
            "One recorded session (default: the current one): its summary and a page of its entries in order, or \
             with `entry` that entry's full text.",
            json!({
                "type": "object",
                "properties": {
                    "session": { "type": "string", "description": "A recorded session id, or \"current\" (the default)." },
                    "cursor": { "type": "string", "description": "A previous answer's next_cursor, for more entries." },
                    "limit": { "type": "integer", "description": "At most this many entries (default 50, up to 500)." },
                    "entry": { "type": "string", "description": "An entry's id, to read its full text instead." },
                    "part": { "type": "string", "description": "With entry: body (default), arguments or result." }
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

/// An optional boolean argument, absent read as `false`.
fn bool_arg(request: &CallToolRequestParams, name: &str) -> bool {
    request.arguments.as_ref().and_then(|args| args.get(name)).and_then(Value::as_bool).unwrap_or(false)
}

/// An optional boolean argument, `default` when absent.
fn bool_arg_or(request: &CallToolRequestParams, name: &str, default: bool) -> bool {
    request.arguments.as_ref().and_then(|args| args.get(name)).and_then(Value::as_bool).unwrap_or(default)
}

/// An optional positive integer argument.
fn u32_arg(request: &CallToolRequestParams, name: &str) -> Option<u32> {
    let value = request.arguments.as_ref()?.get(name)?.as_u64()?;
    u32::try_from(value).ok().filter(|n| *n > 0)
}

/// An optional list of strings, blanks dropped; a lone string reads as a
/// list of one.
fn strings_arg(request: &CallToolRequestParams, name: &str) -> Vec<String> {
    let strings = |value: &Value| value.as_str().map(str::trim).filter(|s| !s.is_empty()).map(str::to_string);
    match request.arguments.as_ref().and_then(|args| args.get(name)) {
        Some(Value::Array(items)) => items.iter().filter_map(strings).collect(),
        Some(value) => strings(value).into_iter().collect(),
        None => Vec::new(),
    }
}

/// Why an inbox entry concerns the user, in the words the model relays.
fn inbox_kind(kind: InboxKind) -> &'static str {
    match kind {
        InboxKind::Mention => "mention",
        InboxKind::Reply => "reply",
        InboxKind::SessionComment => "comment_on_your_session",
    }
}

/// An inbox entry as the model reads it: why it is there, whether the user
/// has read it, who wrote it (a guest by the name on the entry, a member by
/// the roster when it could be read), and the recorded session and comment
/// it points at, so a follow-up call can name them.
fn inbox_entry_json(entry: &InboxEntry, roster: Option<&[Member]>) -> Value {
    let guest = entry.actor_name.is_some();
    let name = entry.actor_name.clone().or_else(|| {
        roster.and_then(|r| r.iter().find(|m| m.user_id == entry.actor_id)).map(|m| m.name.clone())
    });
    json!({
        "id": entry.id,
        "kind": inbox_kind(entry.kind),
        "unread": entry.is_unread(),
        "created_at": entry.created_at,
        "author": { "user_id": entry.actor_id, "name": name, "guest": guest },
        "session": { "id": entry.session_id, "title": entry.session_title, "workspace_id": entry.workspace_id },
        "comment": {
            "id": entry.comment_id,
            "anchor_kind": entry.anchor_kind,
            // The session anchor addresses the session itself and has no row.
            "anchor_id": Some(&entry.anchor_id).filter(|id| !id.is_empty()),
            "excerpt": entry.excerpt,
        },
        "link": entry.path,
    })
}

/// A member's name from the roster, when it could be read and holds them.
fn roster_name(roster: Option<&[Member]>, user_id: &str) -> Option<String> {
    roster.and_then(|r| r.iter().find(|m| m.user_id == user_id)).map(|m| m.name.clone())
}

/// A comment body as a person reads it: every `<@user-id>` mention the
/// server parses written as `@Name` from the roster. A mention the roster
/// cannot name — it failed, or they have left — keeps its `<@id>`, so the
/// model still holds the id.
pub(super) fn named_mentions(body: &str, roster: Option<&[Member]>) -> String {
    let mut out = String::with_capacity(body.len());
    let mut rest = body;
    while let Some(start) = rest.find("<@") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let named = after.find('>').and_then(|end| {
            let id = &after[..end];
            if id.is_empty() || id.contains(char::is_whitespace) || id.contains('<') {
                return None;
            }
            roster_name(roster, id).map(|name| (name, end))
        });
        match named {
            Some((name, end)) => {
                out.push('@');
                out.push_str(&name);
                rest = &after[end + 1..];
            }
            None => {
                out.push_str("<@");
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

/// One comment as the model reads it: who wrote it (a guest by the name on
/// the comment, never as a member; a member by the roster), where it is
/// anchored, its body with mentions named, and when. A deleted comment keeps
/// its place in the thread and says so, without a body.
fn comment_json(comment: &Comment, roster: Option<&[Member]>) -> Value {
    let guest = comment.guest_name.is_some();
    let name = comment.guest_name.clone().or_else(|| roster_name(roster, &comment.author_id));
    let mut out = json!({
        "id": comment.id,
        "author": { "user_id": comment.author_id, "name": name, "guest": guest },
        "anchor": {
            "kind": comment.anchor_kind.as_str(),
            // The session anchor addresses the session itself and has no row.
            "id": Some(&comment.anchor_id).filter(|id| !id.is_empty()),
        },
        "body": comment.body.as_deref().filter(|_| !comment.is_deleted()).map(|b| named_mentions(b, roster)),
        "created_at": comment.created_at,
        "edited_at": comment.edited_at,
    });
    if comment.is_deleted() {
        out["deleted"] = json!(true);
    }
    if comment.is_root() {
        out["resolved"] = match &comment.resolved_at {
            None => Value::Null,
            Some(at) => {
                let by = comment.resolved_by.as_deref();
                json!({
                    "at": at,
                    "by": { "user_id": by, "name": by.and_then(|id| roster_name(roster, id)) },
                })
            }
        };
    }
    out
}

/// A recorded session's comments as threads: each root, oldest first, with
/// its replies in the order they were written. A reply whose root is not in
/// the list stands as a thread of its own rather than vanishing.
fn threads(comments: &[Comment]) -> Vec<(&Comment, Vec<&Comment>)> {
    let is_root = |c: &Comment| match &c.parent_id {
        None => true,
        Some(parent) => !comments.iter().any(|p| &p.id == parent),
    };
    comments
        .iter()
        .filter(|c| is_root(c))
        .map(|root| {
            let replies = comments.iter().filter(|c| c.parent_id.as_deref() == Some(root.id.as_str())).collect();
            (root, replies)
        })
        .collect()
}

/// Whether a thread is still open: its first comment neither resolved nor
/// deleted — the same rule `org_whoami`'s unresolved count uses.
fn open_thread(root: &Comment) -> bool {
    root.resolved_at.is_none() && !root.is_deleted()
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
    audit: OrgAudit,
}

impl OrgTools {
    pub fn new(cloud: Arc<dyn OrganisationCloud>, gate: OrgAccessGate) -> Self {
        Self { cloud, gate, audit: unaudited() }
    }

    /// Hands every call's [`OrgActionRecord`] to `audit`.
    pub fn with_audit(mut self, audit: OrgAudit) -> Self {
        self.audit = audit;
        self
    }

    /// One call, answered and then audited: exactly one record whatever the
    /// answer, so a refusal and a failure are rows as much as a success is.
    /// The one place a call is recorded — a new tool is audited by being
    /// answered here.
    async fn dispatch(&self, grant: Grant, request: CallToolRequestParams) -> CallToolResult {
        let answer = self.answer(&grant, &request).await;
        (self.audit)(&OrgActionRecord::of(&grant, &request, &answer));
        answer
    }

    async fn answer(&self, grant: &Grant, request: &CallToolRequestParams) -> CallToolResult {
        if !(self.gate)() {
            return tool_error(OFF_NOTE);
        }
        let Some(scope) = grant.org.clone() else {
            return tool_error(NO_ORG_NOTE);
        };
        match request.name.as_ref() {
            "org_whoami" => self.whoami(grant, &scope).await,
            "org_members" => self.members(&scope, string_arg(request, "name")).await,
            "org_conversations" => self.conversations(&scope, string_arg(request, "name")).await,
            "org_inbox" => {
                let query = InboxQuery {
                    unread_only: bool_arg(request, "unread_only"),
                    cursor: string_arg(request, "cursor"),
                    limit: u32_arg(request, "limit"),
                };
                self.inbox(&scope, query).await
            }
            "org_comments" => {
                self.comments(grant, &scope, string_arg(request, "session"), bool_arg(request, "unresolved_only"))
                    .await
            }
            "org_comment_resolve" => {
                let Some(comment) = string_arg(request, "comment") else {
                    return tool_error("name the comment to resolve: `comment` is its id (see org_comments)");
                };
                let resolved = bool_arg_or(request, "resolved", true);
                self.resolve_comment(grant, &scope, string_arg(request, "session"), comment, resolved).await
            }
            "org_comment_reply" => {
                let Some(comment) = string_arg(request, "comment") else {
                    return tool_error("name the comment to reply to: `comment` is its id (see org_comments)");
                };
                let Some(body) = string_arg(request, "body") else {
                    return tool_error("say what to reply: `body` is the reply's text");
                };
                let mentions = strings_arg(request, "mention");
                self.reply_comment(grant, &scope, string_arg(request, "session"), comment, body, &mentions).await
            }
            "org_sessions" => {
                let filters = SessionFilters {
                    author: string_arg(request, "author"),
                    since: string_arg(request, "since"),
                    until: string_arg(request, "until"),
                    live: request.arguments.as_ref().and_then(|a| a.get("live")).and_then(Value::as_bool),
                    q: string_arg(request, "q"),
                    limit: u32_arg(request, "limit")
                        .map_or(SESSIONS_DEFAULT_LIMIT, |n| (n as usize).min(SESSIONS_MAX_LIMIT)),
                };
                self.sessions(&scope, filters).await
            }
            "org_session" => {
                let session = string_arg(request, "session");
                match string_arg(request, "entry") {
                    Some(entry) => {
                        let part = string_arg(request, "part").unwrap_or("body");
                        self.session_entry(grant, &scope, session, entry, part).await
                    }
                    None => {
                        let page = (string_arg(request, "cursor"), u32_arg(request, "limit"));
                        self.session(grant, &scope, session, page).await
                    }
                }
            }
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

impl OrgTools {
    /// `org_inbox`: one page of the caller's inbox in the grant's
    /// organisation, newest first, with the unread total. Read-only: there is
    /// no call path from here to the server's mark-read route, because the
    /// organisation cloud has none. The roster is read only to name member
    /// authors; when it cannot be, they keep their ids and the inbox still
    /// answers.
    async fn inbox(&self, scope: &OrgScope, query: InboxQuery<'_>) -> CallToolResult {
        let page = match self.cloud.inbox(&scope.org_id, query).await {
            Ok(page) => page,
            Err(e) => return tool_error(e.to_string()),
        };
        let mut entries = page.entries;
        // The server already answers newest first; sorting again keeps that
        // promise whatever order a page arrives in. ISO stamps sort as text.
        entries.sort_by(|a, b| (&b.created_at, &b.id).cmp(&(&a.created_at, &a.id)));
        let roster = if entries.iter().any(|e| e.actor_name.is_none()) {
            self.cloud.members(&scope.org_id).await.ok()
        } else {
            None
        };
        tool_json(json!({
            "unread": page.unread,
            "entries": entries.iter().map(|e| inbox_entry_json(e, roster.as_deref())).collect::<Vec<_>>(),
            "next_cursor": page.next_cursor,
        }))
    }
}

/// The sentinel the session and comment tools read as the current recorded
/// session.
const CURRENT: &str = "current";

/// A recorded session a session or comment tool acts on, in the grant's
/// Workspace.
struct SessionTarget {
    id: String,
    workspace_id: String,
    /// Its title, when it is the current one (the join reads it); an explicit
    /// id is not looked up, so it has none.
    title: Option<String>,
    current: bool,
}

impl OrgTools {
    /// The recorded session a tool names: the current one when it
    /// names none or says `"current"`, else the id it gives — any recorded
    /// session in the grant's Workspace, which the server confirms by
    /// answering (a 404 otherwise). Never another Workspace's.
    async fn session_target(
        &self,
        grant: &Grant,
        scope: &OrgScope,
        session: Option<&str>,
    ) -> Result<SessionTarget, CallToolResult> {
        let Some(workspace_id) = scope.workspace_id.clone() else {
            return Err(tool_error(
                "this session's project is bound to the organisation but its Workspace id is not recorded yet; \
                 ask the user to reopen the project's cloud settings and start a new chat",
            ));
        };
        match session.filter(|s| !s.eq_ignore_ascii_case(CURRENT)) {
            Some(id) => Ok(SessionTarget { id: id.to_string(), workspace_id, title: None, current: false }),
            None => {
                let query = CurrentSessionQuery { scope, native_session_id: &grant.session_id, cwd: &grant.cwd };
                match self.cloud.current_session(query).await {
                    Ok(Some(session)) => Ok(SessionTarget {
                        id: session.id,
                        workspace_id: session.workspace_id,
                        title: session.title,
                        current: true,
                    }),
                    Ok(None) => Err(tool_error(format!(
                        "the current chat is {NOT_RECORDED_YET} in the Workspace; name a recorded session id \
                         instead (org_sessions lists them)"
                    ))),
                    Err(e) => Err(tool_error(e.to_string())),
                }
            }
        }
    }

    /// `org_comments`: the threads on a recorded session, oldest first, each
    /// root with its replies, authors named from the roster and mentions
    /// written as names. The roster is read only to name people; when it
    /// cannot be, they keep their ids and the threads still answer.
    async fn comments(
        &self,
        grant: &Grant,
        scope: &OrgScope,
        session: Option<&str>,
        unresolved_only: bool,
    ) -> CallToolResult {
        let target = match self.session_target(grant, scope, session).await {
            Ok(target) => target,
            Err(answer) => return answer,
        };
        let comments = match self.cloud.comments(&scope.org_id, &target.workspace_id, &target.id).await {
            Ok(comments) => comments,
            Err(e) => return tool_error(e.to_string()),
        };
        let chosen: Vec<_> =
            threads(&comments).into_iter().filter(|(root, _)| !unresolved_only || open_thread(root)).collect();
        // Only guests, with no mentions and nothing resolved, name no member.
        let names_a_member = |c: &Comment| {
            c.guest_name.is_none() || c.resolved_by.is_some() || c.body.as_deref().is_some_and(|b| b.contains("<@"))
        };
        let needs_roster = chosen
            .iter()
            .any(|(root, replies)| names_a_member(root) || replies.iter().any(|r| names_a_member(r)));
        let roster = if needs_roster { self.cloud.members(&scope.org_id).await.ok() } else { None };
        let roster = roster.as_deref();
        let listed: Vec<Value> = chosen
            .iter()
            .map(|(root, replies)| {
                let mut thread = comment_json(root, roster);
                thread["replies"] = replies.iter().map(|r| comment_json(r, roster)).collect();
                thread
            })
            .collect();
        let open = threads(&comments).iter().filter(|(root, _)| open_thread(root)).count();
        tool_json(json!({
            "session": { "id": target.id, "title": target.title, "current": target.current },
            "unresolved": open,
            "threads": listed,
        }))
    }

    /// `org_comment_resolve`: resolves or unresolves a thread by its root.
    /// Auto-approved (ADR-0014): it reaches no one, is visible on the
    /// Timeline, reversible by the same call, and audited like every call.
    /// A reply is refused here, naming its root, rather than left to the
    /// server's refusal, because the model can act on the root's id at once.
    async fn resolve_comment(
        &self,
        grant: &Grant,
        scope: &OrgScope,
        session: Option<&str>,
        comment_id: &str,
        resolved: bool,
    ) -> CallToolResult {
        let target = match self.session_target(grant, scope, session).await {
            Ok(target) => target,
            Err(answer) => return answer,
        };
        let comments = match self.cloud.comments(&scope.org_id, &target.workspace_id, &target.id).await {
            Ok(comments) => comments,
            Err(e) => return tool_error(e.to_string()),
        };
        let Some(found) = comments.iter().find(|c| c.id == comment_id) else {
            return tool_error(format!(
                "no comment {comment_id} on recorded session {}; call org_comments for its threads",
                target.id
            ));
        };
        if let Some(root) = &found.parent_id {
            return tool_error(format!("only a thread's first comment can be resolved; its root is {root}"));
        }
        let at = CommentRef {
            org_id: &scope.org_id,
            workspace_id: &target.workspace_id,
            session_id: &target.id,
            comment_id,
        };
        let updated = match self.cloud.set_resolved(at, resolved).await {
            Ok(updated) => updated,
            Err(e) => return tool_error(e.to_string()),
        };
        let roster = self.cloud.members(&scope.org_id).await.ok();
        tool_json(json!({
            "session": { "id": target.id, "title": target.title, "current": target.current },
            "comment": comment_json(&updated, roster.as_deref()),
        }))
    }

    /// The thread a reply to `comment_id` goes on: the recorded session, its
    /// comments, and the thread's first comment — `comment_id` itself when it
    /// is a root, else its parent (the server keeps replies one level deep, so
    /// a reply to a reply belongs under the same root).
    async fn reply_thread(
        &self,
        grant: &Grant,
        scope: &OrgScope,
        session: Option<&str>,
        comment_id: &str,
    ) -> Result<(SessionTarget, Comment), CallToolResult> {
        let target = self.session_target(grant, scope, session).await?;
        let comments = self
            .cloud
            .comments(&scope.org_id, &target.workspace_id, &target.id)
            .await
            .map_err(|e| tool_error(e.to_string()))?;
        let Some(found) = comments.iter().find(|c| c.id == comment_id) else {
            return Err(tool_error(format!(
                "no comment {comment_id} on recorded session {}; call org_comments for its threads",
                target.id
            )));
        };
        let root = match &found.parent_id {
            None => found.clone(),
            Some(parent) => match comments.iter().find(|c| &c.id == parent) {
                Some(root) => root.clone(),
                None => {
                    return Err(tool_error(format!(
                        "comment {comment_id} answers {parent}, which is not on recorded session {}",
                        target.id
                    )))
                }
            },
        };
        Ok((target, root))
    }

    /// `org_comment_reply`: posts a reply on a comment's thread as the caller.
    /// An **outward action** (ADR-0014): the native seam projects it with a
    /// per-tool `prompt`, so by the time it runs the user has seen the
    /// recipient and this exact body on the approval card and allowed it; a
    /// rejected card never reaches here. Mentions are resolved against the
    /// roster before anything is posted — a name nobody or several members
    /// answer to is refused with nothing sent.
    async fn reply_comment(
        &self,
        grant: &Grant,
        scope: &OrgScope,
        session: Option<&str>,
        comment_id: &str,
        body: &str,
        mentions: &[String],
    ) -> CallToolResult {
        let (target, root) = match self.reply_thread(grant, scope, session, comment_id).await {
            Ok(found) => found,
            Err(answer) => return answer,
        };
        let roster = if mentions.is_empty() {
            None
        } else {
            match self.cloud.members(&scope.org_id).await {
                Ok(roster) => Some(roster),
                Err(e) => return tool_error(e.to_string()),
            }
        };
        let body = match with_mentions(body, mentions, roster.as_deref().unwrap_or_default()) {
            Ok(body) => body,
            Err(answer) => return answer,
        };
        let reply = NewReply {
            root: CommentRef {
                org_id: &scope.org_id,
                workspace_id: &target.workspace_id,
                session_id: &target.id,
                comment_id: &root.id,
            },
            anchor_kind: root.anchor_kind,
            anchor_id: &root.anchor_id,
            body: &body,
        };
        let posted = match self.cloud.reply(reply).await {
            Ok(posted) => posted,
            Err(e) => return tool_error(e.to_string()),
        };
        let roster = match roster {
            Some(roster) => Some(roster),
            None => self.cloud.members(&scope.org_id).await.ok(),
        };
        // The thread by its first comment and whose it is: the person the
        // server told, and the name the call's row reads by.
        let author = root.guest_name.clone().or_else(|| roster_name(roster.as_deref(), &root.author_id));
        tool_json(json!({
            "session": { "id": target.id, "title": target.title, "current": target.current },
            "thread": {
                "id": root.id,
                "author": { "user_id": root.author_id, "name": author, "guest": root.guest_name.is_some() },
            },
            "comment": comment_json(&posted, roster.as_deref()),
        }))
    }

    /// What the approval card says about a waiting outward call, for the
    /// offer to hand the native seam ([`SessionMcpServers::describe_call`]).
    /// Reads what the call will act on — never writes — so the card names the
    /// real recipient: the thread's first author and where the thread is, with
    /// the body exactly as it will be posted, mentions shown by name. When the
    /// organisation cannot be read the card still shows the comment id and the
    /// full body. `None` for a tool that does not ask.
    ///
    /// [`SessionMcpServers::describe_call`]: atlas_agent_servers::SessionMcpServers::describe_call
    pub async fn describe(&self, grant: &Grant, tool: &str, arguments: &Value) -> Option<CallDescription> {
        if tool != "org_comment_reply" {
            return None;
        }
        let arg = |name: &str| arguments.get(name).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty());
        let comment_id = arg("comment").unwrap_or_default();
        let body = arg("body").unwrap_or_default().to_string();
        let plain = CallDescription {
            title: format!("Reply to comment {comment_id}"),
            recipient: format!("The thread of comment {comment_id}"),
            body: body.clone(),
        };
        let Some(scope) = grant.org.clone() else {
            return Some(plain);
        };
        let Ok((target, root)) = self.reply_thread(grant, &scope, arg("session"), comment_id).await else {
            return Some(plain);
        };
        let roster = self.cloud.members(&scope.org_id).await.ok();
        let roster = roster.as_deref();
        let author = root
            .guest_name
            .clone()
            .or_else(|| roster_name(roster, &root.author_id))
            .unwrap_or_else(|| root.author_id.clone());
        let mentions = match arguments.get("mention") {
            Some(Value::Array(items)) => items.iter().filter_map(Value::as_str).map(str::to_string).collect(),
            Some(Value::String(one)) => vec![one.clone()],
            _ => Vec::new(),
        };
        // As it will be posted, then read back as a person reads it.
        let posted = with_mentions(&body, &mentions, roster.unwrap_or_default()).unwrap_or(body);
        let said = root
            .body
            .as_deref()
            .filter(|_| !root.is_deleted())
            .map(|b| format!(" \"{}\"", excerpt(&named_mentions(b, roster), 80)))
            .unwrap_or_default();
        let place = target.title.clone().unwrap_or_else(|| format!("recorded session {}", target.id));
        Some(CallDescription {
            title: format!("Reply on {author}'s comment"),
            recipient: format!("{author}, on their comment{said} in {place}"),
            body: named_mentions(&posted, roster),
        })
    }
}

/// `text` cut to at most `max` characters, with an ellipsis when it was.
fn excerpt(text: &str, max: usize) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= max {
        return flat;
    }
    let cut: String = flat.chars().take(max.saturating_sub(1)).collect();
    format!("{}…", cut.trim_end())
}

/// `body` with each member `mentions` names written as the server's
/// `<@user-id>`: every `@<what the model named>` and `@<member's name>` in the
/// body becomes the mention, and a member the body does not `@` leads it. A
/// name that matches nobody, or several members, is the answer instead —
/// before anything is posted.
pub(super) fn with_mentions(body: &str, mentions: &[String], roster: &[Member]) -> Result<String, CallToolResult> {
    let mut out = body.to_string();
    let mut leading = Vec::new();
    for named in mentions {
        let member = resolve_member(roster, named)?;
        let token = format!("<@{}>", member.user_id);
        let mut found = false;
        // Longest first, so "@Sam Lee" is not taken as "@Sam".
        let mut spellings = vec![named.trim_start_matches('@').to_string(), member.name.clone(), member.email.clone()];
        spellings.sort_by_key(|s| std::cmp::Reverse(s.len()));
        for spelling in spellings.iter().filter(|s| !s.is_empty()) {
            let at = format!("@{spelling}");
            if out.contains(&at) {
                out = out.replace(&at, &token);
                found = true;
            }
        }
        if !found && !out.contains(&token) {
            leading.push(token);
        }
    }
    if leading.is_empty() {
        Ok(out)
    } else {
        Ok(format!("{} {out}", leading.join(" ")))
    }
}

// ── The recorded work: org_sessions and org_session ─────────────────────────

/// How far back `org_sessions` looks when it is given neither `since` nor
/// `until`: "what happened lately" without walking the whole board.
pub(super) const SESSIONS_DEFAULT_WINDOW_DAYS: i64 = 14;

/// The most recorded sessions one `org_sessions` call reads off the board.
/// The server narrows only by Workspace and keyword, so every other fold
/// reads rows it may throw away; this bounds that walk (five of the server's
/// largest pages), and the answer says when it was reached.
pub(super) const SESSIONS_SCAN_CAP: usize = 500;

/// How many matches `org_sessions` lists when the model asks for no number.
pub(super) const SESSIONS_DEFAULT_LIMIT: usize = 20;

/// The most matches one `org_sessions` answer lists.
pub(super) const SESSIONS_MAX_LIMIT: usize = 100;

/// How many entries one `org_session` page holds when the model asks for no
/// number: enough to follow a turn or two, few enough to leave room to read.
pub(super) const TIMELINE_DEFAULT_LIMIT: u32 = 50;

/// The parts of an entry the server keeps full text for.
const PAYLOAD_PARTS: [&str; 3] = ["body", "arguments", "result"];

/// What `org_sessions` was asked.
pub(super) struct SessionFilters<'a> {
    /// A member's id, name or email, or `"me"`.
    author: Option<&'a str>,
    since: Option<&'a str>,
    until: Option<&'a str>,
    live: Option<bool>,
    /// The server's keyword search, passed through.
    q: Option<&'a str>,
    limit: usize,
}

/// A moment the model named: an RFC 3339 datetime, a datetime with no zone
/// (read as UTC), or a bare date — the start of that day as a lower bound,
/// its last millisecond as an upper one, so `until: "2026-09-22"` includes
/// all of the 22nd.
fn parse_moment(text: &str, end_of_day: bool) -> Option<DateTime<Utc>> {
    if let Ok(at) = DateTime::parse_from_rfc3339(text) {
        return Some(at.with_timezone(&Utc));
    }
    for format in ["%Y-%m-%dT%H:%M:%S%.f", "%Y-%m-%dT%H:%M", "%Y-%m-%d %H:%M:%S"] {
        if let Ok(at) = NaiveDateTime::parse_from_str(text, format) {
            return Some(at.and_utc());
        }
    }
    let day = NaiveDate::parse_from_str(text, "%Y-%m-%d").ok()?;
    let start = day.and_hms_opt(0, 0, 0)?.and_utc();
    Some(if end_of_day { start + Duration::days(1) - Duration::milliseconds(1) } else { start })
}

/// A server timestamp, or `None` when it is missing or unreadable — which a
/// date fold then lets through rather than drops, since the row is real.
fn stamp(text: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(text).ok().map(|at| at.with_timezone(&Utc))
}

fn iso(at: DateTime<Utc>) -> String {
    at.to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

/// A recorded session as `org_sessions` lists it.
fn recorded_session_json(session: &RemoteSession) -> Value {
    json!({
        "id": session.id,
        "title": session.title,
        "author": { "user_id": session.author_id, "name": session.author_name },
        "agent": session.agent,
        "model": session.model,
        "started_at": session.started_at,
        "last_activity_at": session.last_activity_at,
        "live": session.live,
        "counts": {
            "messages": session.message_count,
            "tool_calls": session.tool_call_count,
            "checkpoints": session.checkpoint_count,
        },
        "insertions": session.insertions,
        "deletions": session.deletions,
        "files_touched": session.files_touched,
        "total_tokens": session.total_tokens,
    })
}

/// One entry of a recorded session as the model reads it: what it is, when,
/// and only the fields that apply to its kind — the server omits the rest,
/// and so does this, because every empty field is a token the model pays for.
fn entry_json(entry: &RemoteEntry) -> Value {
    let mut out = json!({ "id": entry.id, "kind": entry.kind, "at": entry.at, "turn": entry.turn_seq });
    let mut put = |key: &str, value: Value| {
        out[key] = value;
    };
    let text = |v: &Option<String>| v.as_ref().filter(|s| !s.is_empty()).map(|s| json!(s));
    if let Some(v) = text(&entry.text) {
        put("text", v);
    }
    if entry.truncated {
        // The rest is behind `org_session` with `entry`.
        put("truncated", json!(true));
        put("body_bytes", json!(entry.body_bytes));
    }
    for (key, value) in [
        ("tool_name", &entry.tool_name),
        ("tool_title", &entry.tool_title),
        ("tool_status", &entry.tool_status),
        ("arguments", &entry.arguments),
        ("result", &entry.result),
        ("commit_sha", &entry.commit_sha),
        ("branch", &entry.branch),
        ("link_state", &entry.link_state),
    ] {
        if let Some(v) = text(value) {
            put(key, v);
        }
    }
    if entry.result_binary {
        put("result_binary", json!(true));
    }
    if !entry.paths.is_empty() {
        put("paths", json!(entry.paths));
    }
    if !entry.files.is_empty() {
        put("files", json!(entry.files));
    }
    if entry.insertions != 0 || entry.deletions != 0 {
        put("insertions", json!(entry.insertions));
        put("deletions", json!(entry.deletions));
    }
    out
}

/// What the answer says when the scan stopped at [`SESSIONS_SCAN_CAP`] with
/// more of the window still unread: how to narrow, and where to pick up.
fn scan_cap_note(oldest: Option<&str>) -> String {
    let resume = match oldest {
        Some(at) => format!(" or pass until={at} to continue further back"),
        None => String::new(),
    };
    format!(
        "Stopped after scanning the {SESSIONS_SCAN_CAP} most recently active recorded sessions, before the end of \
         the window, so older matches may be missing. Narrow with author, q or a shorter since/until window{resume}."
    )
}

impl OrgTools {
    /// `org_sessions`: the recorded sessions on the grant's Workspace's
    /// board, newest activity first, folded here by author, window and
    /// liveness — the server has no such filters — and narrowed there by the
    /// keyword search, which is passed through untouched.
    ///
    /// Reads board pages until the window is behind it (the board is ordered
    /// by last activity, so the first row older than `since` means every
    /// later one is too), the board ends, `limit` matches are found, or
    /// [`SESSIONS_SCAN_CAP`] rows have been read — the last reported as
    /// `truncated`, with a sentence saying how to narrow or go further back.
    ///
    /// A session is in the window when it overlaps it: active at or after
    /// `since`, and started at or before `until`. With neither given, `since`
    /// is [`SESSIONS_DEFAULT_WINDOW_DAYS`] ago, and the answer says so.
    ///
    /// `author: "me"` is the caller, so "my last session" is the first match
    /// with `limit: 1`: the newest by last activity among their own.
    async fn sessions(&self, scope: &OrgScope, filters: SessionFilters<'_>) -> CallToolResult {
        let Some(workspace_id) = scope.workspace_id.as_deref() else {
            return tool_error(
                "this session's project is bound to the organisation but its Workspace id is not recorded yet; \
                 ask the user to reopen the project's cloud settings and start a new chat",
            );
        };

        let mut since = match filters.since {
            None => None,
            Some(text) => match parse_moment(text, false) {
                Some(at) => Some(at),
                None => return tool_error(format!("since \"{text}\" is not an ISO date or datetime")),
            },
        };
        let until = match filters.until {
            None => None,
            Some(text) => match parse_moment(text, true) {
                Some(at) => Some(at),
                None => return tool_error(format!("until \"{text}\" is not an ISO date or datetime")),
            },
        };
        let default_window = since.is_none() && until.is_none();
        if default_window {
            since = Some(Utc::now() - Duration::days(SESSIONS_DEFAULT_WINDOW_DAYS));
        }

        // The author, as a user id: the caller for "me", else the roster's
        // one match (several come back as candidates to ask about).
        let author = match filters.author {
            None => None,
            Some(me) if me.eq_ignore_ascii_case("me") => match self.cloud.caller(&scope.org_id).await {
                Ok(caller) => Some((caller.user_id, caller.name)),
                Err(e) => return tool_error(e.to_string()),
            },
            Some(name) => {
                let roster = match self.cloud.members(&scope.org_id).await {
                    Ok(roster) => roster,
                    Err(e) => return tool_error(e.to_string()),
                };
                match resolve_member(&roster, name) {
                    Ok(member) => Some((member.user_id, member.name)),
                    Err(answer) => return answer,
                }
            }
        };

        let matches = |session: &RemoteSession| {
            author.as_ref().is_none_or(|(id, _)| session.author_id.as_deref() == Some(id.as_str()))
                && filters.live.is_none_or(|live| session.live == live)
                && until.is_none_or(|until| stamp(&session.started_at).is_none_or(|started| started <= until))
        };

        let mut found: Vec<Value> = Vec::new();
        let mut notes: Vec<String> = Vec::new();
        let mut scanned = 0usize;
        let mut oldest: Option<String> = None;
        let mut truncated = false;
        let mut limit_reached = false;
        let mut cursor: Option<String> = None;
        'pages: loop {
            let query = BoardQuery { workspace_id, q: filters.q, cursor: cursor.as_deref() };
            let page = match self.cloud.board_page(&scope.org_id, query).await {
                Ok(page) => page,
                Err(e) => return tool_error(e.to_string()),
            };
            for note in page.notes {
                if !notes.contains(&note) {
                    notes.push(note);
                }
            }
            let rows = page.sessions.len();
            for (i, session) in page.sessions.into_iter().enumerate() {
                if scanned == SESSIONS_SCAN_CAP {
                    truncated = i < rows || page.next_cursor.is_some();
                    break 'pages;
                }
                let last_active = stamp(&session.last_activity_at);
                if let (Some(since), Some(at)) = (since, last_active) {
                    if at < since {
                        // Every later row is older still: the window is behind us.
                        break 'pages;
                    }
                }
                scanned += 1;
                oldest = Some(session.last_activity_at.clone()).filter(|s| !s.is_empty()).or(oldest);
                if matches(&session) {
                    found.push(recorded_session_json(&session));
                    if found.len() == filters.limit {
                        limit_reached = i + 1 < rows || page.next_cursor.is_some();
                        break 'pages;
                    }
                }
            }
            match page.next_cursor {
                // An empty page that still names a next one would walk forever.
                Some(_) if rows == 0 => break,
                Some(next) if scanned < SESSIONS_SCAN_CAP => cursor = Some(next),
                Some(_) => {
                    truncated = true;
                    break;
                }
                None => break,
            }
        }

        if default_window {
            notes.push(format!(
                "No since or until was given, so only the last {SESSIONS_DEFAULT_WINDOW_DAYS} days were searched; \
                 pass since (an ISO date) to look further back."
            ));
        }
        if truncated {
            notes.push(scan_cap_note(oldest.as_deref()));
        }
        if limit_reached {
            notes.push(format!(
                "Only the {} most recently active matches are listed; raise limit (up to {SESSIONS_MAX_LIMIT}) or \
                 narrow the search for more.",
                filters.limit
            ));
        }

        let mut answer = json!({
            "workspace": { "id": workspace_id },
            "window": {
                "since": since.map(iso),
                "until": until.map(iso),
                "default": default_window,
            },
            "sessions": found,
            "scanned": scanned,
            "truncated": truncated,
            "limit_reached": limit_reached,
            "notes": notes,
        });
        if let Some((id, name)) = author {
            answer["author"] = json!({ "user_id": id, "name": name });
        }
        tool_json(answer)
    }

    /// `org_session`: one recorded session's summary and one page of its
    /// entries, in the order the server keeps them (turn, rank, time, id),
    /// with the cursor to the next page. Defaults to the current session.
    async fn session(
        &self,
        grant: &Grant,
        scope: &OrgScope,
        session: Option<&str>,
        (cursor, limit): (Option<&str>, Option<u32>),
    ) -> CallToolResult {
        let target = match self.session_target(grant, scope, session).await {
            Ok(target) => target,
            Err(answer) => return answer,
        };
        let query = TimelineQuery {
            org_id: &scope.org_id,
            workspace_id: &target.workspace_id,
            session_id: &target.id,
            cursor,
            limit: Some(limit.unwrap_or(TIMELINE_DEFAULT_LIMIT)),
        };
        let page = match self.cloud.timeline(query).await {
            Ok(page) => page,
            Err(e) => return tool_error(e.to_string()),
        };
        let mut summary = recorded_session_json(&page.summary);
        summary["id"] = json!(target.id);
        if page.summary.title.as_deref().is_none_or(str::is_empty) {
            summary["title"] = json!(target.title);
        }
        summary["current"] = json!(target.current);
        summary["counts"] = json!({
            "prompts": page.counts.prompts,
            "responses": page.counts.responses,
            "thinking": page.counts.thinking,
            "tool_calls": page.counts.tool_calls,
            "checkpoints": page.counts.checkpoints,
        });
        tool_json(json!({
            "session": summary,
            "tools": page.tools.iter().map(|t| json!({ "name": t.tool_name, "count": t.count })).collect::<Vec<_>>(),
            "entries": page.entries.iter().map(entry_json).collect::<Vec<_>>(),
            "next_cursor": page.next_cursor,
            "notes": page.notes,
        }))
    }

    /// `org_session` with `entry`: the full text of one entry — its body, or
    /// a tool call's arguments or result — which a page shows cut short.
    async fn session_entry(
        &self,
        grant: &Grant,
        scope: &OrgScope,
        session: Option<&str>,
        row_id: &str,
        part: &str,
    ) -> CallToolResult {
        let Some(part) = PAYLOAD_PARTS.iter().copied().find(|p| p.eq_ignore_ascii_case(part)) else {
            return tool_error(format!("part \"{part}\" is not one of body, arguments or result"));
        };
        let target = match self.session_target(grant, scope, session).await {
            Ok(target) => target,
            Err(answer) => return answer,
        };
        let at = PayloadRef {
            org_id: &scope.org_id,
            workspace_id: &target.workspace_id,
            session_id: &target.id,
            row_id,
            part,
        };
        let payload = match self.cloud.entry_payload(at).await {
            Ok(payload) => payload,
            Err(e) => return tool_error(e.to_string()),
        };
        tool_json(json!({
            "session": { "id": target.id, "title": target.title, "current": target.current },
            "entry": {
                "id": row_id,
                "part": part,
                "text": payload.text,
                "binary": payload.binary,
                "bytes": payload.bytes,
            },
        }))
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
