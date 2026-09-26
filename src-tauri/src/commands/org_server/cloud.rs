//! The **organisation cloud**: the one seam between the organisation tools and
//! everything remote.
//!
//! Every tool handler reaches the organisation through this trait and through
//! nothing else — no handler holds a client, mints a token or opens a store.
//! Production implements it over the clients Atlas already has
//! ([`AppOrganisationCloud`]); the tests implement it in memory, holding a
//! roster, a board of recorded sessions and their comments, so every fold,
//! cap, sentinel and refusal is tested through the tool surface the model
//! sees.
//!
//! Every method names the organisation it acts in explicitly, always the one
//! on the session's grant ([`OrgScope`]). An implementation never falls back
//! to whichever organisation the window is showing.
//!
//! Shaped to grow: each later tool adds the method it needs here (the roster,
//! conversations, the board, a recorded session's entries and an entry's
//! payload, replying on and resolving comments, the inbox, sending, creating a
//! DM, creating a Space page), its production half in the adapter and its
//! in-memory half in the tests' fake.
//!
//! [`AppOrganisationCloud`]: super::AppOrganisationCloud
//! [`OrgScope`]: super::OrgScope

use std::future::Future;
use std::pin::Pin;

use atlas_artifacts::Comment;

use super::OrgScope;
use crate::auth::Role;

/// What every organisation cloud call returns: boxed, because the trait is
/// used as `dyn` and the handlers are async.
pub type CloudFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, CloudError>> + Send + 'a>>;

/// Why a remote operation failed, in words the model can relay. Distinct
/// kinds, because the model's next move differs: a signed-out user must sign
/// in, a refusal will not become an acceptance by retrying, and a network
/// blip might.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CloudError {
    /// No account is signed in, or the server no longer accepts its credential.
    SignedOut(String),
    /// The server refused this user (a 403).
    Forbidden(String),
    /// No such thing, or one this user may not see (the server answers 404
    /// for both).
    NotFound(String),
    /// The organisation could not be reached, or answered something unreadable.
    /// Worth trying again later.
    Unavailable(String),
}

impl std::fmt::Display for CloudError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::SignedOut(reason) => write!(f, "not signed in to Atlas ({reason}); ask the user to sign in"),
            Self::Forbidden(reason) => write!(f, "the organisation refused this ({reason})"),
            Self::NotFound(reason) => write!(f, "not found ({reason})"),
            Self::Unavailable(reason) => write!(f, "the organisation could not be reached ({reason}); try again later"),
        }
    }
}

impl std::error::Error for CloudError {}

impl From<atlas_artifacts::Error> for CloudError {
    fn from(error: atlas_artifacts::Error) -> Self {
        use atlas_artifacts::Error as E;
        match error {
            E::Unauthorized(reason) => Self::SignedOut(reason),
            E::Forbidden(reason) => Self::Forbidden(reason),
            E::NotFound(reason) => Self::NotFound(reason),
            other => Self::Unavailable(other.to_string()),
        }
    }
}

/// Who the agent is acting as: the signed-in user, as a member of the
/// organisation on the grant.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Caller {
    pub user_id: String,
    pub name: String,
    /// The member's role in this organisation, from the access token's
    /// organisation claim. `None` when the claim does not place the user in
    /// it, or names a role this build does not know. Mirrored only to explain
    /// and to omit; the server is the authority.
    pub role: Option<Role>,
    /// The organisation's display name, when the account knows it.
    pub organisation_name: Option<String>,
}

/// A running chat, as the recorded-session join needs it: the organisation it
/// acts in, the session id the agent was opened with, and the launch
/// directory whose Project records it.
#[derive(Debug, Clone, Copy)]
pub struct CurrentSessionQuery<'a> {
    pub scope: &'a OrgScope,
    pub native_session_id: &'a str,
    pub cwd: &'a str,
}

/// A recorded session in the Workspace.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecordedSession {
    /// Its id on the server, which is also its captured row id here.
    pub id: String,
    /// The Workspace holding it.
    pub workspace_id: String,
    pub title: Option<String>,
    /// Whether its agent is still writing, as the server derives it.
    pub live: bool,
}

/// Everything the organisation tools do remotely.
pub trait OrganisationCloud: Send + Sync {
    /// The signed-in user as a member of `org_id`.
    fn caller<'a>(&'a self, org_id: &'a str) -> CloudFuture<'a, Caller>;

    /// The recorded session a running chat is written into — the **current**
    /// one — or `None` while it is not recorded in the Workspace yet (no
    /// prompt captured, or not synced to the server).
    fn current_session<'a>(&'a self, query: CurrentSessionQuery<'a>) -> CloudFuture<'a, Option<RecordedSession>>;

    /// Every comment on a recorded session, roots and replies, oldest first.
    fn comments<'a>(&'a self, org_id: &'a str, workspace_id: &'a str, session_id: &'a str)
        -> CloudFuture<'a, Vec<Comment>>;
}
