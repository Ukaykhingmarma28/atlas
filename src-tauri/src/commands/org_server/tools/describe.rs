//! What the approval card says about a waiting outward call
//! ([`OrgTools::describe`]).

use serde_json::Value;

use super::comments::{named_mentions, with_mentions, ReplyArgs};
use super::messages::{Recipient, SendArgs};
use super::{roster_name, OrgTools};
use crate::commands::memory_server::Grant;
use atlas_agent_servers::CallDescription;
impl OrgTools {
    /// What the approval card says about a waiting outward call, for the
    /// offer to hand the native seam ([`SessionMcpServers::describe_call`]).
    /// Reads what the call will act on — never writes — so the card names the
    /// real recipient: a reply's thread's first author and where the thread
    /// is; a message's channel, DM or group DM, or the member a new DM will be
    /// opened with.
    ///
    /// The body is read from the arguments by the same parser the call uses
    /// ([`ReplyArgs`], [`SendArgs`]) and rewritten the same way
    /// ([`with_mentions`]), then read back as a person reads it — exactly what
    /// the posted comment or message will say. When what it goes to cannot be
    /// read the card still shows what the call named and that body; when the
    /// roster cannot be read either, mentions keep their `<@id>`. `None` for
    /// a tool that does not ask.
    ///
    /// [`SessionMcpServers::describe_call`]: atlas_agent_servers::SessionMcpServers::describe_call
    pub async fn describe(&self, grant: &Grant, tool: &str, arguments: &Value) -> Option<CallDescription> {
        match tool {
            "org_comment_reply" => self.describe_reply(grant, arguments).await,
            "org_send" => self.describe_send(grant, arguments).await,
            _ => None,
        }
    }

    /// The card for `org_comment_reply`: the thread's first author, where the
    /// thread is, and the reply.
    async fn describe_reply(&self, grant: &Grant, arguments: &Value) -> Option<CallDescription> {
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

impl OrgTools {
    /// The card for `org_send`: where the message goes, found the way the
    /// call finds it ([`OrgTools::recipient`]), and the message.
    async fn describe_send(&self, grant: &Grant, arguments: &Value) -> Option<CallDescription> {
        let args = SendArgs::of(arguments.as_object());
        let to = args.to.unwrap_or_default();
        let body = args.body.unwrap_or_default();
        let scope = grant.org.clone();
        let found = match &scope {
            Some(scope) if !to.is_empty() => self.recipient(scope, to).await.ok(),
            _ => None,
        };
        let (recipient, roster) = match found {
            Some((recipient, roster)) => (Some(recipient), roster),
            None => (None, None),
        };
        let roster = match (roster, &scope) {
            (Some(roster), _) => Some(roster),
            (None, Some(scope)) if recipient.is_some() || !args.mentions.is_empty() => {
                self.cloud.members(&scope.org_id).await.ok()
            }
            _ => None,
        };
        let roster = roster.as_deref();
        // As it will be sent — a mention the call would refuse leaves the body
        // as written, since nothing is sent then — then read back.
        let posted = match roster {
            Some(roster) => with_mentions(body, &args.mentions, roster).unwrap_or_else(|_| body.to_string()),
            None => body.to_string(),
        };
        let body = named_mentions(&posted, roster);
        let Some(recipient) = recipient else {
            return Some(CallDescription { title: format!("Send to {to}"), recipient: to.to_string(), body });
        };
        // A DM is named by who else is in it, so the card needs to know who
        // the caller is; a channel and a new DM do not.
        let caller = match (&recipient, &scope) {
            (Recipient::Conversation(c), Some(scope)) if c.member_ids.is_some() => {
                self.cloud.caller(&scope.org_id).await.ok().map(|caller| caller.user_id)
            }
            _ => None,
        };
        let (title, recipient) = OrgTools::send_card(&recipient, caller.as_deref(), roster);
        Some(CallDescription { title, recipient, body })
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
