//! The comment threads on a recorded session: `org_comments`,
//! `org_comment_resolve`, and the outward `org_comment_reply`.

use atlas_artifacts::Comment;
use rmcp::model::{CallToolResult, JsonObject};
use serde_json::{json, Value};

use super::super::cloud::{CommentRef, Member, NewReply};
use super::super::OrgScope;
use super::{
    author_json, resolve_member, roster_name, string_in, strings_in, tool_error, tool_json, OrgTools, SessionTarget,
};
use crate::commands::memory_server::Grant;
/// A comment body as a person reads it: every `<@user-id>` mention the
/// server parses written as `@Name` from the roster. A mention the roster
/// cannot name — it failed, or they have left — keeps its `<@id>`, so the
/// model still holds the id.
pub(in crate::commands::org_server) fn named_mentions(body: &str, roster: Option<&[Member]>) -> String {
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
    let mut out = json!({
        "id": comment.id,
        "author": author_json(&comment.author_id, comment.guest_name.as_deref(), roster),
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

impl OrgTools {
    /// `org_comments`: the threads on a recorded session, oldest first, each
    /// root with its replies, authors named from the roster and mentions
    /// written as names. The roster is read only to name people; when it
    /// cannot be, they keep their ids and the threads still answer.
    pub(super) async fn comments(
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
    pub(super) async fn resolve_comment(
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
    pub(super) async fn reply_thread(
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
    /// per-tool `prompt`, so the user sees the recipient and this exact body
    /// on the approval card; a rejected card never reaches here. What does
    /// reach here was checked in [`answer`](Self::answer) for the user's
    /// approval of this exact call, so a call the engine ran unasked (bypass)
    /// never gets this far. Mentions are resolved against the
    /// roster before anything is posted — a name nobody or several members
    /// answer to is refused with nothing sent.
    pub(super) async fn reply_comment(
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
        tool_json(json!({
            "session": { "id": target.id, "title": target.title, "current": target.current },
            "thread": {
                "id": root.id,
                "author": author_json(&root.author_id, root.guest_name.as_deref(), roster.as_deref()),
            },
            "comment": comment_json(&posted, roster.as_deref()),
        }))
    }
}

/// `org_comment_reply`'s arguments, read once for the call and for its
/// approval card alike, so the card's body is the body that is posted:
/// strings trimmed, blanks absent, blank mentions dropped.
pub(super) struct ReplyArgs<'a> {
    pub(super) comment: Option<&'a str>,
    pub(super) body: Option<&'a str>,
    pub(super) mentions: Vec<String>,
    pub(super) session: Option<&'a str>,
}

impl<'a> ReplyArgs<'a> {
    pub(super) fn of(arguments: Option<&'a JsonObject>) -> Self {
        Self {
            comment: string_in(arguments, "comment"),
            body: string_in(arguments, "body"),
            mentions: strings_in(arguments, "mention"),
            session: string_in(arguments, "session"),
        }
    }
}

/// `body` with each member `mentions` names written as the server's
/// `<@user-id>`: every `@<what the model named>` and `@<member's name>` in the
/// body becomes the mention, and a member the body does not `@` leads it. A
/// name that matches nobody, or several members, is the answer instead —
/// before anything is posted.
pub(in crate::commands::org_server) fn with_mentions(body: &str, mentions: &[String], roster: &[Member]) -> Result<String, CallToolResult> {
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
