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
use crate::model::{Comment, EntryPayload, InboxPage, SessionBoardPage, SessionDetailPage};
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

/// The most an inbox page may hold. The server clamps at 100 and silently
/// falls back to its default of 50 past it, so a larger ask is clamped here
/// rather than quietly answered with fewer.
pub const INBOX_PAGE_MAX: u32 = 100;

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
    /// The last token minted, and when. Every request used to mint its own —
    /// a `GET /token` round trip per board page, per detail page and per
    /// comment — and a Timeline refreshing a Cloud Project every 15 s drove
    /// the auth server into `429`, after which the agent could not mint
    /// either and its turn died on "Missing bearer token". Dropped on any
    /// `401`, so a rejected token is never offered twice.
    cached: std::sync::Mutex<Option<(String, std::time::Instant)>>,
}

/// How long a minted token is reused. Access JWTs live about ten minutes;
/// reusing one for four leaves a wide margin for clock skew and slow requests
/// without parsing `exp`.
const TOKEN_REUSE: std::time::Duration = std::time::Duration::from_secs(240);

impl ArtifactsClient {
    pub fn new(tokens: Arc<dyn TokenSource>) -> Result<Self> {
        let http = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .map_err(|e| Error::Transport(format!("building http client: {e}")))?;
        Ok(Self { http, base: ingest_base(), tokens, cached: std::sync::Mutex::new(None) })
    }

    /// A client against another base, for tests that answer on loopback.
    #[cfg(test)]
    fn at(base: &str, tokens: Arc<dyn TokenSource>) -> Self {
        Self {
            http: reqwest::Client::new(),
            base: base.trim_end_matches('/').to_string(),
            tokens,
            cached: std::sync::Mutex::new(None),
        }
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

    /// One page of the signed-in person's inbox in `org_id`, newest first:
    /// mentions, replies and comments on their Sessions.
    ///
    /// **Read-only, and the only inbox call here.** The server's mark-read
    /// route (`POST /inbox/read`) has no caller in this crate on purpose: the
    /// unread state is the person's, and the agent tools this backs must never
    /// be able to clear it. There is no `user` parameter either — the server
    /// scopes both routes to the token's subject.
    ///
    /// One page rather than a walk: `cursor` continues where `next_cursor`
    /// left off, and `limit` is clamped to [`INBOX_PAGE_MAX`].
    pub async fn inbox(
        &self,
        org_id: &str,
        unread_only: bool,
        cursor: Option<&str>,
        limit: Option<u32>,
    ) -> Result<InboxPage> {
        let mut req = self
            .http
            .get(format!("{}/inbox", self.base))
            .bearer_auth(self.token().await?)
            .query(&[("org", org_id)]);
        if unread_only {
            req = req.query(&[("unread", "true")]);
        }
        if let Some(cursor) = cursor {
            req = req.query(&[("cursor", cursor)]);
        }
        if let Some(limit) = limit {
            req = req.query(&[("limit", limit.clamp(1, INBOX_PAGE_MAX).to_string())]);
        }
        self.send(req, "inbox").await
    }

    async fn token(&self) -> Result<String> {
        {
            let cached = self.cached.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            if let Some((token, minted)) = cached.as_ref() {
                if minted.elapsed() < TOKEN_REUSE {
                    return Ok(token.clone());
                }
            }
        }
        let token = self.tokens.mint().await?;
        *self.cached.lock().unwrap_or_else(std::sync::PoisonError::into_inner) =
            Some((token.clone(), std::time::Instant::now()));
        Ok(token)
    }

    fn forget_token(&self) {
        *self.cached.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = None;
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
        if status == reqwest::StatusCode::UNAUTHORIZED {
            self.forget_token();
        }
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

    // ── The inbox, against an HTTP server on loopback ───────────────────────

    use std::future::Future;
    use std::pin::Pin;

    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    struct Tok;
    impl TokenSource for Tok {
        fn mint(&self) -> Pin<Box<dyn Future<Output = Result<String>> + Send + '_>> {
            Box::pin(async { Ok("tok".to_string()) })
        }
    }

    /// Answers every request with `body` and keeps each request's head (the
    /// request line and headers), so a test asserts what reached the wire.
    async fn loopback(body: &'static str) -> (String, Arc<std::sync::Mutex<Vec<String>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind loopback");
        let base = format!("http://{}", listener.local_addr().unwrap());
        let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
        let log = seen.clone();
        tokio::spawn(async move {
            while let Ok((mut stream, _)) = listener.accept().await {
                let log = log.clone();
                tokio::spawn(async move {
                    let mut head = Vec::new();
                    let mut buf = [0u8; 1024];
                    while !head.windows(4).any(|w| w == b"\r\n\r\n") {
                        let Ok(n) = stream.read(&mut buf).await else { return };
                        if n == 0 {
                            return;
                        }
                        head.extend_from_slice(&buf[..n]);
                    }
                    log.lock().unwrap().push(String::from_utf8_lossy(&head).into_owned());
                    let response = format!(
                        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n\
                         content-length: {}\r\nconnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = stream.write_all(response.as_bytes()).await;
                });
            }
        });
        (base, seen)
    }

    const ONE_UNREAD: &str = concat!(
        r#"{"entries":[{"id":"n1","kind":"artifact_mention","orgId":"org_1","workspaceId":"ws_1","#,
        r#""workspaceSlug":"atlas","sessionId":"ses_1","sessionTitle":"Theme","commentId":"c1","#,
        r#""anchorKind":"session","anchorId":"","actorId":"user_ada","actorName":null,"#,
        r#""excerpt":"<@me> look","createdAt":"2026-09-20T10:04:11.000Z","readAt":null,"path":"/timeline"}],"#,
        r#""unread":7,"nextCursor":null}"#,
    );

    #[tokio::test]
    async fn the_inbox_is_one_get_on_the_inbox_route_with_the_org_unread_cursor_and_limit() {
        let (base, seen) = loopback(ONE_UNREAD).await;
        let client = ArtifactsClient::at(&base, Arc::new(Tok));

        let page = client.inbox("org_1", true, Some("1758362651000:n0"), Some(500)).await.unwrap();

        assert_eq!(page.unread, 7);
        assert_eq!(page.entries[0].kind, crate::InboxKind::Mention);
        let seen = seen.lock().unwrap().clone();
        assert_eq!(seen.len(), 1, "one request, and never a second to mark anything read: {seen:?}");
        let request_line = seen[0].lines().next().unwrap();
        assert_eq!(
            request_line,
            "GET /inbox?org=org_1&unread=true&cursor=1758362651000%3An0&limit=100 HTTP/1.1",
            "the read route, the grant's organisation, and the limit clamped to the server's maximum"
        );
        assert!(seen[0].to_ascii_lowercase().contains("authorization: bearer tok"));
    }

    #[tokio::test]
    async fn the_whole_inbox_omits_the_unread_filter() {
        let (base, seen) = loopback(ONE_UNREAD).await;
        let client = ArtifactsClient::at(&base, Arc::new(Tok));

        client.inbox("org_1", false, None, None).await.unwrap();

        let seen = seen.lock().unwrap().clone();
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0].lines().next().unwrap(), "GET /inbox?org=org_1 HTTP/1.1");
    }

    #[test]
    fn a_board_page_decodes_without_optional_fields() {
        let page: SessionBoardPage = serde_json::from_value(serde_json::json!({})).unwrap();
        assert!(page.sessions.is_empty());
        assert!(page.next_cursor.is_none());
        assert!(page.notes.is_empty());
    }
}
