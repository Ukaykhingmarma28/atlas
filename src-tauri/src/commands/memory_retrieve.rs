//! Shared memory — retrieval over the project's **memory index** (the same
//! MiniLM vector store the Memory ▸ Graph / Chat features build).
//!
//! `memory_search` on the memory tool server answers from it alongside the
//! record, so every agent that takes the server reaches the long-term index
//! through one tool (ADR-0010: nothing is pushed per turn any more).
//!
//! Retrieval runs through the fused `MemoryEngine` (HNSW + graph) using the
//! single app-wide MiniLM provider held by [`MemoryRegistry`] — the same
//! instance the indexer, graph, query and chat share, so the model is never
//! re-loaded here. **Strictly best-effort**: a missing model, an unbuilt
//! index, or any error is a silent empty result, and the whole call is
//! time-bounded so it can never stall a tool call.

use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, Manager};

use super::memory_indexer::MemoryRegistry;

/// Hard cap on the whole retrieve (embed + search + corpus read).
const RETRIEVE_TIMEOUT_SECS: u64 = 6;

#[derive(Debug, Clone)]
pub struct RetrievedDoc {
    /// The corpus id of the hit (`shared:<kind>:<entry id>` for a promoted
    /// record entry). Carried so `memory_search` can tell a document that came
    /// from a record entry apart from one that did not.
    pub id: String,
    pub title: String,
    pub source: String,
    pub text: String,
}


/// Retrieve up to `top_k` index docs relevant to `query`, via the fused
/// `MemoryEngine`: HNSW (embedding, primary) + graph (down-weighted),
/// RRF-fused and Jaccard-deduped behind the engine. The memory tool server's
/// `memory_search` is its consumer, so it improves every agent.
///
/// Empty on any failure (no model, no engine, timeout) — callers treat empty as
/// "skip". Time-bounded so it can never stall a tool call.
pub async fn retrieve(
    app: &AppHandle,
    project_path: &str,
    query: &str,
    top_k: usize,
) -> Vec<RetrievedDoc> {
    match tokio::time::timeout(
        Duration::from_secs(RETRIEVE_TIMEOUT_SECS),
        retrieve_engine(app, project_path, query, top_k),
    )
    .await
    {
        Ok(docs) => docs,
        Err(_) => {
            tracing::warn!(target: "atlas::shared_memory", "index retrieval exceeded {RETRIEVE_TIMEOUT_SECS}s; skipping");
            Vec::new()
        }
    }
}

/// Engine-backed retrieval: resolve the project's `MemoryEngine` through the
/// registry, take the **read lock**, embed+fuse via [`MemoryEngine::retrieve`]
/// using the registry's **shared** provider, and map `atlas_memory::RetrievedDoc`
/// onto the local [`RetrievedDoc`].
#[expect(
    clippy::await_holding_invalid_type,
    reason = "retrieve borrows out of the guard; try_read (not read().await) is what keeps this non-blocking"
)]
async fn retrieve_engine(
    app: &AppHandle,
    project_path: &str,
    query: &str,
    top_k: usize,
) -> Vec<RetrievedDoc> {
    if query.trim().len() < 4 || top_k == 0 {
        return Vec::new();
    }
    let registry = app.state::<Arc<MemoryRegistry>>();
    // Shared on-device provider (loaded once, reused by the indexer). Absent until
    // the MiniLM model is downloaded → nothing to retrieve, skip silently.
    let Some(provider) = registry.provider(app).await else {
        return Vec::new();
    };
    let engine = registry.engine_for(project_path);
    // try_read, never read().await: the indexer holds the WRITE lock for the
    // whole of a re-embed pass, and a big working-tree churn keeps it busy for
    // minutes. Queueing a tool call behind indexing turned "agent is thinking"
    // into a flat 6s stall (the timeout) while the index was warm. Busy index
    // ⇒ the search answers from the record alone this time.
    let Ok(guard) = engine.try_read() else {
        tracing::debug!(
            target: "atlas::shared_memory",
            "memory index busy (indexer holds the write lock) — memory_search skips the index"
        );
        return Vec::new();
    };
    let docs = guard.retrieve(query, top_k, &provider).await;
    drop(guard);

    docs.into_iter()
        .map(|d| RetrievedDoc {
            id: d.id,
            title: d.title,
            source: d.source,
            text: d.text,
        })
        .collect()
}


/// How long `memory_forget` will wait for the index write lock before giving
/// up on evicting the document itself.
const EVICT_LOCK_TIMEOUT_SECS: u64 = 2;

/// Drop one document from the project's index, now rather than at the next
/// whole-corpus pass.
///
/// `memory_forget` calls this so that `{"forgotten": true}` is true of the
/// index as well as the record. Bounded for the same reason retrieval is: the
/// indexer holds the WRITE lock for an entire re-embed pass, and a tool call
/// must not queue behind one. A miss is recoverable — `memory_search` drops a
/// forgotten entry's document at read time, and the next pass removes it for
/// good — so waiting indefinitely would trade bounded staleness for an
/// unbounded stall.
///
/// Returns whether the document was actually removed.
pub async fn evict_doc(app: &AppHandle, project_path: &str, doc_id: &str) -> bool {
    let registry = app.state::<Arc<MemoryRegistry>>();
    let engine = registry.engine_for(project_path);
    let Ok(mut guard) = tokio::time::timeout(
        Duration::from_secs(EVICT_LOCK_TIMEOUT_SECS),
        engine.write(),
    )
    .await
    else {
        tracing::warn!(
            target: "atlas::shared_memory",
            doc_id,
            "memory index busy — asking for a reindex instead of evicting"
        );
        // Self-heal: a pass that re-gathers the corpus will not find the
        // deleted entry and will drop its document, so the window closes
        // without anyone having to notice the eviction was skipped.
        registry.enqueue_index(project_path);
        return false;
    };
    match guard.evict(doc_id) {
        Ok(removed) => removed,
        Err(e) => {
            tracing::warn!(target: "atlas::shared_memory", doc_id, "evict failed: {e:#}");
            drop(guard);
            registry.enqueue_index(project_path);
            false
        }
    }
}
