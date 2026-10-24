//! Prompts Atlas sends on its own: a pull request watch waking the session's
//! agent (`pull_request_watch`). Every other prompt starts in the frontend;
//! this is the one that starts in Rust, so it brings its own queue.
//!
//! A wake never cuts into a turn. `AgentHost::send` supersedes a running
//! turn, so a wake that went straight out mid-turn would cancel the agent's
//! work — instead it is **held** here, by session, and sent when the turn
//! ends ([`AgentHost::drain_wakes_later`]), after a short grace so a message
//! the user queued during the turn goes first (the frontend sends its own
//! queue on the turn's falling edge). Several wakes held for one turn go out
//! as one prompt.
//!
//! A session that is not loaded is opened first (`resume_thread`, bounded by
//! [`RESUME_TIMEOUT`]), as the user opening it from the sidebar would.
//!
//! The user's Stop drops whatever is held (`AgentHost::stop`), so the turn it
//! cancels does not hand straight over to a wake.
//!
//! What a wake does once it goes — the transcript row, the books, the turn —
//! is the [`WakeDelivery`] the app installs (`agents.rs`): this module only
//! decides when.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use atlas_agent_wire::ErrorClass;
use atlas_thread_metadata::ThreadId;

use super::{lock, AgentHost, HostError, Result, SessionKey};

/// How long a session must have been idle after its turn before a held wake
/// goes: long enough for the frontend to send a message the user queued
/// during the turn, which then holds the wake for its own turn.
pub(crate) const WAKE_GRACE: Duration = Duration::from_millis(1_500);

/// How long a wake may spend opening a session that is not loaded — starting
/// its agent included (ADR-0008).
pub(crate) const RESUME_TIMEOUT: Duration = Duration::from_secs(90);

/// A prompt Atlas sends to a session's agent on its own.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingWake {
    /// The session, by its history row.
    pub thread_id: ThreadId,
    /// What the agent is told.
    pub text: String,
    /// One line for the transcript row and the notification
    /// (`#12: checks failed`).
    pub summary: String,
}

impl PendingWake {
    /// Several wakes held for one turn, as the one prompt they go out as.
    pub fn merged(mut wakes: Vec<PendingWake>) -> Option<PendingWake> {
        if wakes.len() <= 1 {
            return wakes.pop();
        }
        let thread_id = wakes[0].thread_id;
        let text = wakes
            .iter()
            .map(|w| w.text.as_str())
            .collect::<Vec<_>>()
            .join("\n\n");
        let summary = wakes
            .iter()
            .map(|w| w.summary.as_str())
            .collect::<Vec<_>>()
            .join("; ");
        Some(PendingWake {
            thread_id,
            text,
            summary,
        })
    }
}

/// Sends a wake into a live session: the app's half (`agents.rs`).
pub type WakeDelivery =
    Arc<dyn Fn(&SessionKey, &PendingWake) -> std::result::Result<(), String> + Send + Sync>;

/// What became of a wake.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WakeOutcome {
    /// It went out as a turn.
    Sent,
    /// The session was busy; it goes when the turn ends.
    Held,
}

/// The held wakes, by session id, and where they are delivered.
#[derive(Default)]
pub(super) struct Wakes {
    held: Mutex<HashMap<String, Vec<PendingWake>>>,
    delivery: Mutex<Option<WakeDelivery>>,
}

impl Wakes {
    /// Offer `wake` to `session_id`. Held while `busy`; otherwise it goes now,
    /// with anything still held ahead of it (answered, in order).
    pub(super) fn offer(
        &self,
        session_id: &str,
        wake: PendingWake,
        busy: bool,
    ) -> Option<Vec<PendingWake>> {
        let mut held = lock(&self.held);
        if busy {
            held.entry(session_id.to_owned()).or_default().push(wake);
            return None;
        }
        let mut out = held.remove(session_id).unwrap_or_default();
        out.push(wake);
        Some(out)
    }

    /// Everything held for `session_id`, which is now the caller's to send.
    pub(super) fn take(&self, session_id: &str) -> Vec<PendingWake> {
        lock(&self.held).remove(session_id).unwrap_or_default()
    }

    pub(super) fn has_held(&self, session_id: &str) -> bool {
        lock(&self.held)
            .get(session_id)
            .is_some_and(|w| !w.is_empty())
    }
}

impl AgentHost {
    /// Install what sends a wake into a live session.
    pub fn set_wake_delivery(&self, delivery: WakeDelivery) {
        *lock(&self.wakes.delivery) = Some(delivery);
    }

    /// Wake the session `wake.thread_id`: opened first if it is not loaded,
    /// then sent now, or held until its turn ends.
    pub async fn wake(self: &Arc<Self>, wake: PendingWake) -> Result<WakeOutcome> {
        let resumed = tokio::time::timeout(RESUME_TIMEOUT, self.resume_thread(wake.thread_id))
            .await
            .map_err(|_| {
                HostError::new(
                    "The session took too long to open for a wake.",
                    ErrorClass::Transient,
                )
            })??;
        self.offer_wake(&resumed.key, wake)
    }

    /// [`Self::wake`] into a session already open as `key`.
    pub(crate) fn offer_wake(
        self: &Arc<Self>,
        key: &SessionKey,
        wake: PendingWake,
    ) -> Result<WakeOutcome> {
        let busy = self.session_is_busy(&key.session_id, &self.atlas_activity());
        match self.wakes.offer(&key.session_id, wake, busy) {
            None => Ok(WakeOutcome::Held),
            Some(wakes) => {
                self.deliver_wakes(key, wakes)?;
                Ok(WakeOutcome::Sent)
            }
        }
    }

    /// Drop every wake held for `session_id` (the user stopped it).
    pub(crate) fn forget_wakes(&self, session_id: &str) {
        self.wakes.take(session_id);
    }

    fn deliver_wakes(&self, key: &SessionKey, wakes: Vec<PendingWake>) -> Result<()> {
        let Some(wake) = PendingWake::merged(wakes) else {
            return Ok(());
        };
        let delivery = lock(&self.wakes.delivery)
            .clone()
            .ok_or_else(|| HostError::new("wakes are not wired up", ErrorClass::Fatal))?;
        delivery(key, &wake).map_err(|e| HostError::new(e, ErrorClass::Fatal))
    }

    /// The turn in `session_id` ended: once it has been idle for
    /// [`WAKE_GRACE`], send what is held for it. A session busy again by
    /// then (the user's queued message went first) keeps its wakes for that
    /// turn's end. One closed meanwhile is opened again.
    pub(super) fn drain_wakes_later(self: &Arc<Self>, session_id: &str) {
        if !self.wakes.has_held(session_id) {
            return;
        }
        let this = self.clone();
        let session_id = session_id.to_owned();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(WAKE_GRACE).await;
            if this.session_is_busy(&session_id, &this.atlas_activity()) {
                return;
            }
            let held = this.wakes.take(&session_id);
            let Some(wake) = PendingWake::merged(held) else {
                return;
            };
            let bound = lock(&this.sessions)
                .get(&session_id)
                .map(|record| record.agent.clone());
            let result = match bound {
                Some(agent) => {
                    let key = SessionKey {
                        agent_id: this.handle_for(&agent),
                        session_id: session_id.clone(),
                    };
                    this.offer_wake(&key, wake).map(|_| ())
                }
                None => this.wake(wake).await.map(|_| ()),
            };
            if let Err(e) = result {
                tracing::warn!(error = %e, "a held wake could not be sent");
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wake(text: &str) -> PendingWake {
        PendingWake {
            thread_id: ThreadId::from_uuid(uuid::Uuid::nil()),
            text: text.into(),
            summary: format!("#1: {text}"),
        }
    }

    #[test]
    fn a_wake_into_an_idle_session_goes_at_once() {
        let wakes = Wakes::default();
        assert_eq!(wakes.offer("s1", wake("a"), false), Some(vec![wake("a")]));
        assert!(!wakes.has_held("s1"));
    }

    #[test]
    fn a_wake_into_a_busy_session_waits_for_the_turn_and_keeps_its_order() {
        let wakes = Wakes::default();
        assert_eq!(wakes.offer("s1", wake("a"), true), None);
        assert_eq!(wakes.offer("s1", wake("b"), true), None);
        assert!(wakes.has_held("s1"));
        assert!(!wakes.has_held("s2"));
        // Idle again: everything held goes ahead of the new one.
        assert_eq!(
            wakes.offer("s1", wake("c"), false),
            Some(vec![wake("a"), wake("b"), wake("c")])
        );
        assert!(!wakes.has_held("s1"));
    }

    #[test]
    fn a_stop_drops_what_is_held() {
        let wakes = Wakes::default();
        wakes.offer("s1", wake("a"), true);
        assert_eq!(wakes.take("s1"), vec![wake("a")]);
        assert!(wakes.take("s1").is_empty());
    }

    #[test]
    fn wakes_held_for_one_turn_go_out_as_one_prompt() {
        assert_eq!(PendingWake::merged(vec![]), None);
        assert_eq!(PendingWake::merged(vec![wake("a")]), Some(wake("a")));
        let merged = PendingWake::merged(vec![wake("a"), wake("b")]).unwrap();
        assert_eq!(merged.text, "a\n\nb");
        assert_eq!(merged.summary, "#1: a; #1: b");
    }
}
