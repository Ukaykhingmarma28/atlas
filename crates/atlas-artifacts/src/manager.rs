//! Who is connected, to which Projects, and what to do when one drops.
//!
//! Shaped on `atlas_comms::manager`, with the two things that make an
//! org-switch safe carried over:
//!
//! * a **generation counter** — every retarget bumps it, and a task started
//!   under an older generation exits instead of writing into the new tenant's
//!   state. Without it a slow dial from the previous Organisation lands after
//!   the switch and clobbers it.
//! * **eviction forgets everything** — a dropped Project's cache entry goes
//!   with its socket, so a stale row cannot outlive the connection that
//!   produced it.
//!
//! One socket per connected Project. There is no org-wide socket to use
//! instead, and the count is bounded by how many Projects the developer has
//! actually bound on this machine.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use tokio::sync::{broadcast, mpsc};

use crate::board::{CloudBoard, ProjectKey};
use crate::socket::{self, ClientFrame, ConnEvent, ExitReason, ServerFrame};
use crate::{socket_url, TokenSource};

/// Reconnect backoff. Same shape as chat's: fast enough that a laptop waking
/// reconnects before the developer notices, slow enough that a service outage
/// is not a denial-of-service from every desktop at once.
const BACKOFF_MIN: std::time::Duration = std::time::Duration::from_secs(1);
const BACKOFF_MAX: std::time::Duration = std::time::Duration::from_secs(30);

/// Event fan-out capacity. A lagging subscriber drops rather than blocking the
/// producer; the host turns a lag into one resync rather than replaying.
const EVENT_CAPACITY: usize = 1024;

/// What the host forwards to the renderer.
#[derive(Debug, Clone)]
pub enum ArtifactsEvent {
    /// A Project's remote board changed. The host re-emits the existing
    /// `atlas:capture-changed`, so the Timeline re-reads through the path it
    /// already has rather than growing a second refresh route.
    BoardChanged { key: ProjectKey },
    /// One timeline entry was inserted or updated in an open Session.
    EntryUpsert {
        key: ProjectKey,
        session_id: String,
        change: String,
        entry: serde_json::Value,
    },
    /// A comment was posted, edited, resolved or deleted.
    ///
    /// Boxed for the same reason `ConnEvent::Frame` is: a `Comment` dwarfs the
    /// other variants, and this is a broadcast channel with a 1024 backlog.
    CommentUpsert {
        key: ProjectKey,
        session_id: String,
        comment: Box<crate::model::Comment>,
    },
    /// Who else is looking at this Project.
    Presence { key: ProjectKey, online: Vec<String> },
    /// Membership was revoked. Terminal — nothing reconnects after this.
    Revoked { key: ProjectKey },
    /// A subscriber fell behind and frames were dropped. Refetch rather than
    /// trusting local state.
    Resync,
}

/// One live (or reconnecting) Project connection.
struct Connection {
    outbound: mpsc::UnboundedSender<ClientFrame>,
    /// The Session this socket is subscribed to, if any. One at a time — a
    /// second subscribe replaces the first, server-side.
    subscribed: Option<String>,
}

pub struct ArtifactsManager {
    tokens: Arc<dyn TokenSource>,
    board: Arc<CloudBoard>,
    events: broadcast::Sender<ArtifactsEvent>,
    connections: Mutex<HashMap<ProjectKey, Connection>>,
    /// Bumped on every retarget. A task holding an older value is stale.
    generation: AtomicU64,
}

impl ArtifactsManager {
    pub fn new(tokens: Arc<dyn TokenSource>, board: Arc<CloudBoard>) -> Arc<Self> {
        let (events, _) = broadcast::channel(EVENT_CAPACITY);
        Arc::new(Self {
            tokens,
            board,
            events,
            connections: Mutex::new(HashMap::new()),
            generation: AtomicU64::new(0),
        })
    }

    pub fn subscribe(&self) -> broadcast::Receiver<ArtifactsEvent> {
        self.events.subscribe()
    }

    pub fn board(&self) -> Arc<CloudBoard> {
        Arc::clone(&self.board)
    }

    /// Connect exactly this set of Projects, and nothing else.
    ///
    /// Declarative rather than incremental: the caller states what should be
    /// live and this reconciles. An `connect`/`disconnect` pair would leave the
    /// set wrong the first time a caller forgot one half.
    pub fn retarget(self: &Arc<Self>, wanted: Vec<ProjectKey>) {
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;

        let to_start = {
            let Ok(mut connections) = self.connections.lock() else { return };

            // Drop what is no longer wanted, and forget its rows with it — a
            // Project we are not listening to cannot be kept current.
            let stale: Vec<ProjectKey> = connections
                .keys()
                .filter(|key| !wanted.contains(key))
                .cloned()
                .collect();
            for key in stale {
                connections.remove(&key);
                self.board.forget_project(&key);
            }

            wanted
                .into_iter()
                .filter(|key| !connections.contains_key(key))
                .collect::<Vec<_>>()
        };

        for key in to_start {
            self.start(key, generation);
        }
    }

    /// Drop every connection and every cached row. Called on an Organisation
    /// switch, so the incoming tenant inherits nothing.
    pub fn shutdown(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
        if let Ok(mut connections) = self.connections.lock() {
            connections.clear();
        }
        self.board.clear();
    }

    /// Follow one Session's entries and comments on an already-open socket.
    pub fn subscribe_session(&self, key: &ProjectKey, session_id: &str) {
        let Ok(mut connections) = self.connections.lock() else { return };
        let Some(conn) = connections.get_mut(key) else { return };
        if conn.subscribed.as_deref() == Some(session_id) {
            return;
        }
        conn.subscribed = Some(session_id.to_string());
        let _ = conn.outbound.send(ClientFrame::SessionSubscribe {
            session_id: session_id.to_string(),
        });
    }

    pub fn unsubscribe_session(&self, key: &ProjectKey) {
        let Ok(mut connections) = self.connections.lock() else { return };
        let Some(conn) = connections.get_mut(key) else { return };
        if conn.subscribed.take().is_some() {
            let _ = conn.outbound.send(ClientFrame::SessionUnsubscribe);
        }
    }

    /// Own one Project's connection for as long as it is wanted.
    fn start(self: &Arc<Self>, key: ProjectKey, generation: u64) {
        let (outbound_tx, mut outbound_rx) = mpsc::unbounded_channel();
        if let Ok(mut connections) = self.connections.lock() {
            connections.insert(key.clone(), Connection { outbound: outbound_tx, subscribed: None });
        }

        let manager = Arc::clone(self);
        tokio::spawn(async move {
            let mut backoff = BACKOFF_MIN;
            // One re-mint per dial, not per lifetime: a JWT lives ten minutes
            // and can expire between minting and dialling, but a 401 that
            // survives a fresh token is a real refusal.
            let mut remint_used = false;

            loop {
                if manager.generation.load(Ordering::SeqCst) != generation {
                    return;
                }

                let token = match manager.tokens.mint().await {
                    Ok(token) => token,
                    Err(e) => {
                        // Could be "signed out" or "the auth service blinked",
                        // and the two are not distinguishable here — so back
                        // off rather than tearing the Project down.
                        tracing::debug!(target: "atlas_artifacts::manager", "mint failed: {e}");
                        tokio::time::sleep(backoff).await;
                        backoff = (backoff * 2).min(BACKOFF_MAX);
                        continue;
                    }
                };

                let (conn_tx, mut conn_rx) = mpsc::unbounded_channel();
                let (relay_tx, relay_rx) = mpsc::unbounded_channel();

                // The outbound channel outlives one attempt, so subscribes
                // survive a reconnect; this relays into the attempt's own.
                let relay = tokio::spawn(async move {
                    while let Some(frame) = outbound_rx.recv().await {
                        if relay_tx.send(frame).is_err() {
                            break;
                        }
                    }
                    outbound_rx
                });

                let url = socket_url(&key.0, &key.1);
                let dial = tokio::spawn(socket::run(url, token, relay_rx, conn_tx));

                // Re-announce the subscription: the server holds it per socket,
                // so a reconnect starts with none.
                if let Ok(connections) = manager.connections.lock() {
                    if let Some(conn) = connections.get(&key) {
                        if let Some(ref session_id) = conn.subscribed {
                            let _ = conn.outbound.send(ClientFrame::SessionSubscribe {
                                session_id: session_id.clone(),
                            });
                        }
                    }
                }

                let mut exit = ExitReason::Closed;
                while let Some(event) = conn_rx.recv().await {
                    match event {
                        ConnEvent::Frame(frame) => {
                            backoff = BACKOFF_MIN;
                            remint_used = false;
                            manager.apply(&key, *frame);
                        }
                        ConnEvent::Closed(reason) => {
                            exit = reason;
                            break;
                        }
                    }
                }

                let _ = dial.await;
                outbound_rx = match relay.await {
                    Ok(rx) => rx,
                    Err(_) => return,
                };

                if manager.generation.load(Ordering::SeqCst) != generation {
                    return;
                }

                match exit {
                    ExitReason::Revoked => {
                        manager.forget(&key);
                        let _ = manager.events.send(ArtifactsEvent::Revoked { key: key.clone() });
                        return;
                    }
                    ExitReason::Forbidden => {
                        manager.forget(&key);
                        return;
                    }
                    ExitReason::Unauthorized if !remint_used => {
                        // Straight round again with a fresh token, no backoff.
                        remint_used = true;
                        continue;
                    }
                    _ => {}
                }

                tokio::time::sleep(backoff).await;
                backoff = (backoff * 2).min(BACKOFF_MAX);
            }
        });
    }

    fn forget(&self, key: &ProjectKey) {
        if let Ok(mut connections) = self.connections.lock() {
            connections.remove(key);
        }
        self.board.forget_project(key);
    }

    /// Fold one frame into the cache and announce what changed.
    fn apply(&self, key: &ProjectKey, frame: ServerFrame) {
        match frame {
            // Nothing to record: the roster arrives again as `presence`, and
            // the board is refreshed over HTTP rather than from the greeting.
            ServerFrame::Hello { .. } => {}
            ServerFrame::SessionSummary { summary } => {
                self.board.upsert(&key.0, summary);
                let _ = self.events.send(ArtifactsEvent::BoardChanged { key: key.clone() });
            }
            ServerFrame::ArtifactUpsert { session_id, change, entry } => {
                let _ = self.events.send(ArtifactsEvent::EntryUpsert {
                    key: key.clone(),
                    session_id,
                    change,
                    entry,
                });
            }
            ServerFrame::CommentUpsert { session_id, comment } => {
                let _ = self.events.send(ArtifactsEvent::CommentUpsert {
                    key: key.clone(),
                    session_id,
                    comment: Box::new(comment),
                });
            }
            ServerFrame::Presence { online } => {
                let _ = self.events.send(ArtifactsEvent::Presence { key: key.clone(), online });
            }
            ServerFrame::Unknown => {}
        }
    }
}
