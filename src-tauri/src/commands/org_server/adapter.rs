//! The production organisation cloud, and the offer's view of the account and
//! the Project's binding, over the state the app already holds.
//!
//! Nothing here mints a token of its own or holds a new client: remote reads
//! go through the artifacts client the Timeline uses (with its 240-second
//! token reuse, so the organisation tools add no pressure on the rate-limited
//! token route), the roster through the auth core the Members modal reads,
//! chat through the one comms manager the chat pane uses (its REST client, no
//! second socket), and who the user is comes from the auth core's snapshot.
//! Both are resolved per call rather than held, because this is built during
//! `setup`, where registration order is not guaranteed — the same reason the
//! artifacts module's token source resolves `AuthState` per call.
//!
//! What never happens here: reading the app's active or chat organisation.
//! Every method is told which organisation to act in, by the session's grant.

use tauri::{AppHandle, Manager};

use super::cloud::{
    Caller, CloudError, CloudFuture, CurrentSessionQuery, InboxQuery, Member, OrgConversation, OrganisationCloud,
    RecordedSession,
};
use super::offers::SessionOrgs;
use super::OrgScope;
use crate::auth::{AccountOrg, AccountUser, AuthSnapshot};
use crate::commands::artifacts_cloud::{is_cloud_bound, recorded_session_id, ArtifactsCloudState};
use crate::commands::auth::AuthState;

/// The organisation cloud over the app's existing clients.
pub struct AppOrganisationCloud {
    app: AppHandle,
}

impl AppOrganisationCloud {
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }

    fn artifacts(&self) -> Result<tauri::State<'_, ArtifactsCloudState>, CloudError> {
        self.app
            .try_state::<ArtifactsCloudState>()
            .ok_or_else(|| CloudError::Unavailable("the Timeline's cloud reader is not ready".into()))
    }
}

/// The signed-in account and its organisations, or why there is none.
fn account(app: &AppHandle) -> Result<(Option<AccountUser>, Vec<AccountOrg>), CloudError> {
    let Some(auth) = app.try_state::<AuthState>() else {
        return Err(CloudError::SignedOut("the account is not ready".into()));
    };
    match auth.core().snapshot() {
        AuthSnapshot::SignedIn { user, orgs, .. } => Ok((user, orgs.unwrap_or_default())),
        _ => Err(CloudError::SignedOut("no account is signed in".into())),
    }
}

/// The captured row a chat is recorded in, and its local title, when the
/// launch directory's Project is bound to the scope's organisation and
/// Workspace. The same join the chat's comment pane uses.
fn captured(query: &CurrentSessionQuery<'_>) -> Result<Option<(String, String, Option<String>)>, String> {
    let Some(workspace_id) = query.scope.workspace_id.clone() else { return Ok(None) };
    let Some(store) = crate::commands::capture::open_reader(query.cwd)? else { return Ok(None) };
    let Ok(Some(binding)) = store.binding() else { return Ok(None) };
    // Still bound where the grant says: a Project rebound elsewhere since the
    // offer is not this session's organisation any more.
    if !is_cloud_bound(&binding, &query.scope.org_id)
        || binding.remote_workspace_id.as_deref() != Some(workspace_id.as_str())
    {
        return Ok(None);
    }
    let Some(row_id) = recorded_session_id(&store, query.cwd, query.native_session_id)? else {
        return Ok(None);
    };
    let title = store.session(&row_id).ok().flatten().and_then(|s| s.title);
    Ok(Some((row_id, workspace_id, title)))
}

impl OrganisationCloud for AppOrganisationCloud {
    fn caller<'a>(&'a self, org_id: &'a str) -> CloudFuture<'a, Caller> {
        Box::pin(async move {
            let (user, orgs) = account(&self.app)?;
            let Some(user) = user else {
                return Err(CloudError::Unavailable("the account's profile has not loaded yet".into()));
            };
            let org = orgs.into_iter().find(|o| o.id == org_id);
            Ok(Caller {
                user_id: user.id,
                name: user.name,
                role: org.as_ref().and_then(|o| o.role),
                organisation_name: org.map(|o| o.name),
            })
        })
    }

    fn current_session<'a>(&'a self, query: CurrentSessionQuery<'a>) -> CloudFuture<'a, Option<RecordedSession>> {
        Box::pin(async move {
            let owned = (query.scope.clone(), query.native_session_id.to_string(), query.cwd.to_string());
            let found = tauri::async_runtime::spawn_blocking(move || {
                let (scope, native_session_id, cwd) = owned;
                captured(&CurrentSessionQuery { scope: &scope, native_session_id: &native_session_id, cwd: &cwd })
            })
            .await
            .map_err(|e| CloudError::Unavailable(e.to_string()))?
            .map_err(CloudError::Unavailable)?;
            let Some((id, workspace_id, local_title)) = found else { return Ok(None) };

            // Liveness is the server's to derive. The board the Timeline keeps
            // fresh answers without a request when this organisation is the
            // one it shows; otherwise ask for the session itself.
            let artifacts = self.artifacts()?;
            let org_id = &query.scope.org_id;
            let summary = match artifacts.board.snapshot(org_id).sessions.get(&id).cloned() {
                Some(summary) => summary,
                None => match artifacts.client.session_detail(org_id, &workspace_id, &id).await {
                    Ok(page) => page.summary,
                    // Captured here, not synced yet: the Workspace does not
                    // hold it, so it is not recorded there yet.
                    Err(atlas_artifacts::Error::NotFound(_)) => return Ok(None),
                    Err(e) => return Err(e.into()),
                },
            };
            Ok(Some(RecordedSession {
                id,
                workspace_id,
                title: summary.title.filter(|t| !t.is_empty()).or(local_title),
                live: summary.live,
            }))
        })
    }

    fn members<'a>(&'a self, org_id: &'a str) -> CloudFuture<'a, Vec<Member>> {
        Box::pin(async move {
            let Some(auth) = self.app.try_state::<AuthState>() else {
                return Err(CloudError::SignedOut("the account is not ready".into()));
            };
            let core = auth.core();
            let roster = core.list_members(org_id).await?;
            Ok(roster
                .into_iter()
                .map(|m| Member { user_id: m.user_id, name: m.name, email: m.email, role: m.role })
                .collect())
        })
    }

    fn conversations<'a>(&'a self, org_id: &'a str) -> CloudFuture<'a, Vec<OrgConversation>> {
        Box::pin(async move {
            let comms = crate::commands::comms::manager(&self.app).map_err(CloudError::Unavailable)?;
            // Chat's one socket is on the organisation the window chose for
            // it. A chat tool acts there only when that is the grant's.
            let chat_org = comms.org_id();
            if chat_org.as_deref() != Some(org_id) {
                return Err(CloudError::ChatElsewhere { grant_org: org_id.to_string(), chat_org });
            }
            let list = comms.rest().conversations(org_id).await?;
            let listed = |c: atlas_comms::wire::Conversation, caller_is_member: bool| OrgConversation {
                id: c.id,
                kind: c.kind,
                name: c.name,
                member_ids: c.member_ids,
                caller_is_member,
            };
            Ok(list
                .conversations
                .into_iter()
                .filter(|c| c.archived_at.is_none())
                .map(|c| listed(c, true))
                .chain(list.discoverable.into_iter().filter(|c| c.archived_at.is_none()).map(|c| listed(c, false)))
                .collect())
        })
    }

    fn comments<'a>(
        &'a self,
        org_id: &'a str,
        workspace_id: &'a str,
        session_id: &'a str,
    ) -> CloudFuture<'a, Vec<atlas_artifacts::Comment>> {
        Box::pin(async move {
            let artifacts = self.artifacts()?;
            Ok(artifacts.client.comments(org_id, workspace_id, session_id).await?)
        })
    }

    /// The inbox route's read half through the Timeline's artifacts client.
    /// The client has no mark-read call, so this cannot reach one.
    fn inbox<'a>(&'a self, org_id: &'a str, query: InboxQuery<'a>) -> CloudFuture<'a, atlas_artifacts::InboxPage> {
        Box::pin(async move {
            let artifacts = self.artifacts()?;
            Ok(artifacts.client.inbox(org_id, query.unread_only, query.cursor, query.limit).await?)
        })
    }
}

/// The offer's view of the account and the Project's binding, over the auth
/// core and the capture store.
pub struct AppSessionOrgs {
    app: AppHandle,
}

impl AppSessionOrgs {
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }
}

impl SessionOrgs for AppSessionOrgs {
    fn signed_in(&self) -> bool {
        account(&self.app).is_ok()
    }

    fn bound_to(&self, cwd: &str) -> Option<OrgScope> {
        let store = crate::commands::capture::open_reader(cwd).ok().flatten()?;
        let binding = store.binding().ok().flatten()?;
        scope_of(&binding)
    }
}

/// The organisation a Project's binding places it in: its own organisation,
/// while it is bound to the cloud and still recording. Never the window's.
pub(super) fn scope_of(binding: &atlas_checkpoint::Binding) -> Option<OrgScope> {
    let org_id = binding.org_id.clone()?;
    if !is_cloud_bound(binding, &org_id) {
        return None;
    }
    Some(OrgScope { org_id, workspace_id: binding.remote_workspace_id.clone() })
}
