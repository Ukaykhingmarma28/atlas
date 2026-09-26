//! What the approval card says about a waiting outward call
//! ([`OrgTools::describe`]).

use serde_json::Value;

use super::comments::{named_mentions, with_mentions, ReplyArgs};
use super::{roster_name, OrgTools};
use crate::commands::memory_server::Grant;
use atlas_agent_servers::CallDescription;
impl OrgTools {
    /// What the approval card says about a waiting outward call, for the
    /// offer to hand the native seam ([`SessionMcpServers::describe_call`]).
    /// Reads what the call will act on — never writes — so the card names the
    /// real recipient: the thread's first author and where the thread is.
    ///
    /// The body is read from the arguments by the same parser the call uses
    /// ([`ReplyArgs`]) and rewritten the same way ([`with_mentions`]), then
    /// read back as a person reads it — exactly what the posted comment will
    /// say. When the thread cannot be read the card still shows the comment id
    /// and that body; when the roster cannot be read either, mentions keep
    /// their `<@id>`. `None` for a tool that does not ask.
    ///
    /// [`SessionMcpServers::describe_call`]: atlas_agent_servers::SessionMcpServers::describe_call
    pub async fn describe(&self, grant: &Grant, tool: &str, arguments: &Value) -> Option<CallDescription> {
        if tool != "org_comment_reply" {
            return None;
        }
        let args = ReplyArgs::of(arguments.as_object());
        let comment_id = args.comment.unwrap_or_default();
        let body = args.body.unwrap_or_default();
        let scope = grant.org.clone();
        let thread = match &scope {
            Some(scope) => self.reply_thread(grant, scope, args.session, comment_id).await.ok(),
            None => None,
        };
        let roster = match &scope {
            Some(scope) if thread.is_some() || !args.mentions.is_empty() => self.cloud.members(&scope.org_id).await.ok(),
            _ => None,
        };
        let roster = roster.as_deref();
        // As it will be posted — a mention the call would refuse leaves the
        // body as written, since nothing is posted then — then read back.
        let posted = match roster {
            Some(roster) => with_mentions(body, &args.mentions, roster).unwrap_or_else(|_| body.to_string()),
            None => body.to_string(),
        };
        let body = named_mentions(&posted, roster);
        let Some((target, root)) = thread else {
            return Some(CallDescription {
                title: format!("Reply to comment {comment_id}"),
                recipient: format!("The thread of comment {comment_id}"),
                body,
            });
        };
        let author = root
            .guest_name
            .clone()
            .or_else(|| roster_name(roster, &root.author_id))
            .unwrap_or_else(|| root.author_id.clone());
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
            body,
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
