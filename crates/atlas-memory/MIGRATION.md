# `atlas-memory` — Migration & Operations

How Atlas's RAG/memory moved from the in-Tauri **brute-force O(n) cosine** over a
flat `memory-index/index.json` to the on-device **MiniLM → usearch HNSW + grafeo
graph** engine in this crate. Covers the on-disk layout, the legacy migration,
the feature flags, the rollback that remains, and the **manual** runtime
verification.

Background: the originating plan and seam spec lived under the Cersei SDK path
and were deleted with it (#54). The seam as it stands today is below.

> **The seam.** Every agent retrieves through `memory_retrieve::retrieve(app,
> cwd, query, limit)` in `src-tauri`, which takes **no agent-type parameter**,
> so the path is agent-agnostic by construction. The native agent reaches it
> through its `search_memory` dynamic tool (the `MemorySearch` callback
> installed with `atlas_native_agent::engine::memory::register_search`, returning
> `MemDoc { title, source, text }`); every agent, ACP agents included, also gets
> the pushed `--- RELEVANT PROJECT MEMORY ---` block on send when memory sharing
> is enabled for the project. `atlas-memory` has **no Tauri** dependency and
> depends on no agent crate.

---

## 1. On-disk layout

### Per-project — `<project>/.atlas/memory/`

| Path | Written by | Purpose |
|---|---|---|
| `hnsw.usearch` | `HnswStore::save` | Persistent usearch HNSW index (384-d MiniLM vectors, cosine). |
| `manifest.json` | `Manifest::save` | `{ provider_name, dim, next_key, entries[] }`. Holds the `id ↔ u64 key` bimap and per-doc `content_hash` so an unchanged doc is never re-embedded. **Supersedes** the legacy `index.json`. Atomic write (temp + rename). |
| `docstore.json` | `DocStore::save` | `id → { title, source, text }` side-map so retrieval renders docs without re-gathering the corpus. |
| `graph/` | `GraphMemory::open` (Grafeo LPG) | Per-project graph memory: structured facts, topic tags, `link_memories` edges. Falls back to in-memory if the dir can't open (non-fatal — empty until extraction runs). |
| `extracted/*.md` | `extract.rs` | One markdown file per session of gated native session-extraction output (memdir). Also embedded into HNSW. |
| `.shared-memory-imported` | `shared_import.rs` | Idempotency marker: the one-time fold of legacy `.atlas/shared-memory/events.jsonl` into the graph is done. |
| `.consolidation_lock`, `.consolidation_state.json` | `dream::AutoDream` | AutoDream consolidation lock (stale after 3600s) + state (gate timestamps/session counts). |

### Global (cross-project) — `~/.atlas/memory/`

| Path | Purpose |
|---|---|
| `global-graph/` | Global Grafeo graph that outlives any single project. |
| `MEMORY.md` | Human-readable global memory digest. Kept **< 200 lines** (oldest bullets trimmed); the AutoDream "Prune" target. |
| `global-candidates.json` | Promotion ledger — tracks which memories have been seen, in which projects, and whether they've been promoted. |

The global dir resolves to `~/.atlas/memory/` by default, or the
`ATLAS_GLOBAL_MEMORY_DIR` override (see §3).

---

## 2. Legacy `index.json` → HNSW migration

On the **first** `MemoryEngine::open` of a project that has a legacy
`<project>/.atlas/memory-index/index.json` (a flat `{ model, dim, docs:[{id,hash,vector}] }`):

1. If `model == all-MiniLM-L6-v2 && dim == 384` (the same on-device model),
   the stored vectors are imported **directly into HNSW with zero re-embedding** —
   `u64` keys are assigned via the manifest bimap and `manifest.json` is written.
2. The original file is **archived to `index.json.bak`** (archive, never `rm`).
3. A model/dim mismatch leaves the legacy file in place and schedules a full
   rebuild instead (it cannot mix 384-d and other-dim vectors).

Migration is **idempotent**: once archived, every later open is a no-op, and the
first background `IndexCorpus` pass diffs against the migrated manifest so only
genuinely new docs are embedded.

The same `open` then runs a one-time **shared-memory import**: legacy
`.atlas/shared-memory/events.jsonl` (decisions/constraints/facts) is folded into
the graph, guarded by the `.shared-memory-imported` marker; the original log is
kept readable for one release for rollback.

---

## 3. Feature flags & env overrides

| Env var | Default | Effect |
|---|---|---|
| `ATLAS_NATIVE_EXTRACTION` | **OFF** | A/B gate for native session extraction (see below). |
| `ATLAS_GLOBAL_MEMORY_DIR` | unset → `~/.atlas/memory/` | Overrides the global memory dir. Used by tests so they never touch the real home dir. |
| `ATLAS_MINILM_DIR` | unset | Points tests at an installed MiniLM model dir (contains `model.safetensors`). Model-gated tests are `#[ignore = "needs ATLAS_MINILM_DIR"]`; run them with `-- --ignored`. They never download a model. |

### `ATLAS_NATIVE_EXTRACTION` (default OFF) — the A/B plan

Accepted truthy values: `1` / `true` / `on` / `yes` (case-insensitive).

- **OFF (default).** On `TurnFinished`, Atlas runs the legacy
  `memory_compile::compile_finished_turn` per-turn BYOK distill (itself a no-op
  unless the project's summarizer is a BYOK provider). This is the validated
  write-side path.
- **ON.** `TurnFinished` instead enqueues `Job::ExtractSession{cwd, agent, session}`
  into the background `MemoryIndexer` for **every** agent. The gates
  (`should_extract`: ≥20 msgs / ≥3 tool calls / no pending tool_use) decide whether
  to run; on pass, ONE BYOK call (off the hot path) distills the format-neutral
  transcript into `extracted/*.md` + graph nodes, then re-embeds into HNSW.

**A/B plan:** run with the flag ON on a few real sessions per agent, compare the
extracted memories against the `memory_compile` output, and only once the native
path is confirmed at least as good flip it on permanently.

**Deferred `memory_compile` removal:** `memory_compile`'s BYOK round-trip is
**intentionally retained** until the A/B validates the native path. Its removal is
the deferred Step-8 cleanup, gated on that validation — do not delete it as part of
this migration.

---

## 4. What remains for rollback

The pre-HNSW brute-force retrieval (`memory_retrieve::retrieve_brute_force`)
has been deleted; HNSW is the only retrieval path and there is no switch back.
What remains:

- **`memory_compile`** — the legacy write-side distill, still live whenever
  `ATLAS_NATIVE_EXTRACTION` is OFF (the default).
- **Archived legacy data** — `index.json.bak` and the original
  `shared-memory/events.jsonl` remain on disk; restore by un-archiving.

The micro-benchmark `bench_hnsw_vs_brute_force` (in `atlas-memory`'s
`parity_bench` module, `#[ignore]`d; run with `--ignored --nocapture`) measured
HNSW at roughly **two orders of magnitude** faster per query than a brute-force
cosine on a few-thousand-vector corpus.

---

## 5. MANUAL runtime verification

The offline parity tests (`atlas-memory`'s `parity_bench` module) prove the
retrieval path is agent-agnostic and that `RetrievedDoc` maps cleanly onto
`MemDoc`. They do **not** exercise the live app, real API keys, or the loaded
MiniLM model. That last mile is a **manual** runtime check:

**Prerequisites**
- The MiniLM model installed (so `register_memory_search`'s provider resolves).
- Credentials configured for each agent you test.
- A project with some indexed memory (open it and let the `MemoryIndexer` run, or
  call the `force_reindex` command once).

**Steps — repeat for the native agent and at least one ACP agent**
1. `bun run dev:app` and open the test project, with memory sharing enabled.
2. Confirm the background indexer built the index: `<project>/.atlas/memory/hnsw.usearch`
   and `manifest.json` exist and `manifest.json`'s `entries[]` is non-empty.
3. **Any agent** (push): start a chat turn whose message references known
   project memory (e.g. an established convention). Verify the forwarded prompt
   contains a `--- RELEVANT PROJECT MEMORY ---` block with on-topic snippets.
4. **Native agent** (pull / `search_memory` tool): ask a question that should
   trigger the tool ("what auth strategy does this project use?"). Verify the
   agent invokes `search_memory` and the returned `## title (source)` snippets
   are on-topic.
5. Confirm **identical grounding** across agents — same project + query should
   surface the same underlying docs (the retrieval is shared), differing only in
   push-vs-pull presentation.
6. Flip `ATLAS_NATIVE_EXTRACTION=1`, run a long enough session per agent to pass the
   gates (≥20 msgs / ≥3 tool calls), and confirm `extracted/*.md` appears and the
   new memories become retrievable **without a manual rebuild** (the old
   "invisible until rebuild" bug is gone).

If any agent loses grounding, file the discrepancy before removing any legacy
path in §4.
