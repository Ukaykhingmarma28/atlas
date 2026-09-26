//! The organisation tool server end to end over loopback with an rmcp client,
//! beside the memory and UI tool servers on their listener, against an
//! in-memory organisation; and the offer that hands it out.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicUsize, Ordering};
use std::sync::Arc;

use agent_client_protocol::schema::v1 as acp;
use atlas_agent_servers::{SessionMcpOffer, SessionMcpRequest, SessionMcpServers};
use atlas_artifacts::{AnchorKind, Comment};
use atlas_comms::wire::ConversationKind;
use parking_lot::Mutex;
use rmcp::model::CallToolRequestParams;
use rmcp::service::RunningService;
use rmcp::transport::streamable_http_client::StreamableHttpClientTransportConfig;
use rmcp::transport::StreamableHttpClientTransport;
use rmcp::{RoleClient, ServiceExt};
use serde_json::{json, Value};

use super::adapter::scope_of;
use super::tools::{tool_names, tools_list, INSTRUCTIONS, NOT_RECORDED_YET};
use super::*;
use crate::auth::Role;
use crate::commands::memory_server::{
    MemoryServer, MemoryServerHost, MemorySessionOffers, MemoryTokens, SessionClocks, SessionReads, SharingGate, Sources,
    TOOLS_LIST_TTL_MS,
};
use crate::commands::shared_memory::SharedMemoryStore;
use crate::commands::ui_server::{self, UiBridge, UiOffer, UI_SERVER_NAME};

// ── An organisation in memory ────────────────────────────────────────────────

/// The organisation cloud the tests run against: one caller, the roster, the
/// chat conversations and the organisation chat is connected to, the recorded
/// sessions the Workspace holds keyed by the chat's session id, and each
/// recorded session's comments. Records every organisation it was asked
/// about, so a test can show a call acted in the grant's.
#[derive(Default)]
struct FakeOrganisation {
    caller: Mutex<Option<Caller>>,
    roster: Mutex<Vec<Member>>,
    roster_fail: AtomicBool,
    conversations: Mutex<Vec<OrgConversation>>,
    /// The organisation chat's socket is on; `None` while chat is not
    /// connected.
    chat_org: Mutex<Option<String>>,
    /// Chat session id → the recorded session it is written into.
    recorded: Mutex<HashMap<String, RecordedSession>>,
    /// Recorded session id → its comments.
    comments: Mutex<HashMap<String, Vec<Comment>>>,
    comments_fail: AtomicBool,
    /// Every `(org, what)` asked, in order.
    asked: Mutex<Vec<(String, String)>>,
}

impl FakeOrganisation {
    fn with_member(name: &str, role: Option<Role>) -> Arc<Self> {
        let org = Arc::new(Self::default());
        *org.caller.lock() = Some(Caller {
            user_id: "u-1".into(),
            name: name.into(),
            role,
            organisation_name: Some("Acme".into()),
        });
        *org.chat_org.lock() = Some("org-acme".into());
        org
    }

    fn with_roster(self: Arc<Self>, roster: Vec<Member>) -> Arc<Self> {
        *self.roster.lock() = roster;
        self
    }

    fn with_conversations(self: Arc<Self>, conversations: Vec<OrgConversation>) -> Arc<Self> {
        *self.conversations.lock() = conversations;
        self
    }

    fn record(&self, chat_session: &str, session: RecordedSession) {
        self.recorded.lock().insert(chat_session.into(), session);
    }

    fn comment_on(&self, session: &str, comment: Comment) {
        self.comments.lock().entry(session.into()).or_default().push(comment);
    }

    fn asked(&self) -> Vec<(String, String)> {
        self.asked.lock().clone()
    }
}

impl OrganisationCloud for FakeOrganisation {
    fn caller<'a>(&'a self, org_id: &'a str) -> CloudFuture<'a, Caller> {
        Box::pin(async move {
            self.asked.lock().push((org_id.into(), "caller".into()));
            self.caller.lock().clone().ok_or_else(|| CloudError::SignedOut("no account is signed in".into()))
        })
    }

    fn current_session<'a>(&'a self, query: CurrentSessionQuery<'a>) -> CloudFuture<'a, Option<RecordedSession>> {
        Box::pin(async move {
            self.asked.lock().push((
                query.scope.org_id.clone(),
                format!("current {} in {}", query.native_session_id, query.cwd),
            ));
            Ok(self
                .recorded
                .lock()
                .get(query.native_session_id)
                .filter(|s| query.scope.workspace_id.as_deref() == Some(s.workspace_id.as_str()))
                .cloned())
        })
    }

    fn members<'a>(&'a self, org_id: &'a str) -> CloudFuture<'a, Vec<Member>> {
        Box::pin(async move {
            self.asked.lock().push((org_id.into(), "members".into()));
            if self.roster_fail.load(Ordering::SeqCst) {
                return Err(CloudError::Unavailable("connection reset".into()));
            }
            Ok(self.roster.lock().clone())
        })
    }

    fn conversations<'a>(&'a self, org_id: &'a str) -> CloudFuture<'a, Vec<OrgConversation>> {
        Box::pin(async move {
            self.asked.lock().push((org_id.into(), "conversations".into()));
            let chat_org = self.chat_org.lock().clone();
            if chat_org.as_deref() != Some(org_id) {
                return Err(CloudError::ChatElsewhere { grant_org: org_id.into(), chat_org });
            }
            Ok(self.conversations.lock().clone())
        })
    }

    fn comments<'a>(&'a self, org_id: &'a str, workspace_id: &'a str, session_id: &'a str) -> CloudFuture<'a, Vec<Comment>> {
        Box::pin(async move {
            self.asked.lock().push((org_id.into(), format!("comments {workspace_id}/{session_id}")));
            if self.comments_fail.load(Ordering::SeqCst) {
                return Err(CloudError::Unavailable("connection reset".into()));
            }
            Ok(self.comments.lock().get(session_id).cloned().unwrap_or_default())
        })
    }
}

fn comment(id: &str, parent: Option<&str>) -> Comment {
    Comment {
        id: id.into(),
        session_id: "rs-1".into(),
        anchor_kind: AnchorKind::Session,
        anchor_id: String::new(),
        parent_id: parent.map(Into::into),
        author_id: "u-2".into(),
        guest_name: None,
        body: Some("please rename this".into()),
        mentions: Vec::new(),
        created_at: "2026-09-26T10:00:00Z".into(),
        edited_at: None,
        deleted_at: None,
        resolved_at: None,
        resolved_by: None,
    }
}

fn member(user_id: &str, name: &str, email: &str, role: Option<Role>) -> Member {
    Member { user_id: user_id.into(), name: name.into(), email: email.into(), role }
}

/// Ada, two members both called Sam Lee, and Grace.
fn acme_roster() -> Vec<Member> {
    vec![
        member("u-1", "Ada Lovelace", "ada@acme.dev", Some(Role::Developer)),
        member("u-sam1", "Sam Lee", "sam.lee@acme.dev", Some(Role::Admin)),
        member("u-sam2", "Sam Lee", "slee@acme.dev", Some(Role::ProductOwner)),
        member("u-grace", "Grace Hopper", "grace@acme.dev", None),
    ]
}

fn conversation(id: &str, kind: ConversationKind, name: Option<&str>, members: Option<&[&str]>, joined: bool) -> OrgConversation {
    OrgConversation {
        id: id.into(),
        kind,
        name: name.map(Into::into),
        member_ids: members.map(|ids| ids.iter().map(|s| s.to_string()).collect()),
        caller_is_member: joined,
    }
}

/// #general (joined), a DM with Grace, a group DM, #Design and #design (the
/// second not joined).
fn acme_conversations() -> Vec<OrgConversation> {
    use ConversationKind::*;
    vec![
        conversation("c-general", Channel, Some("general"), None, true),
        conversation("c-dm-grace", Dm, None, Some(&["u-1", "u-grace"]), true),
        conversation("c-group", GroupDm, None, Some(&["u-1", "u-sam1", "u-ghost"]), true),
        conversation("c-design", Channel, Some("Design"), None, true),
        conversation("c-design-web", Channel, Some("design"), None, false),
    ]
}

fn acme() -> OrgScope {
    OrgScope { org_id: "org-acme".into(), workspace_id: Some("ws-atlas".into()) }
}

fn current(live: bool) -> RecordedSession {
    RecordedSession {
        id: "rs-1".into(),
        workspace_id: "ws-atlas".into(),
        title: Some("Fix the theme importer".into()),
        live,
    }
}

// ── Serving it ───────────────────────────────────────────────────────────────

fn memory() -> SharedMemoryStore {
    let t = Arc::new(AtomicI64::new(1_000));
    SharedMemoryStore::with_clock(Arc::new(move || t.fetch_add(1_000, Ordering::SeqCst)))
}

fn sharing(on: bool) -> SharingGate {
    Arc::new(move |_| on)
}

fn setting(on: bool) -> OrgAccessGate {
    Arc::new(move || on)
}

/// A setting the test can flip while a session runs.
fn switchable(on: bool) -> (OrgAccessGate, Arc<AtomicBool>) {
    let flag = Arc::new(AtomicBool::new(on));
    let read = flag.clone();
    (Arc::new(move || read.load(Ordering::SeqCst)), flag)
}

/// A window that is never asked anything in these tests.
fn quiet_ui() -> axum::Router {
    let bridge = Arc::new(UiBridge::new(Arc::new(|_| Err("no window".into()))));
    ui_server::router(ui_server::UiTools::new(bridge, Arc::new(|| true)))
}

async fn serve(tokens: Arc<MemoryTokens>, cloud: Arc<dyn OrganisationCloud>, gate: OrgAccessGate) -> MemoryServer {
    MemoryServer::start_with(
        memory(),
        tokens,
        Arc::new(SessionClocks::default()),
        Arc::new(SessionReads::default()),
        sharing(true),
        Sources::default(),
        vec![quiet_ui(), router(OrgTools::new(cloud, gate))],
    )
    .await
    .unwrap()
}

/// A token as an offer mints one: carrying the organisation, bound to the
/// chat's session id once the agent answers.
fn offered_token(tokens: &MemoryTokens, session: &str, cwd: &str, scope: Option<OrgScope>) -> String {
    let token = tokens.mint_unbound("atlas-agent", cwd, scope);
    tokens.bind(&token, session);
    token
}

async fn connect(url: &str, token: &str) -> Result<RunningService<RoleClient, ()>, String> {
    let transport = StreamableHttpClientTransport::from_config(
        StreamableHttpClientTransportConfig::with_uri(url.to_string()).auth_header(token.to_string()),
    );
    ().serve(transport).await.map_err(|e| format!("{e:?}"))
}

async fn call(client: &RunningService<RoleClient, ()>, name: &'static str, args: Value) -> (bool, String) {
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
    (result.is_error.unwrap_or(false), text)
}

/// A tool call's JSON answer, and whether it was an error.
async fn call_json(client: &RunningService<RoleClient, ()>, name: &'static str, args: Value) -> (bool, Value) {
    let (err, text) = call(client, name, args).await;
    let value = serde_json::from_str(&text).unwrap_or(Value::String(text));
    (err, value)
}

async fn whoami(client: &RunningService<RoleClient, ()>) -> Value {
    let (err, text) = call(client, "org_whoami", json!({})).await;
    assert!(!err, "{text}");
    serde_json::from_str(&text).expect("org_whoami answers JSON")
}

// ── org_whoami ───────────────────────────────────────────────────────────────

#[tokio::test(flavor = "multi_thread")]
async fn org_whoami_reads_the_caller_the_organisation_the_workspace_and_the_current_session() {
    let org = FakeOrganisation::with_member("Ada Lovelace", Some(Role::Developer));
    org.record("s1", current(true));
    org.comment_on("rs-1", comment("c1", None));
    org.comment_on("rs-1", comment("c2", None));
    let tokens = Arc::new(MemoryTokens::default());
    let server = serve(tokens.clone(), org.clone(), setting(true)).await;
    let token = offered_token(&tokens, "s1", "/p", Some(acme()));
    let client = connect(&server.url_at(ORG_PATH), &token).await.expect("a live token connects");

    assert_eq!(
        whoami(&client).await,
        json!({
            "caller": { "user_id": "u-1", "name": "Ada Lovelace", "role": "developer" },
            "organisation": { "id": "org-acme", "name": "Acme" },
            "workspace": { "id": "ws-atlas" },
            "current_session": {
                "id": "rs-1",
                "title": "Fix the theme importer",
                "live": true,
                "unresolved_comments": 2
            }
        }),
    );
    assert_eq!(
        org.asked(),
        [
            ("org-acme".to_string(), "caller".to_string()),
            ("org-acme".to_string(), "current s1 in /p".to_string()),
            ("org-acme".to_string(), "comments ws-atlas/rs-1".to_string()),
        ],
        "every call acts in the grant's organisation, for this chat's session and launch directory",
    );
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_chat_the_workspace_has_not_recorded_yet_has_no_current_session_and_says_why() {
    let org = FakeOrganisation::with_member("Ada Lovelace", Some(Role::Admin));
    let tokens = Arc::new(MemoryTokens::default());
    let server = serve(tokens.clone(), org.clone(), setting(true)).await;
    let client = connect(&server.url_at(ORG_PATH), &offered_token(&tokens, "s1", "/p", Some(acme())))
        .await
        .unwrap();

    let answer = whoami(&client).await;
    assert_eq!(answer["current_session"], Value::Null);
    assert_eq!(answer["current_session_reason"], json!(NOT_RECORDED_YET));
    assert_eq!(answer["caller"]["role"], json!("admin"));
    assert!(
        !org.asked().iter().any(|(_, what)| what.starts_with("comments")),
        "no comment read for a session that is not there",
    );
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn the_unresolved_count_is_open_roots_only() {
    let org = FakeOrganisation::with_member("Ada Lovelace", None);
    org.record("s1", current(false));
    org.comment_on("rs-1", comment("open", None));
    org.comment_on("rs-1", comment("reply", Some("open")));
    let mut resolved = comment("resolved", None);
    resolved.resolved_at = Some("2026-09-26T11:00:00Z".into());
    org.comment_on("rs-1", resolved);
    let mut deleted = comment("deleted", None);
    deleted.deleted_at = Some("2026-09-26T11:00:00Z".into());
    org.comment_on("rs-1", deleted);
    let tokens = Arc::new(MemoryTokens::default());
    let server = serve(tokens.clone(), org, setting(true)).await;
    let client = connect(&server.url_at(ORG_PATH), &offered_token(&tokens, "s1", "/p", Some(acme())))
        .await
        .unwrap();

    let answer = whoami(&client).await;
    assert_eq!(answer["current_session"]["unresolved_comments"], json!(1));
    assert_eq!(answer["current_session"]["live"], json!(false));
    assert_eq!(answer["caller"]["role"], Value::Null, "a role the token does not state is unknown, not guessed");
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_failed_comment_read_leaves_the_count_unknown_but_still_answers() {
    let org = FakeOrganisation::with_member("Ada Lovelace", Some(Role::Member));
    org.record("s1", current(true));
    org.comments_fail.store(true, Ordering::SeqCst);
    let tokens = Arc::new(MemoryTokens::default());
    let server = serve(tokens.clone(), org, setting(true)).await;
    let client = connect(&server.url_at(ORG_PATH), &offered_token(&tokens, "s1", "/p", Some(acme())))
        .await
        .unwrap();

    let answer = whoami(&client).await;
    assert_eq!(answer["current_session"]["id"], json!("rs-1"));
    assert_eq!(answer["current_session"]["unresolved_comments"], Value::Null);
    assert!(answer["current_session"]["comments_error"].as_str().unwrap().contains("connection reset"));
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_signed_out_user_is_a_tool_error_the_model_can_read() {
    let org = Arc::new(FakeOrganisation::default());
    let tokens = Arc::new(MemoryTokens::default());
    let server = serve(tokens.clone(), org, setting(true)).await;
    let client = connect(&server.url_at(ORG_PATH), &offered_token(&tokens, "s1", "/p", Some(acme())))
        .await
        .unwrap();
    let (err, text) = call(&client, "org_whoami", json!({})).await;
    assert!(err);
    assert!(text.contains("sign in"), "{text}");
    client.cancel().await.ok();
}

// ── org_members ──────────────────────────────────────────────────────────────

/// A connected client on an offered token, against `org`.
async fn org_client(org: Arc<FakeOrganisation>) -> (MemoryServer, RunningService<RoleClient, ()>) {
    let tokens = Arc::new(MemoryTokens::default());
    let server = serve(tokens.clone(), org, setting(true)).await;
    let client = connect(&server.url_at(ORG_PATH), &offered_token(&tokens, "s1", "/p", Some(acme())))
        .await
        .unwrap();
    (server, client)
}

#[tokio::test(flavor = "multi_thread")]
async fn org_members_lists_the_roster_with_ids_names_emails_and_roles() {
    let org = FakeOrganisation::with_member("Ada Lovelace", Some(Role::Developer)).with_roster(acme_roster());
    let (_server, client) = org_client(org.clone()).await;
    let (err, answer) = call_json(&client, "org_members", json!({})).await;
    assert!(!err, "{answer}");
    assert_eq!(
        answer,
        json!({ "members": [
            { "user_id": "u-1", "name": "Ada Lovelace", "email": "ada@acme.dev", "role": "developer" },
            { "user_id": "u-sam1", "name": "Sam Lee", "email": "sam.lee@acme.dev", "role": "admin" },
            { "user_id": "u-sam2", "name": "Sam Lee", "email": "slee@acme.dev", "role": "product_owner" },
            { "user_id": "u-grace", "name": "Grace Hopper", "email": "grace@acme.dev", "role": null },
        ]}),
    );
    assert_eq!(org.asked(), [("org-acme".to_string(), "members".to_string())], "the grant's organisation's roster");
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_member_named_exactly_resolves_to_that_one_member() {
    let org = FakeOrganisation::with_member("Ada Lovelace", None).with_roster(acme_roster());
    let (_server, client) = org_client(org).await;
    let (err, answer) = call_json(&client, "org_members", json!({ "name": "Grace Hopper" })).await;
    assert!(!err, "{answer}");
    assert_eq!(
        answer,
        json!({ "member": { "user_id": "u-grace", "name": "Grace Hopper", "email": "grace@acme.dev", "role": null } }),
    );
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_member_named_in_another_case_or_by_email_resolves_to_the_one_member() {
    let org = FakeOrganisation::with_member("Ada Lovelace", None).with_roster(acme_roster());
    let (_server, client) = org_client(org).await;
    for name in ["@grace hopper", "SLEE@acme.dev", "u-sam1"] {
        let (err, answer) = call_json(&client, "org_members", json!({ "name": name })).await;
        assert!(!err, "{name}: {answer}");
        let expected = match name {
            "@grace hopper" => "u-grace",
            "SLEE@acme.dev" => "u-sam2",
            _ => "u-sam1",
        };
        assert_eq!(answer["member"]["user_id"], json!(expected), "{name}");
    }
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_member_name_matching_nobody_is_an_error_naming_what_was_looked_for() {
    let org = FakeOrganisation::with_member("Ada Lovelace", None).with_roster(acme_roster());
    let (_server, client) = org_client(org).await;
    let (err, answer) = call_json(&client, "org_members", json!({ "name": "Ada" })).await;
    assert!(err, "a first name is not a match");
    let text = answer.as_str().unwrap();
    assert!(text.contains("no member matches \"Ada\""), "{text}");
    assert!(text.contains("org_members"), "{text}");
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_member_name_matching_several_returns_every_candidate_with_its_id_to_ask_about() {
    let org = FakeOrganisation::with_member("Ada Lovelace", None).with_roster(acme_roster());
    let (_server, client) = org_client(org).await;
    let (err, answer) = call_json(&client, "org_members", json!({ "name": "sam lee" })).await;
    assert!(err, "several matches are not an answer");
    assert_eq!(
        answer,
        json!({
            "error": "\"sam lee\" matches 2 members; ask the user which one",
            "candidates": [
                { "user_id": "u-sam1", "name": "Sam Lee", "email": "sam.lee@acme.dev", "role": "admin" },
                { "user_id": "u-sam2", "name": "Sam Lee", "email": "slee@acme.dev", "role": "product_owner" },
            ],
        }),
    );
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_roster_that_cannot_be_read_is_a_tool_error() {
    let org = FakeOrganisation::with_member("Ada Lovelace", None).with_roster(acme_roster());
    org.roster_fail.store(true, Ordering::SeqCst);
    let (_server, client) = org_client(org).await;
    let (err, text) = call(&client, "org_members", json!({})).await;
    assert!(err);
    assert!(text.contains("connection reset"), "{text}");
    client.cancel().await.ok();
}

// ── org_conversations ────────────────────────────────────────────────────────

#[tokio::test(flavor = "multi_thread")]
async fn org_conversations_lists_channels_dms_and_group_dms_with_kinds_and_membership() {
    let org = FakeOrganisation::with_member("Ada Lovelace", None)
        .with_roster(acme_roster())
        .with_conversations(acme_conversations());
    let (_server, client) = org_client(org.clone()).await;
    let (err, answer) = call_json(&client, "org_conversations", json!({})).await;
    assert!(!err, "{answer}");
    assert_eq!(
        answer,
        json!({ "conversations": [
            { "id": "c-general", "kind": "channel", "name": "general", "caller_is_member": true },
            { "id": "c-dm-grace", "kind": "dm", "name": null, "caller_is_member": true, "members": [
                { "user_id": "u-1", "name": "Ada Lovelace" },
                { "user_id": "u-grace", "name": "Grace Hopper" },
            ]},
            { "id": "c-group", "kind": "group_dm", "name": null, "caller_is_member": true, "members": [
                { "user_id": "u-1", "name": "Ada Lovelace" },
                { "user_id": "u-sam1", "name": "Sam Lee" },
                { "user_id": "u-ghost", "name": null },
            ]},
            { "id": "c-design", "kind": "channel", "name": "Design", "caller_is_member": true },
            { "id": "c-design-web", "kind": "channel", "name": "design", "caller_is_member": false },
        ]}),
    );
    assert_eq!(
        org.asked(),
        [
            ("org-acme".to_string(), "conversations".to_string()),
            ("org-acme".to_string(), "members".to_string()),
        ],
    );
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_dm_keeps_its_member_ids_when_the_roster_cannot_be_read() {
    let org = FakeOrganisation::with_member("Ada Lovelace", None).with_conversations(acme_conversations());
    org.roster_fail.store(true, Ordering::SeqCst);
    let (_server, client) = org_client(org).await;
    let (err, answer) = call_json(&client, "org_conversations", json!({})).await;
    assert!(!err, "{answer}");
    assert_eq!(
        answer["conversations"][1]["members"],
        json!([{ "user_id": "u-1", "name": null }, { "user_id": "u-grace", "name": null }]),
    );
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_channel_named_with_its_hash_or_in_another_case_resolves_to_the_one_conversation() {
    let org = FakeOrganisation::with_member("Ada Lovelace", None)
        .with_roster(acme_roster())
        .with_conversations(acme_conversations());
    let (_server, client) = org_client(org.clone()).await;
    for (name, id) in [("#general", "c-general"), ("GENERAL", "c-general"), ("design", "c-design-web"), ("c-dm-grace", "c-dm-grace")] {
        let (err, answer) = call_json(&client, "org_conversations", json!({ "name": name })).await;
        assert!(!err, "{name}: {answer}");
        assert_eq!(answer["conversation"]["id"], json!(id), "{name}");
    }
    let (_, answer) = call_json(&client, "org_conversations", json!({ "name": "#general" })).await;
    assert_eq!(
        answer,
        json!({ "conversation": { "id": "c-general", "kind": "channel", "name": "general", "caller_is_member": true } }),
    );
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_conversation_name_matching_nothing_is_an_error() {
    let org = FakeOrganisation::with_member("Ada Lovelace", None).with_conversations(acme_conversations());
    let (_server, client) = org_client(org).await;
    let (err, answer) = call_json(&client, "org_conversations", json!({ "name": "#random" })).await;
    assert!(err);
    let text = answer.as_str().unwrap();
    assert!(text.contains("no conversation matches \"#random\""), "{text}");
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_conversation_name_matching_several_returns_every_candidate_with_its_id_to_ask_about() {
    let org = FakeOrganisation::with_member("Ada Lovelace", None).with_conversations(acme_conversations());
    let (_server, client) = org_client(org).await;
    let (err, answer) = call_json(&client, "org_conversations", json!({ "name": "#DESIGN" })).await;
    assert!(err);
    assert_eq!(
        answer,
        json!({
            "error": "\"#DESIGN\" matches 2 conversations; ask the user which one",
            "candidates": [
                { "id": "c-design", "kind": "channel", "name": "Design", "caller_is_member": true },
                { "id": "c-design-web", "kind": "channel", "name": "design", "caller_is_member": false },
            ],
        }),
    );
    client.cancel().await.ok();
}

/// Chat has one socket, on the organisation the window chose for it. A
/// session bound to another organisation does not read that one's chat as
/// if it were its own, and is told which two differ.
#[tokio::test(flavor = "multi_thread")]
async fn org_conversations_refuses_while_chat_is_on_another_organisation_and_names_both() {
    let org = FakeOrganisation::with_member("Ada Lovelace", None).with_conversations(acme_conversations());
    *org.chat_org.lock() = Some("org-globex".into());
    let (_server, client) = org_client(org.clone()).await;
    let (err, text) = call(&client, "org_conversations", json!({})).await;
    assert!(err);
    assert!(text.contains("org-globex") && text.contains("org-acme"), "{text}");

    *org.chat_org.lock() = None;
    let (err, text) = call(&client, "org_conversations", json!({})).await;
    assert!(err);
    assert!(text.contains("not connected") && text.contains("org-acme"), "{text}");
    client.cancel().await.ok();
}

// ── Refusals ─────────────────────────────────────────────────────────────────

#[tokio::test(flavor = "multi_thread")]
async fn switching_organisation_access_off_refuses_the_next_call_of_a_running_session() {
    let org = FakeOrganisation::with_member("Ada Lovelace", Some(Role::Developer));
    let (gate, on) = switchable(true);
    let tokens = Arc::new(MemoryTokens::default());
    let server = serve(tokens.clone(), org.clone(), gate).await;
    let client = connect(&server.url_at(ORG_PATH), &offered_token(&tokens, "s1", "/p", Some(acme())))
        .await
        .unwrap();
    assert!(!call(&client, "org_whoami", json!({})).await.0);
    let asked = org.asked().len();

    on.store(false, Ordering::SeqCst);
    let (err, text) = call(&client, "org_whoami", json!({})).await;
    assert!(err);
    assert!(text.contains("switched off"), "{text}");
    assert_eq!(org.asked().len(), asked, "nothing reached the organisation");
    client.cancel().await.ok();
}

/// A token minted without the organisation — a session the offer left it out
/// of, or one the session lifecycle re-minted — names no organisation, and
/// the tools do not pick one for it.
#[tokio::test(flavor = "multi_thread")]
async fn a_token_that_names_no_organisation_is_refused_and_nothing_is_asked() {
    let org = FakeOrganisation::with_member("Ada Lovelace", Some(Role::Developer));
    let tokens = Arc::new(MemoryTokens::default());
    let server = serve(tokens.clone(), org.clone(), setting(true)).await;
    let client = connect(&server.url_at(ORG_PATH), &tokens.mint("s1", "atlas-agent", "/p")).await.unwrap();
    let (err, text) = call(&client, "org_whoami", json!({})).await;
    assert!(err);
    assert!(text.contains("not given access to an organisation"), "{text}");
    assert!(org.asked().is_empty());
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn an_unknown_or_revoked_token_is_refused_on_the_org_path() {
    let org = FakeOrganisation::with_member("Ada Lovelace", Some(Role::Developer));
    let tokens = Arc::new(MemoryTokens::default());
    let server = serve(tokens.clone(), org, setting(true)).await;
    assert!(connect(&server.url_at(ORG_PATH), "not-a-token").await.is_err());
    let token = offered_token(&tokens, "s1", "/p", Some(acme()));
    tokens.revoke("s1");
    assert!(connect(&server.url_at(ORG_PATH), &token).await.is_err());
}

#[tokio::test(flavor = "multi_thread")]
async fn the_tool_list_is_what_the_model_is_offered() {
    let org = FakeOrganisation::with_member("Ada Lovelace", Some(Role::Developer));
    let tokens = Arc::new(MemoryTokens::default());
    let server = serve(tokens.clone(), org, setting(true)).await;
    let client = connect(&server.url_at(ORG_PATH), &offered_token(&tokens, "s1", "/p", Some(acme())))
        .await
        .unwrap();
    let names: Vec<String> = client.list_all_tools().await.unwrap().into_iter().map(|t| t.name.to_string()).collect();
    assert_eq!(names, tool_names());
    assert_eq!(names, ["org_whoami", "org_members", "org_conversations"]);
    client.cancel().await.ok();
}

#[test]
fn the_tool_list_carries_the_cache_fields_the_2026_07_28_spec_requires() {
    let list = serde_json::to_value(tools_list()).unwrap();
    assert_eq!(list["ttlMs"], json!(TOOLS_LIST_TTL_MS));
    assert_eq!(list["cacheScope"], json!("private"));
}

#[test]
fn the_instructions_state_the_protocol() {
    assert!(INSTRUCTIONS.contains("Call org_whoami first"));
    assert!(INSTRUCTIONS.contains("Prefer the current session"));
    assert!(INSTRUCTIONS.contains("ask the user which one"));
    assert!(INSTRUCTIONS.contains("comes back as candidates"));
    assert!(INSTRUCTIONS.contains("Never mark the user's inbox read"));
    assert!(INSTRUCTIONS.contains("asks the user first"));
}

// ── Handing the server to sessions ───────────────────────────────────────────

/// The account and the Project's binding as the offer sees them, counting
/// how often each is read.
struct FakeSessionOrgs {
    signed_in: bool,
    bound: Option<OrgScope>,
    reads: AtomicUsize,
}

impl FakeSessionOrgs {
    fn new(signed_in: bool, bound: Option<OrgScope>) -> Arc<Self> {
        Arc::new(Self { signed_in, bound, reads: AtomicUsize::new(0) })
    }
}

impl SessionOrgs for FakeSessionOrgs {
    fn signed_in(&self) -> bool {
        self.reads.fetch_add(1, Ordering::SeqCst);
        self.signed_in
    }

    fn bound_to(&self, _cwd: &str) -> Option<OrgScope> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        self.bound.clone()
    }
}

async fn running_host(org: Arc<dyn OrganisationCloud>) -> Arc<MemoryServerHost> {
    let host = Arc::new(MemoryServerHost::new());
    let server = MemoryServer::start_with(
        memory(),
        host.tokens().clone(),
        host.clocks().clone(),
        host.reads().clone(),
        sharing(true),
        Sources::default(),
        vec![quiet_ui(), router(OrgTools::new(org, setting(true)))],
    )
    .await
    .unwrap();
    host.adopt(server);
    host
}

fn offers(host: Arc<MemoryServerHost>, setting_on: bool, orgs: Arc<FakeSessionOrgs>) -> MemorySessionOffers {
    MemorySessionOffers::new(host, sharing(true))
        .with_ui(UiOffer::new(Arc::new(|| true)))
        .with_org(OrgOffer::new(setting(setting_on), orgs))
}

/// The native connection carries both properties; an ACP one neither. The
/// same agent id either way: only the connection's flags decide.
fn session_request(in_process: bool) -> SessionMcpRequest {
    SessionMcpRequest {
        agent_id: atlas_acp_thread::AgentId::new("atlas-agent"),
        http_mcp: true,
        ui_control: in_process,
        org_access: in_process,
        cwd: std::path::PathBuf::from("/p"),
        session_id: None,
    }
}

/// Every entry an offer carries, as `(name, url, bearer token)`.
fn entries(offer: &SessionMcpOffer) -> Vec<(String, String, String)> {
    offer
        .servers()
        .iter()
        .map(|server| {
            let acp::McpServer::Http(http) = server else { panic!("HTTP entries only") };
            let token = http
                .headers
                .iter()
                .find(|h| h.name == "Authorization")
                .and_then(|h| h.value.strip_prefix("Bearer "))
                .expect("a bearer token")
                .to_string();
            (http.name.clone(), http.url.clone(), token)
        })
        .collect()
}

fn names(offer: &SessionMcpOffer) -> Vec<String> {
    entries(offer).into_iter().map(|(name, _, _)| name).collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn a_native_session_on_a_cloud_bound_project_is_offered_all_three_on_one_token_carrying_the_organisation() {
    let org = FakeOrganisation::with_member("Ada Lovelace", Some(Role::Developer));
    org.record("s1", current(true));
    let host = running_host(org.clone()).await;
    let offer = offers(host.clone(), true, FakeSessionOrgs::new(true, Some(acme()))).offer(&session_request(true));
    let got = entries(&offer);
    assert_eq!(names(&offer), ["atlas_memory", UI_SERVER_NAME, ORG_SERVER_NAME]);
    assert!(got.iter().all(|(_, _, token)| *token == got[0].2), "all three ride one token");
    assert_eq!(Some(got[2].1.clone()), host.url_at(ORG_PATH));
    let token = got[2].2.clone();
    assert_eq!(host.tokens().grant(&token).unwrap().org, Some(acme()), "the grant carries the organisation");

    offer.bind(&acp::SessionId::new("s1"));
    assert_eq!(host.tokens().token_for("s1"), Some(token.clone()), "binding keeps the one token live");
    assert_eq!(host.tokens().grant(&token).unwrap().org, Some(acme()), "and the organisation with it");

    // The token the offer handed out is the one the agent calls with.
    let client = connect(&host.url_at(ORG_PATH).unwrap(), &token).await.unwrap();
    let answer = whoami(&client).await;
    assert_eq!(answer["organisation"]["id"], json!("org-acme"));
    assert_eq!(answer["current_session"]["id"], json!("rs-1"));
    client.cancel().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn an_acp_session_is_not_offered_the_org_server() {
    let host = running_host(Arc::new(FakeOrganisation::default())).await;
    let orgs = FakeSessionOrgs::new(true, Some(acme()));
    let offer = offers(host.clone(), true, orgs.clone()).offer(&session_request(false));
    assert_eq!(names(&offer), ["atlas_memory"]);
    assert_eq!(orgs.reads.load(Ordering::SeqCst), 0, "neither the account nor the binding was read");
    let token = entries(&offer)[0].2.clone();
    assert_eq!(host.tokens().grant(&token).unwrap().org, None);
}

#[tokio::test(flavor = "multi_thread")]
async fn with_the_setting_off_the_org_server_is_not_offered() {
    let host = running_host(Arc::new(FakeOrganisation::default())).await;
    let offer = offers(host, false, FakeSessionOrgs::new(true, Some(acme()))).offer(&session_request(true));
    assert_eq!(names(&offer), ["atlas_memory", UI_SERVER_NAME]);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_session_on_an_unbound_project_is_not_offered_the_org_server() {
    let host = running_host(Arc::new(FakeOrganisation::default())).await;
    let offer = offers(host.clone(), true, FakeSessionOrgs::new(true, None)).offer(&session_request(true));
    assert_eq!(names(&offer), ["atlas_memory", UI_SERVER_NAME]);
    let token = entries(&offer)[0].2.clone();
    assert_eq!(host.tokens().grant(&token).unwrap().org, None, "the token names no organisation");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_signed_out_user_is_not_offered_the_org_server() {
    let host = running_host(Arc::new(FakeOrganisation::default())).await;
    let orgs = FakeSessionOrgs::new(false, Some(acme()));
    let offer = offers(host, true, orgs.clone()).offer(&session_request(true));
    assert_eq!(names(&offer), ["atlas_memory", UI_SERVER_NAME]);
    assert_eq!(orgs.reads.load(Ordering::SeqCst), 1, "the binding is not opened for a signed-out user");
}

#[tokio::test(flavor = "multi_thread")]
async fn without_the_org_third_the_offer_is_as_before() {
    let host = running_host(Arc::new(FakeOrganisation::default())).await;
    let offers = MemorySessionOffers::new(host, sharing(true)).with_ui(UiOffer::new(Arc::new(|| true)));
    assert_eq!(names(&offers.offer(&session_request(true))), ["atlas_memory", UI_SERVER_NAME]);
}

#[test]
fn the_decision_says_whether_the_org_server_is_included_and_why_not() {
    use OrgOfferDecision::*;
    assert_eq!(OrgOfferDecision::decide(true, true, true, true, true, true), Included);
    assert_eq!(
        OrgOfferDecision::decide(false, true, true, true, true, true),
        Omitted("agent did not advertise mcpCapabilities.http")
    );
    assert_eq!(
        OrgOfferDecision::decide(true, false, true, true, true, true),
        Omitted("connection does not carry organisation access")
    );
    assert_eq!(
        OrgOfferDecision::decide(true, true, false, true, true, true),
        Omitted("organisation access is off in Settings")
    );
    assert_eq!(OrgOfferDecision::decide(true, true, true, false, true, true), Omitted("not signed in"));
    assert_eq!(
        OrgOfferDecision::decide(true, true, true, true, false, true),
        Omitted("project is not bound to a cloud Workspace")
    );
    assert_eq!(OrgOfferDecision::decide(true, true, true, true, true, false), Omitted("org tool server is not running"));
}

#[test]
fn each_decision_is_one_log_line_naming_the_agent_its_capabilities_and_the_outcome() {
    assert_eq!(
        OrgOfferDecision::Included.log_line("atlas-agent", true, true),
        "org tool server offer: agent=atlas-agent http_mcp=true org_access=true org_server=included",
    );
    assert_eq!(
        OrgOfferDecision::decide(true, false, true, true, true, true).log_line("claude-code", true, false),
        "org tool server offer: agent=claude-code http_mcp=true org_access=false org_server=omitted \
         reason=\"connection does not carry organisation access\"",
    );
}

#[test]
fn the_setting_is_not_read_for_a_connection_that_cannot_use_the_server() {
    let reads = Arc::new(AtomicUsize::new(0));
    let counted = reads.clone();
    let orgs = FakeSessionOrgs::new(true, Some(acme()));
    let offer = OrgOffer::new(
        Arc::new(move || {
            counted.fetch_add(1, Ordering::SeqCst);
            true
        }),
        orgs.clone(),
    );
    assert_eq!(offer.decide(true, false, "/p", true).1, None);
    assert_eq!(offer.decide(false, true, "/p", true).1, None);
    assert_eq!(reads.load(Ordering::SeqCst), 0);
    assert_eq!(orgs.reads.load(Ordering::SeqCst), 0);
}

// ── Which organisation a binding places a Project in ─────────────────────────

fn binding(mode: atlas_checkpoint::ProjectMode, enabled: bool, org: Option<&str>, workspace: Option<&str>) -> atlas_checkpoint::Binding {
    atlas_checkpoint::Binding {
        workspace_id: "/p".into(),
        root: "/p".into(),
        mode,
        slug: Some("atlas".into()),
        org_id: org.map(Into::into),
        root_commit_sha: None,
        fingerprint_is_shallow: false,
        git_url: None,
        enabled,
        import_approved: true,
        drain_state: atlas_checkpoint::model::DrainGate::Ok,
        remote_workspace_id: workspace.map(Into::into),
        created_at: chrono::Utc::now(),
    }
}

#[test]
fn a_cloud_binding_places_the_project_in_its_own_organisation_and_workspace() {
    use atlas_checkpoint::ProjectMode::{Cloud, Local};
    assert_eq!(scope_of(&binding(Cloud, true, Some("org-acme"), Some("ws-atlas"))), Some(acme()));
    assert_eq!(
        scope_of(&binding(Cloud, true, Some("org-acme"), None)),
        Some(OrgScope { org_id: "org-acme".into(), workspace_id: None }),
        "a binding from before the Workspace id was recorded still names its organisation",
    );
    assert_eq!(scope_of(&binding(Local, true, None, None)), None, "a local Project has no organisation");
    assert_eq!(scope_of(&binding(Cloud, false, Some("org-acme"), Some("ws-atlas"))), None, "capture switched off");
    assert_eq!(scope_of(&binding(Cloud, true, None, Some("ws-atlas"))), None);
}
