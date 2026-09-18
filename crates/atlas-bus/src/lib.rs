//! atlas-bus — the global event broadcaster + middleware pipeline seam for the
//! Atlas agent subsystem.
//!
//! Two cross-cutting abstractions, both generic (no dependency on any agent /
//! ACP domain type, so they stay reusable and cheap to test):
//!
//! - [`EventBus`] — a cloneable `tokio::sync::broadcast` fan-out. Every emitted
//!   agent event is published here; the Tauri window-emitter subscribes today,
//!   and a cloud streamer can subscribe tomorrow with zero changes to the
//!   producers. Lagging subscribers drop (never block the producer).
//! - [`OutboundPipeline`] — an ordered chain of [`OutboundMiddleware`] that
//!   observes every emitted event (broadcast, telemetry, memory-ingest). The
//!   concrete middleware live in the host; this crate only owns the plumbing.

mod bus;
mod middleware;

pub use bus::EventBus;
pub use middleware::{OutboundMiddleware, OutboundPipeline};
