//! The pull requests linked to a session.
//!
//! A session can be tied to any number of pull requests: the one it opened,
//! the ones found on its branch, ones the user or the agent pointed at. Each
//! link remembers how it came to be ([`PullRequestLinkSource`]) and the last
//! state the host reported for it ([`PullRequestSnapshot`]), so every surface
//! can draw the pull request — its state, title, checks — without asking the
//! host first. The app's sync sweep refreshes the snapshots.
//!
//! Stored as one JSON column on the row (`pull_requests`), like the attached
//! projects: small, ridden along with the row, and never queried inside.
//!
//! A link the user removes is not deleted but tombstoned
//! ([`PullRequestLinkSource::Dismissed`]): the branch sweep would otherwise
//! find the pull request again a minute later and put it back. Every surface
//! hides tombstones ([`visible`]); linking the pull request again revives it.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// How a pull request came to be linked to a session.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PullRequestLinkSource {
    /// The user linked it ("Link a PR…").
    Manual,
    /// Opened from the session ("Create PR").
    Created,
    /// Found on the session's branch by the sync sweep.
    Detected,
    /// The agent linked it (`link_pull_request` on the code tool server).
    Agent,
    /// Unlinked by the user. Kept so the branch sweep does not re-add it;
    /// hidden everywhere.
    Dismissed,
}

impl PullRequestLinkSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Manual => "manual",
            Self::Created => "created",
            Self::Detected => "detected",
            Self::Agent => "agent",
            Self::Dismissed => "dismissed",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "manual" => Some(Self::Manual),
            "created" => Some(Self::Created),
            "detected" => Some(Self::Detected),
            "agent" => Some(Self::Agent),
            "dismissed" => Some(Self::Dismissed),
            _ => None,
        }
    }

    /// Someone chose this link: the user, the agent, or the session that
    /// opened it. A detected link is only an observation, and gives way to
    /// any of these.
    pub fn is_deliberate(self) -> bool {
        matches!(self, Self::Manual | Self::Created | Self::Agent)
    }
}

/// The last state the host reported for a linked pull request. Every field
/// but the state and title is optional, so an older snapshot still reads.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PullRequestSnapshot {
    /// `open`, `closed` or `merged`.
    pub state: String,
    pub title: String,
    #[serde(default)]
    pub head_branch: String,
    #[serde(default)]
    pub base_branch: String,
    #[serde(default)]
    pub is_draft: bool,
    /// When the host last saw it change (RFC 3339), as it reported it.
    #[serde(default)]
    pub updated_at: Option<String>,
    /// `passing`, `failing` or `pending`; `None` when it has no checks.
    #[serde(default)]
    pub checks_state: Option<String>,
    /// `approved`, `changes-requested` or `review-required`.
    #[serde(default)]
    pub review_decision: Option<String>,
    #[serde(default)]
    pub comment_count: Option<u32>,
    /// When Atlas read it.
    pub synced_at: DateTime<Utc>,
}

impl PullRequestSnapshot {
    /// Whether `other` says anything this one does not. `synced_at` is not
    /// news: a read that found nothing new changes nothing.
    pub fn same_as(&self, other: &Self) -> bool {
        self.state == other.state
            && self.title == other.title
            && self.head_branch == other.head_branch
            && self.base_branch == other.base_branch
            && self.is_draft == other.is_draft
            && self.updated_at == other.updated_at
            && self.checks_state == other.checks_state
            && self.review_decision == other.review_decision
            && self.comment_count == other.comment_count
    }
}

/// One pull request linked to a session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PullRequestLink {
    /// `owner/name`, as the host spells it. With `number`, the link's
    /// identity within the session (compared without case).
    pub repository: String,
    pub number: u32,
    /// The pull request's page on the host.
    pub url: String,
    pub source: PullRequestLinkSource,
    pub linked_at: DateTime<Utc>,
    /// `None` until the host has been read.
    #[serde(default)]
    pub snapshot: Option<PullRequestSnapshot>,
}

impl PullRequestLink {
    pub fn new(
        repository: impl Into<String>,
        number: u32,
        url: impl Into<String>,
        source: PullRequestLinkSource,
    ) -> Self {
        Self {
            repository: repository.into(),
            number,
            url: url.into(),
            source,
            linked_at: Utc::now(),
            snapshot: None,
        }
    }

    pub fn with_snapshot(mut self, snapshot: Option<PullRequestSnapshot>) -> Self {
        self.snapshot = snapshot;
        self
    }

    /// Whether this link is `repository#number`.
    pub fn is(&self, repository: &str, number: u32) -> bool {
        self.number == number && self.repository.eq_ignore_ascii_case(repository)
    }

    pub fn is_visible(&self) -> bool {
        self.source != PullRequestLinkSource::Dismissed
    }
}

/// The links every surface shows: all but the tombstones.
pub fn visible(links: &[PullRequestLink]) -> impl Iterator<Item = &PullRequestLink> {
    links.iter().filter(|l| l.is_visible())
}

/// The entry for `repository#number`, tombstone or not.
pub(crate) fn position(links: &[PullRequestLink], repository: &str, number: u32) -> Option<usize> {
    links.iter().position(|l| l.is(repository, number))
}

/// Add `link`, or revive or strengthen the one already there. Answers whether
/// anything changed.
///
/// - absent: appended;
/// - a tombstone: revived when `link` is deliberate (the user, or the agent,
///   asked for it back), never by detection;
/// - detected, and `link` is deliberate: takes `link`'s source, so unlinking
///   it later is the user undoing their own choice;
/// - otherwise: left as it is. Linking twice is not an error.
///
/// A snapshot `link` carries fills one the entry lacks.
pub(crate) fn link(links: &mut Vec<PullRequestLink>, link: PullRequestLink) -> bool {
    let Some(ix) = position(links, &link.repository, link.number) else {
        links.push(link);
        return true;
    };
    let existing = &mut links[ix];
    let revive = existing.source == PullRequestLinkSource::Dismissed && link.source.is_deliberate();
    let strengthen =
        existing.source == PullRequestLinkSource::Detected && link.source.is_deliberate();
    if !revive && !strengthen {
        return false;
    }
    existing.source = link.source;
    if revive {
        existing.linked_at = link.linked_at;
    }
    if existing.snapshot.is_none() {
        existing.snapshot = link.snapshot;
    }
    true
}

/// Tombstone `repository#number`. Answers whether a visible link was there.
pub(crate) fn unlink(links: &mut [PullRequestLink], repository: &str, number: u32) -> bool {
    let Some(ix) = position(links, repository, number) else {
        return false;
    };
    let existing = &mut links[ix];
    if !existing.is_visible() {
        return false;
    }
    existing.source = PullRequestLinkSource::Dismissed;
    true
}

/// Record a fresh read of `repository#number`. Answers whether it said
/// anything new (a tombstone takes the snapshot too, silently: it is not
/// shown, but keeps the branch name the sweep matches on).
pub(crate) fn sync(
    links: &mut [PullRequestLink],
    repository: &str,
    number: u32,
    snapshot: PullRequestSnapshot,
) -> bool {
    let Some(ix) = position(links, repository, number) else {
        return false;
    };
    let existing = &mut links[ix];
    if existing
        .snapshot
        .as_ref()
        .is_some_and(|held| held.same_as(&snapshot))
    {
        return false;
    }
    existing.snapshot = Some(snapshot);
    true
}

/// The column's text: `None` (SQL `NULL`) when empty, so a session with no
/// links reads exactly like a row from before the column.
pub(crate) fn encode(links: &[PullRequestLink]) -> Option<String> {
    if links.is_empty() {
        return None;
    }
    serde_json::to_string(links).ok()
}

/// The list a column holds. Unreadable text decodes to nothing rather than
/// failing the row: a lost link is found again by the sweep, or linked again.
pub(crate) fn decode(text: Option<String>) -> Vec<PullRequestLink> {
    let Some(text) = text.filter(|t| !t.trim().is_empty()) else {
        return Vec::new();
    };
    match serde_json::from_str::<Vec<PullRequestLink>>(&text) {
        Ok(list) => list,
        Err(e) => {
            tracing::warn!(error = %e, "unreadable pull_requests column; treating it as empty");
            Vec::new()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot(state: &str, title: &str) -> PullRequestSnapshot {
        PullRequestSnapshot {
            state: state.into(),
            title: title.into(),
            head_branch: "feature".into(),
            base_branch: "main".into(),
            is_draft: false,
            updated_at: Some("2026-10-20T10:00:00Z".into()),
            checks_state: Some("passing".into()),
            review_decision: None,
            comment_count: Some(2),
            synced_at: Utc::now(),
        }
    }

    fn pr(number: u32, source: PullRequestLinkSource) -> PullRequestLink {
        PullRequestLink::new(
            "acme/shop",
            number,
            format!("https://github.com/acme/shop/pull/{number}"),
            source,
        )
    }

    #[test]
    fn an_empty_list_is_stored_as_null_and_null_reads_as_empty() {
        assert_eq!(encode(&[]), None);
        assert!(decode(None).is_empty());
        assert!(decode(Some("  ".into())).is_empty());
        assert!(decode(Some("{not json".into())).is_empty());
    }

    #[test]
    fn a_list_round_trips_through_its_column() {
        let list = vec![
            pr(1, PullRequestLinkSource::Created)
                .with_snapshot(Some(snapshot("open", "Add discounts"))),
            pr(2, PullRequestLinkSource::Dismissed),
        ];
        assert_eq!(decode(encode(&list)), list);
    }

    #[test]
    fn identity_ignores_the_repository_s_case() {
        let link = pr(7, PullRequestLinkSource::Manual);
        assert!(link.is("ACME/Shop", 7));
        assert!(!link.is("acme/shop", 8));
    }

    #[test]
    fn linking_appends_revives_and_strengthens_but_never_weakens() {
        let mut links = vec![];
        assert!(link(&mut links, pr(1, PullRequestLinkSource::Detected)));
        // Detected again: nothing new.
        assert!(!link(&mut links, pr(1, PullRequestLinkSource::Detected)));
        // The user links it: it is theirs now.
        assert!(link(&mut links, pr(1, PullRequestLinkSource::Manual)));
        assert_eq!(links[0].source, PullRequestLinkSource::Manual);
        // Detection never takes it back.
        assert!(!link(&mut links, pr(1, PullRequestLinkSource::Detected)));
        assert_eq!(links[0].source, PullRequestLinkSource::Manual);
        assert_eq!(links.len(), 1);
    }

    #[test]
    fn unlinking_tombstones_so_detection_cannot_bring_it_back() {
        let mut links = vec![pr(3, PullRequestLinkSource::Detected)];
        assert!(unlink(&mut links, "acme/shop", 3));
        assert!(!unlink(&mut links, "acme/shop", 3));
        assert_eq!(visible(&links).count(), 0);
        assert!(!link(&mut links, pr(3, PullRequestLinkSource::Detected)));
        assert_eq!(visible(&links).count(), 0);
        // A deliberate link revives it.
        assert!(link(&mut links, pr(3, PullRequestLinkSource::Agent)));
        assert_eq!(links[0].source, PullRequestLinkSource::Agent);
    }

    #[test]
    fn a_read_that_says_nothing_new_changes_nothing() {
        let mut links = vec![pr(4, PullRequestLinkSource::Created)];
        assert!(sync(&mut links, "acme/shop", 4, snapshot("open", "One")));
        let mut again = snapshot("open", "One");
        again.synced_at = Utc::now() + chrono::Duration::minutes(5);
        assert!(!sync(&mut links, "acme/shop", 4, again));
        assert!(sync(&mut links, "acme/shop", 4, snapshot("merged", "One")));
        assert!(!sync(&mut links, "acme/shop", 99, snapshot("open", "Nope")));
    }

    #[test]
    fn the_wire_names_are_snake_case() {
        assert_eq!(
            serde_json::to_string(&PullRequestLinkSource::Detected).unwrap(),
            "\"detected\""
        );
        for source in [
            PullRequestLinkSource::Manual,
            PullRequestLinkSource::Created,
            PullRequestLinkSource::Detected,
            PullRequestLinkSource::Agent,
            PullRequestLinkSource::Dismissed,
        ] {
            assert_eq!(PullRequestLinkSource::parse(source.as_str()), Some(source));
        }
        assert_eq!(PullRequestLinkSource::parse("stack"), None);
    }
}
