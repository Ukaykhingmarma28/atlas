//! Pages in a conversation's Space: `org_page_create`.

use rmcp::model::CallToolResult;
use serde_json::json;

use super::super::cloud::NewPage;
use super::super::OrgScope;
use super::{conversation_json, resolve_conversation, tool_error, tool_json, OrgTools};

/// The longest a page's name may be: the contract's `SPACE_PAGE_NAME_MAX`,
/// counted as the contract counts it (UTF-16 units), and checked here so an
/// overlong name is refused before a socket is dialled rather than by the
/// Space after.
const PAGE_NAME_MAX: usize = 200;

impl OrgTools {
    /// `org_page_create`: a page with `name` at the root of the Space of the
    /// conversation `conversation` resolves to, created as the caller, and its
    /// id — which the UI tool server can open, and a later write fills.
    ///
    /// Auto-approved (ADR-0014): a page reaches no one, anyone in the
    /// conversation can see, move or delete it, and the call is audited like
    /// every call. Only in a conversation the caller is in — a channel they
    /// could join but have not is refused here, naming it, rather than left to
    /// the Space's refusal, so the model can say what to do. The conversation
    /// list is chat's, so a session whose organisation chat is not on is
    /// refused before anything is created.
    pub(super) async fn create_page(&self, scope: &OrgScope, conversation: &str, name: &str) -> CallToolResult {
        if name.encode_utf16().count() > PAGE_NAME_MAX {
            return tool_error(format!("a page's `name` is at most {PAGE_NAME_MAX} characters; shorten it"));
        }
        let conversations = match self.cloud.conversations(&scope.org_id).await {
            Ok(conversations) => conversations,
            Err(e) => return tool_error(e.to_string()),
        };
        let conversation = match resolve_conversation(&conversations, conversation) {
            Ok(one) => one,
            Err(answer) => return answer,
        };
        if !conversation.caller_is_member {
            let named = conversation.name.as_deref().map_or_else(|| conversation.id.clone(), |n| format!("#{n}"));
            return tool_error(format!(
                "you are not a member of {named}, so you cannot add a page to its Space; ask the user to join it \
                 first. Nothing was created."
            ));
        }
        let page = NewPage { org_id: &scope.org_id, conversation_id: &conversation.id, name };
        let page_id = match self.cloud.create_page(page).await {
            Ok(id) => id,
            Err(e) => return tool_error(e.to_string()),
        };
        // The roster only names the people in a DM; when it cannot be read,
        // they keep their ids and the page is still reported.
        let roster = if conversation.member_ids.is_some() { self.cloud.members(&scope.org_id).await.ok() } else { None };
        tool_json(json!({
            "page_id": page_id,
            "conversation": conversation_json(&conversation, roster.as_deref()),
            "name": name,
        }))
    }
}
