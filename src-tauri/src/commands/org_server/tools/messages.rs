//! Chat messages: the outward `org_send`.

use atlas_comms::wire::{ConversationKind, CHAT_BODY_MAX_BYTES};
use rmcp::model::{CallToolResult, JsonObject};
use serde_json::json;

use super::super::cloud::{Member, NewMessage, OrgConversation};
use super::super::resolve::{self, Resolution};
use super::super::OrgScope;
use super::comments::{named_mentions, with_mentions};
use super::{ambiguous, conversation_json, member_json, roster_name, string_in, strings_in, tool_error, tool_json, OrgTools};

/// `org_send`'s arguments, read once for the call and for its approval card
/// alike, so the card's body is the body that is sent: strings trimmed,
/// blanks absent, blank mentions dropped.
pub(super) struct SendArgs<'a> {
    pub(super) to: Option<&'a str>,
    pub(super) body: Option<&'a str>,
    pub(super) mentions: Vec<String>,
}

impl<'a> SendArgs<'a> {
    pub(super) fn of(arguments: Option<&'a JsonObject>) -> Self {
        Self {
            to: string_in(arguments, "to"),
            body: string_in(arguments, "body"),
            mentions: strings_in(arguments, "mention"),
        }
    }
}

/// Where a message goes, found without writing anything: a conversation the
/// caller is in, or a member with whom the caller has no DM yet — which the
/// send creates first.
pub(super) enum Recipient {
    Conversation(OrgConversation),
    NewDm(Member),
}

/// Who a DM or group DM is with, by name where the roster has one, leaving
/// out the caller when they are known; by id where the roster cannot name
/// someone.
fn others(conversation: &OrgConversation, caller: Option<&str>, roster: Option<&[Member]>) -> Vec<String> {
    conversation
        .member_ids
        .iter()
        .flatten()
        .filter(|id| Some(id.as_str()) != caller)
        .map(|id| roster_name(roster, id).unwrap_or_else(|| id.clone()))
        .collect()
}

/// `a`, `a and b`, `a, b and c`.
fn listed(names: &[String]) -> String {
    match names {
        [] => String::new(),
        [one] => one.clone(),
        [init @ .., last] => format!("{} and {last}", init.join(", ")),
    }
}

impl OrgTools {
    /// The conversation `to` names, or the member — whose DM it then is.
    /// A conversation is tried first (an id, or a channel's name); a name no
    /// conversation answers to is then looked for on the roster (an id, a
    /// name or an email), and that member's DM is the one the caller already
    /// has, or a new one. A channel the caller is not in is refused — they
    /// could join it, but posting is not joining — and more than one match
    /// comes back as candidates. Reads only; the roster it read, when it read
    /// one, comes back with it for naming mentions and people.
    pub(super) async fn recipient(
        &self,
        scope: &OrgScope,
        to: &str,
    ) -> Result<(Recipient, Option<Vec<Member>>), CallToolResult> {
        let conversations = self.cloud.conversations(&scope.org_id).await.map_err(|e| tool_error(e.to_string()))?;
        match resolve::conversation(&conversations, to) {
            Resolution::One(conversation) => {
                if !conversation.caller_is_member {
                    let named = conversation.name.as_deref().map_or_else(|| conversation.id.clone(), |n| format!("#{n}"));
                    return Err(tool_error(format!(
                        "you are not a member of {named}, so you cannot post in it; ask the user to join it first. \
                         Nothing was sent."
                    )));
                }
                Ok((Recipient::Conversation(conversation.clone()), None))
            }
            Resolution::Many(found) => Err(ambiguous(
                to,
                "conversations",
                found.into_iter().map(|c| conversation_json(c, None)).collect(),
            )),
            Resolution::None => {
                let roster = self.cloud.members(&scope.org_id).await.map_err(|e| tool_error(e.to_string()))?;
                let member = match resolve::member(&roster, to) {
                    Resolution::One(member) => member.clone(),
                    Resolution::Many(found) => {
                        return Err(ambiguous(to, "members", found.into_iter().map(member_json).collect()))
                    }
                    Resolution::None => {
                        return Err(tool_error(format!(
                            "nothing matches \"{to}\": no conversation by id or channel name, and no member by id, \
                             name or email; call org_conversations or org_members"
                        )))
                    }
                };
                // Their DM is the one DM they are in. Every DM holds the
                // caller, so a member in several is the caller themself —
                // left to the server, which answers the one it keeps.
                let dms: Vec<&OrgConversation> = conversations
                    .iter()
                    .filter(|c| c.kind == ConversationKind::Dm)
                    .filter(|c| c.member_ids.as_ref().is_some_and(|ids| ids.contains(&member.user_id)))
                    .collect();
                let recipient = match dms.as_slice() {
                    [dm] => Recipient::Conversation((*dm).clone()),
                    _ => Recipient::NewDm(member),
                };
                Ok((recipient, Some(roster)))
            }
        }
    }

    /// `org_send`: posts `body` as the caller into the conversation `to`
    /// names, or into the DM with the member it names — created first when
    /// there is none. An **outward action** (ADR-0014): projected to ask
    /// first, with the recipient and this exact body on the approval card, and
    /// checked in [`answer`](Self::answer) for the user's approval of this
    /// exact call, so a call the engine ran unasked (bypass) never gets here.
    ///
    /// Everything that can refuse does so before anything is written — the
    /// recipient, a mention nobody or several members answer to, a body over
    /// chat's cap — so a refused send creates no DM either. The body goes out
    /// exactly as the card showed it: never truncated, never split, nothing
    /// added.
    pub(super) async fn send(&self, scope: &OrgScope, args: &SendArgs<'_>) -> CallToolResult {
        let Some(to) = args.to else {
            return tool_error(
                "say where to send it: `to` is a conversation's id or channel name, or a member's id, name or email",
            );
        };
        let Some(body) = args.body else {
            return tool_error("say what to send: `body` is the message's text");
        };
        let (recipient, roster) = match self.recipient(scope, to).await {
            Ok(found) => found,
            Err(answer) => return answer,
        };
        let roster = match roster {
            Some(roster) => Some(roster),
            None if !args.mentions.is_empty() => match self.cloud.members(&scope.org_id).await {
                Ok(roster) => Some(roster),
                Err(e) => return tool_error(e.to_string()),
            },
            None => None,
        };
        let body = match with_mentions(body, &args.mentions, roster.as_deref().unwrap_or_default()) {
            Ok(body) => body,
            Err(answer) => return answer,
        };
        // Chat's cap is UTF-8 bytes (the contract's `CHAT_BODY_MAX_BYTES`),
        // counted on the body as it will be posted.
        if body.len() > CHAT_BODY_MAX_BYTES {
            return tool_error(format!(
                "the message is {} bytes, over chat's cap of {CHAT_BODY_MAX_BYTES} bytes (UTF-8); shorten it or send \
                 it as several messages yourself. Nothing was sent.",
                body.len()
            ));
        }
        let (conversation, created_dm) = match recipient {
            Recipient::Conversation(conversation) => (conversation, false),
            Recipient::NewDm(member) => match self.cloud.dm_with(&scope.org_id, &member.user_id).await {
                Ok(opened) => opened,
                Err(e) => return tool_error(e.to_string()),
            },
        };
        let message = NewMessage { org_id: &scope.org_id, conversation_id: &conversation.id, body: &body };
        let sent = match self.cloud.send(message).await {
            Ok(sent) => sent,
            Err(e) => return tool_error(e.to_string()),
        };
        let roster = match roster {
            Some(roster) => Some(roster),
            None if conversation.member_ids.is_some() || body.contains("<@") => {
                self.cloud.members(&scope.org_id).await.ok()
            }
            None => None,
        };
        let mut answer = json!({
            "conversation": conversation_json(&conversation, roster.as_deref()),
            "message_id": sent.message_id,
            "client_msg_id": sent.client_msg_id,
            "created_dm": created_dm,
            "body": named_mentions(&body, roster.as_deref()),
        });
        if sent.message_id.is_none() {
            answer["note"] = json!(
                "chat has not confirmed it yet; it is queued on chat's connection and resent until the server takes it"
            );
        }
        tool_json(answer)
    }

    /// The approval card's title and recipient line for a send to
    /// `recipient`, as a person reads them: "Send to #general" / "Message
    /// Grace Hopper".
    pub(super) fn send_card(
        recipient: &Recipient,
        caller: Option<&str>,
        roster: Option<&[Member]>,
    ) -> (String, String) {
        match recipient {
            Recipient::NewDm(member) => (
                format!("Message {}", member.name),
                format!("{} ({}), in a new DM with them", member.name, member.email),
            ),
            Recipient::Conversation(c) => match c.kind {
                ConversationKind::Channel => {
                    let name = c.name.as_deref().map_or_else(|| c.id.clone(), |n| format!("#{n}"));
                    (format!("Send to {name}"), format!("Everyone in {name}"))
                }
                ConversationKind::Dm => {
                    let who = listed(&others(c, caller, roster));
                    (format!("Message {who}"), format!("{who}, in your DM"))
                }
                ConversationKind::GroupDm => {
                    let who = listed(&others(c, caller, roster));
                    (format!("Message the group with {who}"), format!("Everyone in your group DM with {who}"))
                }
            },
        }
    }
}
