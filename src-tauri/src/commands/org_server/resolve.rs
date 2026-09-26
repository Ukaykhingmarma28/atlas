//! **Name resolution**: how a member or a conversation the model names
//! becomes an id. Not a tool — the tools that take a person or a conversation
//! by name call it, against the roster and the conversation list the
//! organisation cloud returned.
//!
//! The model is never trusted to invent an id, and never left to guess one:
//! a name matches by rule, in tiers, and the first tier with any match
//! decides.
//!
//! 1. **The id itself** — what a mention in the prompt carries, and what an
//!    earlier `org_members` or `org_conversations` answer gave the model.
//! 2. **The exact name**, as the roster spells it.
//! 3. **The email** (members only), ignoring case, as email does.
//! 4. **The name ignoring case.**
//!
//! A leading `@` on a member or `#` on a channel is how people write them,
//! not part of the name, and is dropped. Nothing looser than case is matched
//! — no prefixes, no first names — because a loose match that finds one
//! person is a guess that happened to be unique. Zero matches is an error;
//! exactly one is used; more than one returns every candidate, with its id,
//! so the model can ask the user which one (ADR-0013).
//!
//! Pure: no cloud, no clock, no I/O.

use super::cloud::{Member, OrgConversation};

/// What a name came to.
#[derive(Debug, PartialEq, Eq)]
pub enum Resolution<'a, T> {
    /// Nothing matched.
    None,
    /// Exactly one matched: use it.
    One(&'a T),
    /// More than one matched in the deciding tier, in list order: ask.
    Many(Vec<&'a T>),
}

/// The first tier with any match decides; within it, one is an answer and
/// more is a question.
fn first_tier<'a, T>(items: &'a [T], tiers: &[&dyn Fn(&T) -> bool]) -> Resolution<'a, T> {
    for matches in tiers {
        let found: Vec<&T> = items.iter().filter(|item| matches(item)).collect();
        match found.len() {
            0 => continue,
            1 => return Resolution::One(found[0]),
            _ => return Resolution::Many(found),
        }
    }
    Resolution::None
}

/// A member by id, name or email.
pub fn member<'a>(roster: &'a [Member], query: &str) -> Resolution<'a, Member> {
    let query = query.trim();
    let name = query.strip_prefix('@').unwrap_or(query).trim();
    if name.is_empty() {
        return Resolution::None;
    }
    let lower = name.to_lowercase();
    first_tier(
        roster,
        &[
            &|m: &Member| m.user_id == query,
            &|m: &Member| m.name == name,
            &|m: &Member| !m.email.is_empty() && m.email.to_lowercase() == lower,
            &|m: &Member| m.name.to_lowercase() == lower,
        ],
    )
}

/// A channel's name as people write it after the `#`.
fn named(conversation: &OrgConversation) -> Option<&str> {
    conversation.name.as_deref().map(|n| n.strip_prefix('#').unwrap_or(n))
}

/// A conversation by id or name. Only channels have names; a DM is reached
/// through its member, not its conversation.
pub fn conversation<'a>(conversations: &'a [OrgConversation], query: &str) -> Resolution<'a, OrgConversation> {
    let query = query.trim();
    let name = query.strip_prefix('#').unwrap_or(query).trim();
    if name.is_empty() {
        return Resolution::None;
    }
    let lower = name.to_lowercase();
    first_tier(
        conversations,
        &[
            &|c: &OrgConversation| c.id == query,
            &|c: &OrgConversation| named(c) == Some(name),
            &|c: &OrgConversation| named(c).is_some_and(|n| n.to_lowercase() == lower),
        ],
    )
}

#[cfg(test)]
mod tests {
    use atlas_comms::wire::ConversationKind;

    use super::*;

    fn m(user_id: &str, name: &str, email: &str) -> Member {
        Member { user_id: user_id.into(), name: name.into(), email: email.into(), role: None }
    }

    fn roster() -> Vec<Member> {
        vec![
            m("u-ada", "Ada Lovelace", "ada@acme.dev"),
            m("u-sam1", "Sam Lee", "sam.lee@acme.dev"),
            m("u-sam2", "Sam Lee", "slee@acme.dev"),
            m("u-grace", "Grace Hopper", "Grace@Acme.dev"),
            m("u-GRACE", "grace hopper", "gh@elsewhere.dev"),
        ]
    }

    fn ids<T>(found: Resolution<'_, T>, id: impl Fn(&T) -> &str) -> Result<String, Vec<String>> {
        match found {
            Resolution::None => Err(Vec::new()),
            Resolution::One(one) => Ok(id(one).to_string()),
            Resolution::Many(many) => Err(many.into_iter().map(|c| id(c).to_string()).collect()),
        }
    }

    fn who(query: &str) -> Result<String, Vec<String>> {
        ids(member(&roster(), query), |m| &m.user_id)
    }

    #[test]
    fn an_exact_name_resolves_to_its_member() {
        assert_eq!(who("Ada Lovelace"), Ok("u-ada".into()));
        assert_eq!(who("@Ada Lovelace"), Ok("u-ada".into()), "an @ is how people write a member");
    }

    #[test]
    fn a_name_in_another_case_resolves_when_no_one_has_it_exactly() {
        assert_eq!(who("ada lovelace"), Ok("u-ada".into()));
        assert_eq!(who("  ADA LOVELACE "), Ok("u-ada".into()));
    }

    #[test]
    fn an_exact_name_wins_over_the_same_name_in_another_case() {
        assert_eq!(who("grace hopper"), Ok("u-GRACE".into()));
        assert_eq!(who("Grace Hopper"), Ok("u-grace".into()));
        assert_eq!(who("GRACE HOPPER"), Err(vec!["u-grace".into(), "u-GRACE".into()]), "two differ only by case");
    }

    #[test]
    fn an_email_resolves_ignoring_case() {
        assert_eq!(who("slee@acme.dev"), Ok("u-sam2".into()));
        assert_eq!(who("grace@acme.DEV"), Ok("u-grace".into()));
    }

    #[test]
    fn an_id_resolves_to_itself() {
        assert_eq!(who("u-sam1"), Ok("u-sam1".into()));
    }

    #[test]
    fn two_members_with_one_name_are_both_candidates_in_roster_order() {
        assert_eq!(who("Sam Lee"), Err(vec!["u-sam1".into(), "u-sam2".into()]));
    }

    #[test]
    fn nothing_looser_than_case_matches() {
        assert_eq!(who("Ada"), Err(vec![]), "a first name is a guess");
        assert_eq!(who("Lovelace"), Err(vec![]));
        assert_eq!(who("ada@acme"), Err(vec![]));
        assert_eq!(who(""), Err(vec![]));
        assert_eq!(who("@"), Err(vec![]));
    }

    fn c(id: &str, kind: ConversationKind, name: Option<&str>) -> OrgConversation {
        OrgConversation { id: id.into(), kind, name: name.map(Into::into), member_ids: None, caller_is_member: true }
    }

    fn channels() -> Vec<OrgConversation> {
        vec![
            c("c-general", ConversationKind::Channel, Some("general")),
            c("c-design", ConversationKind::Channel, Some("Design")),
            c("c-design-2", ConversationKind::Channel, Some("design")),
            c("c-dm", ConversationKind::Dm, None),
            c("c-ops", ConversationKind::Channel, Some("#ops")),
        ]
    }

    fn which(query: &str) -> Result<String, Vec<String>> {
        ids(conversation(&channels(), query), |c| &c.id)
    }

    #[test]
    fn a_channel_resolves_by_name_with_or_without_its_hash() {
        assert_eq!(which("general"), Ok("c-general".into()));
        assert_eq!(which("#general"), Ok("c-general".into()));
        assert_eq!(which("ops"), Ok("c-ops".into()), "a name stored with its hash matches without it");
        assert_eq!(which("#OPS"), Ok("c-ops".into()));
    }

    #[test]
    fn a_channel_name_in_another_case_resolves_unless_one_has_it_exactly() {
        assert_eq!(which("GENERAL"), Ok("c-general".into()));
        assert_eq!(which("design"), Ok("c-design-2".into()));
        assert_eq!(which("DESIGN"), Err(vec!["c-design".into(), "c-design-2".into()]));
    }

    #[test]
    fn a_conversation_resolves_by_its_id() {
        assert_eq!(which("c-dm"), Ok("c-dm".into()));
    }

    #[test]
    fn an_unknown_channel_matches_nothing() {
        assert_eq!(which("random"), Err(vec![]));
        assert_eq!(which("#"), Err(vec![]));
    }
}
