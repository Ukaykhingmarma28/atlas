//! The read half of the artifacts API.
//!
//! Async reqwest, one client reused across calls. Every door is org-scoped and
//! every door mints a fresh token — the access JWT lives ten minutes and
//! nothing here holds one long enough for caching to be worth the staleness.
//!
//! **This module never writes a Session.** Pushing artifacts is
//! `atlas_checkpoint::sync`'s job and stays there; duplicating the outbox here
//! would give two code paths the right to claim a row was sent.

use std::sync::Arc;

use crate::error::{Error, Result};
use crate::model::{Comment, EntryPayload, SessionBoardPage, SessionDetailPage};
use crate::{ingest_base, AnchorKind, TokenSource};

/// The board read's page size. The server clamps at 100 and silently falls back
/// rather than refusing, so this is a request, not a guarantee.
const BOARD_PAGE: u32 = 100;

/// How many board pages one refresh will walk.
///
/// A ceiling rather than "until `nextCursor` is null": the board is a glance at
/// recent work, and an Organisation with a hundred thousand Sessions must not
/// turn a background refresh into an unbounded crawl.
const MAX_BOARD_PAGES: usize = 5;

/// The entries read's page size. The server clamps at 500.
const ENTRY_PAGE: u32 = 500;

/// How many entry pages one Session read will walk.
///
/// 40 pages is 20,000 entries — past anything the viewer renders comfortably,
/// and far past what a person reads. The ceiling exists so a pathological
/// Session cannot turn one click into an unbounded crawl.
const MAX_ENTRY_PAGES: usize = 40;

/// Which Session, in which Project, in which Organisation.
///
/// The three ids travel together on every comment route, and as three bare
/// `&str` parameters a transposed pair would compile and 404 at runtime.
#[derive(Debug, Clone, Copy)]
pub struct CommentTarget<'a> {
    pub org_id: &'a str,
    pub project_id: &'a str,
    pub session_id: &'a str,
}

/// A comment about to be posted.
///
/// No author and no mention list: the server derives both, authorship from the
/// verified token subject and mentions by parsing `<@user-id>` out of the
/// stored body. A client able to declare either could forge a colleague's
/// comment, which is why there is nowhere here to put one.
#[derive(Debug, Clone, Copy)]
pub struct NewComment<'a> {
    pub anchor_kind: AnchorKind,
    /// Ignored for [`AnchorKind::Session`], which addresses the Session itself.
    pub anchor_id: &'a str,
    pub parent_id: Option<&'a str>,
    pub body: &'a str,
}

pub struct ArtifactsClient {
    http: reqwest::Client,
    base: String,
    tokens: Arc<dyn TokenSource>,
}

impl ArtifactsClient {
    pub fn new(tokens: Arc<dyn TokenSource>) -> Result<Self> {
        let http = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .map_err(|e| Error::Transport(format!("building http client: {e}")))?;
        Ok(Self { http, base: ingest_base(), tokens })
    }

    /// Recent Sessions across the Organisation, or one Project of it.
    ///
    /// Walks up to [`MAX_BOARD_PAGES`]. `notes` from every page are kept: a
    /// Project the server could not reach is the difference between "no work
    /// here" and "we could not look", and the board has to be able to say so.
    pub async fn board(
        &self,
        org_id: &str,
        project_id: Option<&str>,
    ) -> Result<SessionBoardPage> {
        let mut out = SessionBoardPage::default();
        let mut cursor: Option<String> = None;

        for _ in 0..MAX_BOARD_PAGES {
            let mut req = self
                .http
                .get(format!("{}/sessions", self.base))
                .bearer_auth(self.token().await?)
                .query(&[("org", org_id), ("limit", &BOARD_PAGE.to_string())]);
            if let Some(project) = project_id {
                req = req.query(&[("workspace", project)]);
            }
            if let Some(ref c) = cursor {
                req = req.query(&[("cursor", c.as_str())]);
            }

            let page: SessionBoardPage = self.send(req, "board").await?;
            out.sessions.extend(page.sessions);
            out.notes.extend(page.notes);
            // Projects repeat on every page; the last answer is as good as the
            // first and saves deduplicating.
            if !page.workspaces.is_empty() {
                out.workspaces = page.workspaces;
            }
            match page.next_cursor {
                Some(next) => cursor = Some(next),
                None => return Ok(out),
            }
        }

        out.notes
            .push("Showing the most recent Sessions only — there are more on the server.".into());
        Ok(out)
    }

    /// One remote Session in full: its summary and its whole timeline.
    ///
    /// Pages until the cursor runs out, because a Session is read as a whole —
    /// the viewer groups tool calls into runs, folds consecutive responses and
    /// attributes Checkpoints to turns, none of which is correct on a prefix.
    /// [`MAX_ENTRY_PAGES`] is the ceiling; a Session past it comes back with a
    /// note rather than silently short.
    ///
    /// The server orders by `(turnSeq, rank, at, id)` and the pages continue
    /// that order, so concatenating them preserves it and no re-sort is needed.
    pub async fn session_detail(
        &self,
        org_id: &str,
        project_id: &str,
        session_id: &str,
    ) -> Result<SessionDetailPage> {
        let mut out = SessionDetailPage::default();
        let mut cursor: Option<String> = None;

        for page_no in 0..MAX_ENTRY_PAGES {
            let mut req = self
                .http
                .get(format!("{}/sessions/{project_id}/{session_id}", self.base))
                .bearer_auth(self.token().await?)
                .query(&[("org", org_id), ("limit", &ENTRY_PAGE.to_string())]);
            if let Some(ref c) = cursor {
                req = req.query(&[("cursor", c.as_str())]);
            }

            let page: SessionDetailPage = self.send(req, "session").await?;
            // The summary, counts and tallies are whole-Session figures repeated
            // on every page; the first answer is as good as the last.
            if page_no == 0 {
                out.summary = page.summary;
                out.counts = page.counts;
                out.tools = page.tools;
            }
            out.entries.extend(page.entries);
            out.notes.extend(page.notes);

            match page.next_cursor {
                Some(next) => cursor = Some(next),
                None => return Ok(out),
            }
        }

        out.notes.push(
            "This Session is too long to show in full — the newest entries are not loaded.".into(),
        );
        Ok(out)
    }

    /// The full text behind a truncated remote entry.
    ///
    /// The server keys this by the entry's `rowId` and a part name rather than
    /// by a blob key, so it does not go through `artifacts_payload` — that one
    /// reads this machine's blob sidecar, which a remote Session has no entry in.
    pub async fn entry_payload(
        &self,
        org_id: &str,
        project_id: &str,
        session_id: &str,
        row_id: &str,
        part: &str,
    ) -> Result<EntryPayload> {
        let req = self
            .http
            .get(format!(
                "{}/sessions/{project_id}/{session_id}/entries/{row_id}/payload",
                self.base
            ))
            .bearer_auth(self.token().await?)
            .query(&[("org", org_id), ("part", part)]);
        self.send(req, "entry payload").await
    }

    /// Every comment on a Session — roots and replies together, oldest first.
    ///
    /// Unpaged by the server, and there is no per-anchor count endpoint, so
    /// this one read is also where the counts come from.
    pub async fn comments(
        &self,
        org_id: &str,
        project_id: &str,
        session_id: &str,
    ) -> Result<Vec<Comment>> {
        #[derive(serde::Deserialize)]
        struct Wrapper {
            #[serde(default)]
            comments: Vec<Comment>,
        }
        let req = self
            .http
            .get(format!("{}/sessions/{project_id}/{session_id}/comments", self.base))
            .bearer_auth(self.token().await?)
            .query(&[("org", org_id)]);
        let wrapper: Wrapper = self.send(req, "comments").await?;
        Ok(wrapper.comments)
    }

    /// Post a comment. See [`NewComment`] for what is deliberately not sent.
    pub async fn create_comment(&self, at: CommentTarget<'_>, new: NewComment<'_>) -> Result<Comment> {
        #[derive(serde::Deserialize)]
        struct Wrapper {
            comment: Comment,
        }
        let mut payload = serde_json::json!({
            "anchor_kind": new.anchor_kind.as_str(),
            "parent_id": new.parent_id,
            "body": new.body,
        });
        // The session anchor addresses the Session itself, and the server
        // ignores an `anchor_id` on it rather than validating one.
        if new.anchor_kind != AnchorKind::Session {
            payload["anchor_id"] = serde_json::Value::String(new.anchor_id.to_string());
        }

        let req = self
            .http
            .post(format!(
                "{}/sessions/{}/{}/comments",
                self.base, at.project_id, at.session_id
            ))
            .bearer_auth(self.token().await?)
            .query(&[("org", at.org_id)])
            .json(&payload);
        let wrapper: Wrapper = self.send(req, "create comment").await?;
        Ok(wrapper.comment)
    }

    /// Edit a body (author only) and/or resolve a root (anyone who can read).
    pub async fn update_comment(
        &self,
        org_id: &str,
        project_id: &str,
        session_id: &str,
        comment_id: &str,
        body: Option<&str>,
        resolved: Option<bool>,
    ) -> Result<Comment> {
        #[derive(serde::Deserialize)]
        struct Wrapper {
            comment: Comment,
        }
        let mut payload = serde_json::Map::new();
        if let Some(body) = body {
            payload.insert("body".into(), serde_json::Value::String(body.to_string()));
        }
        if let Some(resolved) = resolved {
            payload.insert("resolved".into(), serde_json::Value::Bool(resolved));
        }
        if payload.is_empty() {
            return Err(Error::Protocol("an update must change something".into()));
        }

        let req = self
            .http
            .patch(format!(
                "{}/sessions/{project_id}/{session_id}/comments/{comment_id}",
                self.base
            ))
            .bearer_auth(self.token().await?)
            .query(&[("org", org_id)])
            .json(&serde_json::Value::Object(payload));
        let wrapper: Wrapper = self.send(req, "update comment").await?;
        Ok(wrapper.comment)
    }

    /// Delete a comment. The row survives with a `None` body so replies keep
    /// their places, which is why this answers with the comment rather than
    /// nothing.
    pub async fn delete_comment(
        &self,
        org_id: &str,
        project_id: &str,
        session_id: &str,
        comment_id: &str,
    ) -> Result<Comment> {
        #[derive(serde::Deserialize)]
        struct Wrapper {
            comment: Comment,
        }
        let req = self
            .http
            .delete(format!(
                "{}/sessions/{project_id}/{session_id}/comments/{comment_id}",
                self.base
            ))
            .bearer_auth(self.token().await?)
            .query(&[("org", org_id)]);
        let wrapper: Wrapper = self.send(req, "delete comment").await?;
        Ok(wrapper.comment)
    }

    async fn token(&self) -> Result<String> {
        self.tokens.mint().await
    }

    /// Send, classify the status, then decode.
    ///
    /// Status before body on purpose: a 401's body is an error envelope, and
    /// trying to decode it as the success shape would report a protocol fault
    /// for what is really an expired token.
    async fn send<T: serde::de::DeserializeOwned>(
        &self,
        req: reqwest::RequestBuilder,
        what: &str,
    ) -> Result<T> {
        let response = req
            .send()
            .await
            .map_err(|e| Error::Transport(format!("{what}: {e}")))?;

        let status = response.status();
        if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
            return Err(Error::RateLimited { retry_after: retry_after(&response) });
        }
        if !status.is_success() {
            return Err(Error::from_status(status.as_u16(), what));
        }

        response
            .json::<T>()
            .await
            .map_err(|e| Error::Protocol(format!("{what}: {e}")))
    }
}

/// `Retry-After`, delta-seconds only.
///
/// The server sends delta-seconds; an HTTP-date is legal in the spec and would
/// parse as garbage, so anything unreadable falls back to the server's own
/// window rather than to zero — retrying immediately is what got us limited.
fn retry_after(response: &reqwest::Response) -> u64 {
    response
        .headers()
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.trim().parse::<u64>().ok())
        .unwrap_or(60)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_session_anchor_carries_no_anchor_id() {
        // The server ignores one, but sending the Session id as an `anchor_id`
        // would make a session-level comment look like a row anchor to anyone
        // reading the request.
        assert_eq!(AnchorKind::Session.as_str(), "session");
        assert_ne!(AnchorKind::Session, AnchorKind::Message);
    }

    #[test]
    fn a_board_page_decodes_without_optional_fields() {
        let page: SessionBoardPage = serde_json::from_value(serde_json::json!({})).unwrap();
        assert!(page.sessions.is_empty());
        assert!(page.next_cursor.is_none());
        assert!(page.notes.is_empty());
    }
}
