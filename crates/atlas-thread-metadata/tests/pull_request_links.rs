//! The pull requests linked to a session: link, unlink, detect and sync,
//! through the store's public API, with persistence asserted by reopening.

use std::path::PathBuf;

use agent_client_protocol::schema::v1 as acp;
use atlas_thread_metadata::{
    visible_pull_requests, PathList, PullRequestLink, PullRequestLinkSource, PullRequestSnapshot,
    ThreadId, ThreadMetadata, ThreadMetadataStore, ThreadStoreEvent,
};
use chrono::Utc;

fn open(dir: &tempfile::TempDir) -> ThreadMetadataStore {
    ThreadMetadataStore::open(dir.path().join("threads.db")).expect("store opens")
}

fn saved(store: &ThreadMetadataStore) -> ThreadId {
    let mut thread = ThreadMetadata::new(
        ThreadId::new(),
        "some-agent".into(),
        PathList::new(&[PathBuf::from("/work/app")]),
    );
    thread.session_id = Some(acp::SessionId::new(thread.thread_id.to_key_string()));
    let id = thread.thread_id;
    store.save_all(vec![thread]);
    id
}

fn pr(number: u32, source: PullRequestLinkSource) -> PullRequestLink {
    PullRequestLink::new(
        "acme/shop",
        number,
        format!("https://github.com/acme/shop/pull/{number}"),
        source,
    )
}

fn snapshot(state: &str) -> PullRequestSnapshot {
    PullRequestSnapshot {
        state: state.into(),
        title: "Add discounts".into(),
        head_branch: "feature/discounts".into(),
        base_branch: "main".into(),
        is_draft: false,
        updated_at: Some("2026-10-20T10:00:00Z".into()),
        checks_state: Some("pending".into()),
        review_decision: Some("review-required".into()),
        comment_count: Some(3),
        synced_at: Utc::now(),
    }
}

#[test]
fn a_link_survives_a_reopen_with_every_field() {
    let dir = tempfile::tempdir().unwrap();
    let (id, link) = {
        let store = open(&dir);
        let id = saved(&store);
        let link = pr(12, PullRequestLinkSource::Created).with_snapshot(Some(snapshot("open")));
        assert!(store.link_pull_request(id, link.clone()));
        store.flush().unwrap();
        (id, link)
    };
    let store = open(&dir);
    assert_eq!(store.pull_requests(id), vec![link]);
}

#[test]
fn linking_twice_changes_nothing_and_emits_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let store = open(&dir);
    let id = saved(&store);
    assert!(store.link_pull_request(id, pr(1, PullRequestLinkSource::Manual)));
    let mut events = store.subscribe();
    assert!(!store.link_pull_request(id, pr(1, PullRequestLinkSource::Manual)));
    assert!(events.try_recv().is_err());
}

#[test]
fn detection_adds_only_what_the_session_does_not_hold() {
    let dir = tempfile::tempdir().unwrap();
    let store = open(&dir);
    let id = saved(&store);
    assert!(store.link_pull_request(id, pr(1, PullRequestLinkSource::Manual)));
    assert!(store.unlink_pull_request(id, "acme/shop", 1));
    // #1 is a tombstone, #2 is new.
    assert!(store.link_detected_pull_requests(
        id,
        vec![
            pr(1, PullRequestLinkSource::Detected),
            pr(2, PullRequestLinkSource::Detected),
        ],
    ));
    let links = store.pull_requests(id);
    let shown: Vec<u32> = visible_pull_requests(&links).map(|l| l.number).collect();
    assert_eq!(shown, vec![2]);
    assert!(!store.link_detected_pull_requests(id, vec![pr(2, PullRequestLinkSource::Detected)]));
}

#[test]
fn a_sync_reaches_every_session_linked_to_the_pull_request_in_one_event() {
    let dir = tempfile::tempdir().unwrap();
    let store = open(&dir);
    let a = saved(&store);
    let b = saved(&store);
    let c = saved(&store);
    assert!(store.link_pull_request(a, pr(5, PullRequestLinkSource::Created)));
    assert!(store.link_pull_request(b, pr(5, PullRequestLinkSource::Detected)));
    assert!(store.link_pull_request(c, pr(6, PullRequestLinkSource::Manual)));
    let mut events = store.subscribe();
    assert_eq!(
        store.sync_pull_request("ACME/shop", 5, &snapshot("open")),
        2
    );
    assert!(matches!(events.try_recv(), Ok(ThreadStoreEvent::Changed)));
    assert!(events.try_recv().is_err());
    // The same answer again says nothing new.
    assert_eq!(
        store.sync_pull_request("acme/shop", 5, &snapshot("open")),
        0
    );
    assert!(events.try_recv().is_err());
    assert_eq!(
        store.pull_requests(a)[0]
            .snapshot
            .as_ref()
            .map(|s| s.state.as_str()),
        Some("open")
    );
    assert!(store.pull_requests(c)[0].snapshot.is_none());
}

#[test]
fn a_row_that_does_not_exist_has_no_links_and_takes_none() {
    let dir = tempfile::tempdir().unwrap();
    let store = open(&dir);
    let ghost = ThreadId::new();
    assert!(store.pull_requests(ghost).is_empty());
    assert!(!store.link_pull_request(ghost, pr(1, PullRequestLinkSource::Manual)));
    assert!(!store.unlink_pull_request(ghost, "acme/shop", 1));
}
