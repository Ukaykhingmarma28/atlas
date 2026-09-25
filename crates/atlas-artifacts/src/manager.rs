//! Who is connected, to which Projects, and what to do when one drops.
//!
//! Shaped on `atlas_comms::manager`, with the two things that make an
//! org-switch safe carried over — and one lesson it had to learn twice:
//!
//! * **Identity is per connection, not per manager.** Every supervisor task
//!   carries the `epoch` of the registry slot it was started for, and may only
//!   touch a slot carrying that same epoch. A retarget that leaves a Project in
//!   the wanted set never disturbs its live socket; a retarget that drops one
//!   removes the slot, which is what stops the task. The first version used a
//!   single manager-wide generation instead, bumped on *every* retarget — so a
//!   socket opened at boot was stale by the third retarget (auth resolves, the
//!   Organisation list merges, StrictMode re-runs the effect), and exited for
//!   good on its first disconnect, leaving a slot that swallowed every later
//!   subscribe. Realtime comments "worked, then stopped" until reopened.
//! * **Eviction forgets everything** — a dropped Project's cache entry goes
//!   with its socket, so a stale row cannot outlive the connection that
//!   produced it.
//!
//! # Subscriptions outlive sockets
//!
//! The server keeps the subscribed Session on the socket's own attachment and
//! never acknowledges a subscribe, so it dies with the socket. The desired
//! Session is therefore recorded here, per Project, independently of whether a
//! socket exists right now: a subscribe issued before the Project's socket is
//! started is announced when it opens; a reconnect re-announces it first thing;
//! and a reconnect that had something to re-announce also asks the renderer to
//! resync, because whatever the server said in the gap is gone.
//!
//! One socket per connected Project. There is no org-wide socket to use
//! instead, and the count is bounded by how many Projects the developer has
//! actually bound on this machine.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::sync::{broadcast, mpsc, watch};

use crate::board::{CloudBoard, ProjectKey};
use crate::socket::{self, ClientFrame, ConnEvent, ExitReason, Keepalive, ServerFrame};
use crate::{socket_url, socket_url_at, TokenSource};

/// Event fan-out capacity. A lagging subscriber drops rather than blocking the
/// producer; the host turns a lag into one resync rather than replaying.
const EVENT_CAPACITY: usize = 1024;

/// Every tunable, so the tests can run the real supervisor against a loopback
/// server in milliseconds rather than the seconds production wants.
#[derive(Debug, Clone)]
pub struct ManagerConfig {
    /// Reconnect backoff. Same shape as chat's: fast enough that a laptop
    /// waking reconnects before the developer notices, slow enough that a
    /// service outage is not a denial-of-service from every desktop at once.
    pub backoff_min: Duration,
    pub backoff_max: Duration,
    /// The pause before the one re-mint a `401` earns. Without it a server
    /// that keeps answering `401` to fresh tokens is dialled in a hot loop.
    pub remint_delay: Duration,
    pub keepalive: Keepalive,
    /// Override the socket base (`ws://127.0.0.1:port`). `None` uses the
    /// environment ladder in [`crate::socket_url`].
    pub ws_base: Option<String>,
}

impl Default for ManagerConfig {
    fn default() -> Self {
        Self {
            backoff_min: Duration::from_secs(1),
            backoff_max: Duration::from_secs(30),
            remint_delay: Duration::from_secs(1),
            keepalive: Keepalive::default(),
            ws_base: None,
        }
    }
}

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
    /// Local state has a gap it cannot see — a subscriber fell behind and
    /// frames were dropped, or a socket reconnected after carrying a
    /// subscription. Refetch rather than trusting what is held.
    Resync,
}

/// One live (or reconnecting) Project connection.
struct Connection {
    /// The supervisor's identity. Monotonic per manager; a supervisor may only
    /// mutate or remove the slot whose epoch equals its own.
    epoch: u64,
    /// Held for its `Drop`: the supervisor watches the receiving side and
    /// treats the sender going away as its stop signal. Removing the slot is
    /// the whole of "stop this Project".
    _stop: watch::Sender<()>,
    /// The current attempt's sender — installed before each dial, cleared
    /// after. `None` while minting or backing off, when there is nothing to
    /// write to and the desired Session waits in `subscriptions`.
    outbound: Option<mpsc::UnboundedSender<ClientFrame>>,
}

/// Everything under one lock, so there is no lock order to get wrong.
#[derive(Default)]
struct Registry {
    connections: HashMap<ProjectKey, Connection>,
    /// The Session each Project should be following. Independent of any
    /// socket: survives a reconnect, a `Forbidden` retirement and a subscribe
    /// that arrived before the socket existed. Pruned only by `retarget`,
    /// `shutdown` and an explicit unsubscribe.
    subscriptions: HashMap<ProjectKey, String>,
}

pub struct ArtifactsManager {
    tokens: Arc<dyn TokenSource>,
    board: Arc<CloudBoard>,
    events: broadcast::Sender<ArtifactsEvent>,
    registry: Mutex<Registry>,
    next_epoch: AtomicU64,
    config: ManagerConfig,
}

impl ArtifactsManager {
    pub fn new(tokens: Arc<dyn TokenSource>, board: Arc<CloudBoard>) -> Arc<Self> {
        Self::with_config(tokens, board, ManagerConfig::default())
    }

    pub fn with_config(
        tokens: Arc<dyn TokenSource>,
        board: Arc<CloudBoard>,
        config: ManagerConfig,
    ) -> Arc<Self> {
        let (events, _) = broadcast::channel(EVENT_CAPACITY);
        Arc::new(Self {
            tokens,
            board,
            events,
            registry: Mutex::new(Registry::default()),
            next_epoch: AtomicU64::new(0),
            config,
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
    ///
    /// **Idempotent for a Project already connected.** Calling this with the
    /// same set is a no-op for every live socket, which matters because the
    /// host calls it on every auth, Organisation and binding change.
    pub fn retarget(self: &Arc<Self>, wanted: Vec<ProjectKey>) {
        let wanted_count = wanted.len();
        let (to_start, stopped) = {
            let Ok(mut registry) = self.registry.lock() else { return };

            // Drop what is no longer wanted, and forget its rows with it — a
            // Project we are not listening to cannot be kept current. Removing
            // the slot drops its stop handle, which is what ends the task.
            let stale: Vec<ProjectKey> = registry
                .connections
                .keys()
                .filter(|key| !wanted.contains(key))
                .cloned()
                .collect();
            for key in &stale {
                registry.connections.remove(key);
                self.board.forget_project(key);
            }
            registry.subscriptions.retain(|key, _| wanted.contains(key));

            let to_start: Vec<ProjectKey> = wanted
                .iter()
                .filter(|key| !registry.connections.contains_key(*key))
                .cloned()
                .collect();
            (to_start, stale)
        };

        tracing::info!(
            target: "atlas_artifacts",
            "retarget: wanted={wanted_count} kept={} started={:?} stopped={:?}",
            wanted_count - to_start.len(),
            to_start.iter().map(|k| k.1.as_str()).collect::<Vec<_>>(),
            stopped.iter().map(|k| k.1.as_str()).collect::<Vec<_>>(),
        );

        for key in to_start {
            self.start(key);
        }
    }

    /// Drop every connection and every cached row. Called on an Organisation
    /// switch, so the incoming tenant inherits nothing.
    pub fn shutdown(&self) {
        if let Ok(mut registry) = self.registry.lock() {
            let n = registry.connections.len();
            registry.connections.clear();
            registry.subscriptions.clear();
            tracing::info!(target: "atlas_artifacts", "shutdown: dropped {n} sockets");
        }
        self.board.clear();
    }

    /// Follow one Session's entries and comments on this Project's socket.
    ///
    /// Recorded whether or not a socket exists yet, and **always sent** when
    /// one does — the server replaces the subscription idempotently, and a
    /// short-circuit on "already subscribed" is what once let a reordered
    /// unsubscribe win.
    pub fn subscribe_session(&self, key: &ProjectKey, session_id: &str) {
        let Ok(mut registry) = self.registry.lock() else { return };
        registry.subscriptions.insert(key.clone(), session_id.to_string());
        let sent = registry
            .connections
            .get(key)
            .and_then(|conn| conn.outbound.as_ref())
            .is_some_and(|tx| {
                tx.send(ClientFrame::SessionSubscribe { session_id: session_id.to_string() })
                    .is_ok()
            });
        tracing::info!(
            target: "atlas_artifacts",
            "subscribe {session_id} on {}: {}",
            key.1,
            if sent { "sent" } else { "queued until the socket opens" }
        );
    }

    pub fn unsubscribe_session(&self, key: &ProjectKey) {
        let Ok(mut registry) = self.registry.lock() else { return };
        if registry.subscriptions.remove(key).is_none() {
            return;
        }
        if let Some(tx) = registry.connections.get(key).and_then(|conn| conn.outbound.as_ref()) {
            let _ = tx.send(ClientFrame::SessionUnsubscribe);
        }
        tracing::info!(target: "atlas_artifacts", "unsubscribe on {}", key.1);
    }

    /// Install the current attempt's sender — only if the slot is still ours.
    fn install_outbound(
        &self,
        key: &ProjectKey,
        epoch: u64,
        tx: mpsc::UnboundedSender<ClientFrame>,
    ) -> bool {
        let Ok(mut registry) = self.registry.lock() else { return false };
        match registry.connections.get_mut(key) {
            Some(conn) if conn.epoch == epoch => {
                conn.outbound = Some(tx);
                true
            }
            _ => false,
        }
    }

    /// Clear the attempt's sender, but only the one this epoch installed.
    fn release_outbound(&self, key: &ProjectKey, epoch: u64) {
        let Ok(mut registry) = self.registry.lock() else { return };
        if let Some(conn) = registry.connections.get_mut(key) {
            if conn.epoch == epoch {
                conn.outbound = None;
            }
        }
    }

    /// Remove the slot this epoch owns. The desired Session stays recorded,
    /// so the next retarget picks it up again.
    fn retire(&self, key: &ProjectKey, epoch: u64) {
        let Ok(mut registry) = self.registry.lock() else { return };
        if registry.connections.get(key).is_some_and(|conn| conn.epoch == epoch) {
            registry.connections.remove(key);
        }
    }

    fn desired_session(&self, key: &ProjectKey) -> Option<String> {
        self.registry.lock().ok()?.subscriptions.get(key).cloned()
    }

    fn url_for(&self, key: &ProjectKey) -> String {
        match self.config.ws_base.as_deref() {
            Some(base) => socket_url_at(base, &key.0, &key.1),
            None => socket_url(&key.0, &key.1),
        }
    }

    #[cfg(test)]
    fn epoch_of(&self, key: &ProjectKey) -> Option<u64> {
        self.registry.lock().ok()?.connections.get(key).map(|c| c.epoch)
    }

    #[cfg(test)]
    fn has_connection(&self, key: &ProjectKey) -> bool {
        self.registry.lock().is_ok_and(|r| r.connections.contains_key(key))
    }

    #[cfg(test)]
    fn desired(&self, key: &ProjectKey) -> Option<String> {
        self.desired_session(key)
    }

    fn start(self: &Arc<Self>, key: ProjectKey) {
        let epoch = self.next_epoch.fetch_add(1, Ordering::SeqCst) + 1;
        let (stop_tx, mut stop_rx) = watch::channel(());
        if let Ok(mut registry) = self.registry.lock() {
            registry
                .connections
                .insert(key.clone(), Connection { epoch, _stop: stop_tx, outbound: None });
        }

        let manager = Arc::clone(self);
        tokio::spawn(async move {
            let cfg = manager.config.clone();
            let mut backoff = cfg.backoff_min;
            // One re-mint per dial, not per lifetime: a JWT lives ten minutes
            // and can expire between minting and dialling, but a 401 that
            // survives a fresh token is a real refusal.
            let mut remint_used = false;
            let mut attempts: u32 = 0;

            loop {
                if stopped(&stop_rx) {
                    tracing::info!(target: "atlas_artifacts", "{}: supervisor {epoch} stopped", key.1);
                    return;
                }

                let token = tokio::select! {
                    _ = stop_rx.changed() => return,
                    minted = manager.tokens.mint() => match minted {
                        Ok(token) => token,
                        Err(e) => {
                            // Could be "signed out" or "the auth service
                            // blinked", and the two are not distinguishable
                            // here — so back off rather than tearing the
                            // Project down.
                            tracing::debug!(target: "atlas_artifacts::manager", "mint failed: {e}");
                            if !sleep_or_stop(&mut stop_rx, backoff).await {
                                return;
                            }
                            backoff = (backoff * 2).min(cfg.backoff_max);
                            continue;
                        }
                    },
                };

                let (tx, rx) = mpsc::unbounded_channel();
                let (conn_tx, mut conn_rx) = mpsc::unbounded_channel();
                if !manager.install_outbound(&key, epoch, tx.clone()) {
                    // The slot was replaced or removed while we were minting.
                    return;
                }
                // Announce the desired Session before the dial, so it is the
                // first frame on the wire after the 101: the server holds the
                // subscription per socket, and this socket has none yet.
                let reannounced = manager.desired_session(&key);
                if let Some(ref session_id) = reannounced {
                    let _ = tx.send(ClientFrame::SessionSubscribe { session_id: session_id.clone() });
                }
                drop(tx);

                let dial = tokio::spawn(socket::run(
                    manager.url_for(&key),
                    token,
                    rx,
                    conn_tx,
                    cfg.keepalive,
                ));

                let mut exit = ExitReason::Closed;
                let mut stopping = false;
                let mut opened = false;
                loop {
                    tokio::select! {
                        _ = stop_rx.changed() => {
                            stopping = true;
                            break;
                        }
                        event = conn_rx.recv() => match event {
                            Some(ConnEvent::Frame(frame)) => {
                                if !opened {
                                    opened = true;
                                    if attempts > 0 && reannounced.is_some() {
                                        // Whatever the server said while we
                                        // were away is gone; the renderer must
                                        // re-read rather than carry the gap.
                                        tracing::info!(
                                            target: "atlas_artifacts",
                                            "{}: reconnected with a subscription; asking for a resync",
                                            key.1
                                        );
                                        let _ = manager.events.send(ArtifactsEvent::Resync);
                                    }
                                }
                                backoff = cfg.backoff_min;
                                remint_used = false;
                                manager.apply(&key, *frame);
                            }
                            Some(ConnEvent::Closed(reason)) => {
                                exit = reason;
                                break;
                            }
                            None => break,
                        },
                    }
                }

                // Dropping the slot's sender is what makes a still-open socket
                // close politely: `run` sees its outbound end and sends Close.
                manager.release_outbound(&key, epoch);
                let _ = dial.await;

                if stopping || stopped(&stop_rx) {
                    tracing::info!(target: "atlas_artifacts", "{}: socket stopped", key.1);
                    return;
                }
                attempts += 1;

                match exit {
                    ExitReason::Revoked => {
                        manager.retire(&key, epoch);
                        manager.board.forget_project(&key);
                        let _ = manager.events.send(ArtifactsEvent::Revoked { key: key.clone() });
                        return;
                    }
                    ExitReason::Forbidden => {
                        tracing::warn!(
                            target: "atlas_artifacts",
                            "{}: not a member; retiring the socket until the next retarget",
                            key.1
                        );
                        manager.retire(&key, epoch);
                        manager.board.forget_project(&key);
                        return;
                    }
                    ExitReason::Unauthorized if !remint_used => {
                        // Round again with a fresh token, after a breath.
                        remint_used = true;
                        if !sleep_or_stop(&mut stop_rx, cfg.remint_delay).await {
                            return;
                        }
                        continue;
                    }
                    ExitReason::Transport(ref reason) if reason == socket::IDLE_EXIT => {
                        tracing::info!(target: "atlas_artifacts", "{}: idle timeout; redialling", key.1);
                    }
                    _ => {}
                }

                if !sleep_or_stop(&mut stop_rx, backoff).await {
                    return;
                }
                backoff = (backoff * 2).min(cfg.backoff_max);
            }
        });
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

/// Has the slot this supervisor was started for been removed?
fn stopped(stop_rx: &watch::Receiver<()>) -> bool {
    stop_rx.has_changed().is_err()
}

/// Sleep, unless the slot goes away first. `false` means stop.
async fn sleep_or_stop(stop_rx: &mut watch::Receiver<()>, wait: Duration) -> bool {
    tokio::select! {
        _ = tokio::time::sleep(wait) => true,
        _ = stop_rx.changed() => false,
    }
}

#[cfg(test)]
mod tests {
    //! The supervisor against a real loopback WebSocket server, so what is
    //! asserted is what reached the wire and what state the registry ended in.

    use std::future::Future;
    use std::pin::Pin;

    use futures_util::{SinkExt, StreamExt};
    use tokio::net::{TcpListener, TcpStream};
    use tokio::time::timeout;
    use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
    use tokio_tungstenite::tungstenite::http::{HeaderValue, StatusCode};
    use tokio_tungstenite::tungstenite::Message as WsMessage;
    use tokio_tungstenite::WebSocketStream;

    use super::*;

    struct Tok;
    impl TokenSource for Tok {
        fn mint(&self) -> Pin<Box<dyn Future<Output = crate::Result<String>> + Send + '_>> {
            Box::pin(async { Ok("tok".to_string()) })
        }
    }

    #[derive(Clone, Copy)]
    enum Mode {
        /// Handshake, greet with `workspace.hello`, hand the socket over.
        Normal,
        /// Accept TCP and never answer the handshake.
        Silent,
        /// Refuse every handshake with 404.
        Reject404,
    }

    #[allow(clippy::large_enum_variant)]
    enum Accepted {
        Socket(WebSocketStream<TcpStream>),
        /// Held so the peer sees an open TCP connection that never answers.
        Raw(#[allow(dead_code)] TcpStream),
        Refused,
    }

    struct Loopback {
        base: String,
        accepted: mpsc::UnboundedReceiver<Accepted>,
    }

    impl Loopback {
        async fn start(mode: Mode) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind loopback");
            let base = format!("ws://{}", listener.local_addr().unwrap());
            let (tx, rx) = mpsc::unbounded_channel();
            tokio::spawn(async move {
                loop {
                    let Ok((stream, _)) = listener.accept().await else { break };
                    let tx = tx.clone();
                    tokio::spawn(async move {
                        match mode {
                            Mode::Silent => {
                                let _ = tx.send(Accepted::Raw(stream));
                            }
                            Mode::Reject404 => {
                                let _ = tokio_tungstenite::accept_hdr_async(
                                    stream,
                                    |_req: &Request, _res: Response| {
                                        let mut err = ErrorResponse::new(Some("no such workspace".into()));
                                        *err.status_mut() = StatusCode::NOT_FOUND;
                                        Err(err)
                                    },
                                )
                                .await;
                                let _ = tx.send(Accepted::Refused);
                            }
                            Mode::Normal => {
                                let accepted = tokio_tungstenite::accept_hdr_async(
                                    stream,
                                    |_req: &Request, mut res: Response| {
                                        res.headers_mut().insert(
                                            "Sec-WebSocket-Protocol",
                                            HeaderValue::from_static("atlas.v1"),
                                        );
                                        Ok(res)
                                    },
                                )
                                .await;
                                if let Ok(mut ws) = accepted {
                                    let _ = ws
                                        .send(WsMessage::Text(
                                            r#"{"t":"workspace.hello","online":[]}"#.into(),
                                        ))
                                        .await;
                                    let _ = tx.send(Accepted::Socket(ws));
                                }
                            }
                        }
                    });
                }
            });
            Self { base, accepted: rx }
        }

        async fn next(&mut self, within: Duration) -> Accepted {
            timeout(within, self.accepted.recv())
                .await
                .expect("an accept within the window")
                .expect("server alive")
        }

        async fn socket(&mut self, within: Duration) -> WebSocketStream<TcpStream> {
            match self.next(within).await {
                Accepted::Socket(ws) => ws,
                _ => panic!("expected a completed handshake"),
            }
        }

        async fn none(&mut self, within: Duration) {
            assert!(
                timeout(within, self.accepted.recv()).await.is_err(),
                "no accept was expected in this window"
            );
        }
    }

    /// The next text frame, skipping pings and pongs.
    async fn next_text(ws: &mut WebSocketStream<TcpStream>, within: Duration) -> serde_json::Value {
        let deadline = tokio::time::Instant::now() + within;
        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            let msg = timeout(remaining, ws.next()).await.expect("a frame within the window");
            match msg {
                Some(Ok(WsMessage::Text(text))) => return serde_json::from_str(&text).unwrap(),
                Some(Ok(_)) => continue,
                other => panic!("socket ended: {other:?}"),
            }
        }
    }

    async fn next_ping(ws: &mut WebSocketStream<TcpStream>, within: Duration) {
        let deadline = tokio::time::Instant::now() + within;
        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            let msg = timeout(remaining, ws.next()).await.expect("a ping within the window");
            match msg {
                Some(Ok(WsMessage::Ping(_))) => return,
                Some(Ok(_)) => continue,
                other => panic!("socket ended: {other:?}"),
            }
        }
    }

    fn config(base: &str) -> ManagerConfig {
        ManagerConfig {
            backoff_min: Duration::from_millis(50),
            backoff_max: Duration::from_millis(200),
            remint_delay: Duration::from_millis(50),
            keepalive: Keepalive {
                ping: Duration::from_millis(100),
                idle: Duration::from_millis(300),
                dial: Duration::from_millis(300),
            },
            ws_base: Some(base.to_string()),
        }
    }

    fn manager(base: &str) -> Arc<ArtifactsManager> {
        ArtifactsManager::with_config(Arc::new(Tok), Arc::new(CloudBoard::new()), config(base))
    }

    fn key() -> ProjectKey {
        ("org_1".to_string(), "ws_1".to_string())
    }

    const SOON: Duration = Duration::from_secs(2);

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn retarget_twice_with_the_same_set_keeps_the_socket_and_redials_after_a_close() {
        // The bug this crate shipped with: a second retarget with an unchanged
        // set made every live supervisor stale, so the first close was final.
        let mut server = Loopback::start(Mode::Normal).await;
        let manager = manager(&server.base);

        manager.retarget(vec![key()]);
        let mut first = server.socket(SOON).await;
        let epoch = manager.epoch_of(&key()).expect("connected");

        manager.retarget(vec![key()]);
        server.none(Duration::from_millis(200)).await;
        assert_eq!(manager.epoch_of(&key()), Some(epoch), "the live slot was replaced");

        let _ = first.send(WsMessage::Close(None)).await;
        let _second = server.socket(SOON).await;
        assert_eq!(manager.epoch_of(&key()), Some(epoch), "the redial came from a new supervisor");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_subscribe_before_the_socket_exists_is_announced_on_open() {
        let mut server = Loopback::start(Mode::Normal).await;
        let manager = manager(&server.base);

        manager.subscribe_session(&key(), "ses_1");
        assert!(!manager.has_connection(&key()));

        manager.retarget(vec![key()]);
        let mut ws = server.socket(SOON).await;
        let frame = next_text(&mut ws, SOON).await;
        assert_eq!(frame["t"], "session.subscribe");
        assert_eq!(frame["session_id"], "ses_1");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_dropped_socket_reannounces_the_subscription_and_asks_for_a_resync() {
        let mut server = Loopback::start(Mode::Normal).await;
        let manager = manager(&server.base);
        let mut events = manager.subscribe();

        manager.retarget(vec![key()]);
        let mut first = server.socket(SOON).await;
        manager.subscribe_session(&key(), "ses_1");
        assert_eq!(next_text(&mut first, SOON).await["t"], "session.subscribe");
        // A first open is not a reconnect: nothing was missed, nothing to reload.
        assert!(matches!(events.try_recv(), Err(broadcast::error::TryRecvError::Empty)));

        let _ = first.send(WsMessage::Close(None)).await;
        let mut second = server.socket(SOON).await;
        let frame = next_text(&mut second, SOON).await;
        assert_eq!(frame["t"], "session.subscribe");
        assert_eq!(frame["session_id"], "ses_1");

        let event = timeout(SOON, events.recv()).await.expect("an event").expect("channel open");
        assert!(matches!(event, ArtifactsEvent::Resync), "{event:?}");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_ping_goes_out_on_the_interval_and_a_mute_server_is_redialled() {
        let mut server = Loopback::start(Mode::Normal).await;
        let manager = manager(&server.base);

        manager.retarget(vec![key()]);
        let mut ws = server.socket(SOON).await;
        next_ping(&mut ws, Duration::from_millis(500)).await;

        // Stop polling the server side: no pong ever goes back. The client
        // must notice within `idle` and dial again.
        drop(ws);
        let _redial = server.socket(SOON).await;
        assert!(manager.has_connection(&key()));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_handshake_that_never_answers_is_cut_and_redialled() {
        let mut server = Loopback::start(Mode::Silent).await;
        let manager = manager(&server.base);

        manager.retarget(vec![key()]);
        let _first = server.next(SOON).await;
        let _second = server.next(SOON).await;
        assert!(manager.has_connection(&key()));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_404_handshake_retries_and_keeps_the_desired_subscription() {
        let mut server = Loopback::start(Mode::Reject404).await;
        let manager = manager(&server.base);

        manager.subscribe_session(&key(), "ses_1");
        manager.retarget(vec![key()]);
        assert!(matches!(server.next(SOON).await, Accepted::Refused));
        assert!(matches!(server.next(SOON).await, Accepted::Refused));
        assert!(manager.has_connection(&key()), "a 404 retired the Project");
        assert_eq!(manager.desired(&key()).as_deref(), Some("ses_1"));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn retarget_prunes_subscriptions_for_projects_no_longer_wanted() {
        let server = Loopback::start(Mode::Normal).await;
        let manager = manager(&server.base);
        let other = ("org_1".to_string(), "ws_2".to_string());

        manager.subscribe_session(&key(), "ses_1");
        manager.subscribe_session(&other, "ses_2");
        manager.retarget(vec![key()]);
        assert_eq!(manager.desired(&key()).as_deref(), Some("ses_1"));
        assert_eq!(manager.desired(&other), None);

        manager.retarget(vec![]);
        assert_eq!(manager.desired(&key()), None);
        assert!(!manager.has_connection(&key()));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_repeated_subscribe_is_sent_every_time() {
        // The server replaces the subscription idempotently, and the
        // short-circuit this replaces is what turned a reordered unsubscribe
        // into a permanent one.
        let mut server = Loopback::start(Mode::Normal).await;
        let manager = manager(&server.base);

        manager.retarget(vec![key()]);
        let mut ws = server.socket(SOON).await;
        manager.subscribe_session(&key(), "ses_1");
        manager.subscribe_session(&key(), "ses_1");
        assert_eq!(next_text(&mut ws, SOON).await["t"], "session.subscribe");
        assert_eq!(next_text(&mut ws, SOON).await["t"], "session.subscribe");

        manager.unsubscribe_session(&key());
        assert_eq!(next_text(&mut ws, SOON).await["t"], "session.unsubscribe");
        assert_eq!(manager.desired(&key()), None);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn dropping_a_project_closes_its_socket_politely() {
        let mut server = Loopback::start(Mode::Normal).await;
        let manager = manager(&server.base);

        manager.retarget(vec![key()]);
        let mut ws = server.socket(SOON).await;
        manager.retarget(vec![]);

        let deadline = Duration::from_secs(2);
        loop {
            match timeout(deadline, ws.next()).await.expect("a close within the window") {
                Some(Ok(WsMessage::Close(_))) | None => break,
                Some(Ok(_)) => continue,
                Some(Err(_)) => break,
            }
        }
        server.none(Duration::from_millis(300)).await;
        assert!(!manager.has_connection(&key()));
    }
}
