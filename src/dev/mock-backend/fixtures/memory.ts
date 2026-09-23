// The Memory tab: Graph / Tree, Policy and Shared.
//
// Every one of its three views is gated on something expensive that a browser
// cannot have — a 90 MB on-device embedding model, a built vector index, a
// per-project event log — so without fakes the whole tab is three different
// empty states. The fakes here put it on the far side of all three gates: the
// model reads as downloaded, the index as built over the fake `acme-app` tree,
// and the shared log as a project two agents have been working in for a
// fortnight.
//
// A graph node id IS a corpus doc id (`claude:<file>.md`, `codex:<thread>`,
// `kb:<note>`, `shared:<kind>:<seq>`) — search maps `memory_index_query` hits
// back through them, so a mismatch shows as a search that finds nothing.
//
// Writes are kept for the session: appending an event, clearing a project,
// editing a policy value, toggling sharing, moving a node and re-indexing all
// survive until reload, so those controls do something.

import { emit } from "@tauri-apps/api/event";
import type {
  MemoryEdge,
  GraphLayout,
  MemoryGraphData,
  MemoryNode,
} from "@/features/memory/components/memory-graph-canvas";
import type {
  DownloadDone,
  DownloadProgress,
  EmbedStatus,
  QueryHit,
} from "@/features/memory/lib/memory-graph-api";
import type { Policy } from "@/features/memory/lib/memory-policy-api";
import type { SummarizerPref } from "@/features/memory/lib/memory-sharing-api";
import type { EventKind, MemoryEvent, SharedState } from "@/features/memory/lib/shared-memory-api";
import type { TypedHandlers, Unit, Unread } from "../types";
import { fileText } from "./files";
import { ALL_PROJECTS, MOCK_PROJECT } from "../project";

/** Fixed "now" so every seeded timestamp is stable between reloads. */
const NOW = Date.parse("2026-09-18T11:30:00Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Minutes before the fixed now, as the unix-ms Rust sends. */
const ago = (minutes: number) => NOW - minutes * MIN;

/** Rust's `snippet()`: whitespace collapsed, 240 chars, then an ellipsis. */
function snip(text: string): string {
  const one = text.split(/\s+/).filter(Boolean).join(" ");
  return one.length > 240 ? `${one.slice(0, 240)}…` : one;
}

/**
 * A quote from a real file in the seeded tree, so a memory cites code the user
 * can open in the editor tab next to it. Keyed off a marker rather than a line
 * number — `fixtures/files.ts` is edited far more often than this file.
 */
function quoteAfter(rel: string, marker: string, lines = 6): string {
  const all = fileText(rel).split("\n");
  const at = all.findIndex((line) => line.includes(marker));
  return snip((at === -1 ? all : all.slice(at, at + lines)).join(" "));
}

// The fake home: Claude keeps per-project memory under the slugified cwd
// (`agent_memory.rs::encode_project_dir` — every `/` becomes `-`).
const HOME = "/Users/dev";
const CLAUDE_MEM = `${HOME}/.claude/projects/${MOCK_PROJECT.path.replace(/\//g, "-")}/memory`;

// ── Embedding model ─────────────────────────────────────────────────────────

/**
 * Downloaded and ready, which is the only state where the Graph, Tree and
 * Policy views render anything at all.
 *
 * To see the gates instead: set `MODEL_READY` to false and the Graph tab opens
 * on "Enable semantic memory" and Policy on "Enable preference learning".
 * Pressing Download then
 * streams a fake progress bar through `atlas:memory-embed:*`; flip
 * `DOWNLOAD_FAILS` to land on the "Model download failed" retry screen instead.
 */
let MODEL_READY = true;
const DOWNLOAD_FAILS = false;

const MODEL_ID = "all-MiniLM-L6-v2";
/** The three files `memory_graph.rs::MODEL_FILES` checks for, with real sizes. */
const MODEL_FILES: [string, number][] = [
  ["config.json", 612],
  ["tokenizer.json", 695_000],
  ["model.safetensors", 90_900_000],
];

/** Stream the download the way Rust does: throttled progress, then one done. */
function streamModelDownload(): void {
  const steps: DownloadProgress[] = [];
  MODEL_FILES.forEach(([file, total], fileIndex) => {
    for (let part = 1; part <= 4; part++) {
      steps.push({
        file,
        file_index: fileIndex,
        file_count: MODEL_FILES.length,
        received: Math.round((total * part) / 4),
        total,
      });
    }
  });

  let at = 0;
  const timer = setInterval(() => {
    if (at < steps.length) {
      void emit("atlas:memory-embed:progress", steps[at++]);
      return;
    }
    clearInterval(timer);
    const done: DownloadDone = DOWNLOAD_FAILS
      ? { success: false, error: "connection reset while fetching model.safetensors" }
      : { success: true, error: null };
    if (done.success) MODEL_READY = true;
    void emit("atlas:memory-embed:done", done);
  }, 120);
}

// ── Corpus / graph ──────────────────────────────────────────────────────────

type NodeSeed = [
  id: string,
  title: string,
  summary: string,
  kind: string,
  source: string,
  minutesAgo: number,
  snippet: string,
];

/**
 * 26 memories across every source the corpus flattens (`agent_memory.rs`):
 * Claude's per-project memory files, both CLAUDE.md instruction docs, Codex
 * threads, knowledge-base notes and shared-memory events. The `kind` spread is
 * deliberate — the Tree view has a named branch for project / feedback / user /
 * reference / instruction / thread / index / memory and falls back to a
 * capitalised label for anything else, which `note` and `decision` exercise.
 */
const NODE_SEEDS: NodeSeed[] = [
  [
    "claude:MEMORY.md",
    "Memory Index",
    "Index of every project memory",
    "index",
    "claude",
    18 * 60,
    "Index of every project memory. [[project_stack]] [[user_commit_style]] [[feedback_no_hex]] [[ref_api_surface]]",
  ],
  [
    "claude:project_stack.md",
    "project_stack",
    "Bun + Vite + React 19 in front of a Hono API on Fly",
    "project",
    "claude",
    14 * 24 * 60,
    "The app is Bun + Vite + React 19; the API is Hono on Fly.io with Postgres 16 and Redis for sessions. Package scripts are bun-only — never generate npm or pnpm invocations.",
  ],
  [
    "claude:project_conventions.md",
    "project_conventions",
    "Zod schemas are the source of truth for API types",
    "project",
    "claude",
    11 * 24 * 60,
    quoteAfter("README.md", "zod", 4),
  ],
  [
    "claude:feedback_no_hex.md",
    "feedback_no_hex",
    "Never hardcode a hex colour; every colour is a token",
    "feedback",
    "claude",
    3 * 24 * 60,
    quoteAfter("src/styles/tokens.css", "--accent", 5),
  ],
  [
    "claude:feedback_retry_only_5xx.md",
    "feedback_retry_only_5xx",
    "Retry 5xx and network errors only — never a 4xx",
    "feedback",
    "claude",
    2 * 24 * 60 + 40,
    quoteAfter("src/lib/api.ts", "withRetry", 8),
  ],
  [
    "claude:feedback_v2_endpoints.md",
    "feedback_v2_endpoints",
    "User reads move to /v2 — check the README note first",
    "feedback",
    "claude",
    26 * 60,
    quoteAfter("README.md", "/v2/users", 4),
  ],
  [
    "claude:feedback_no_console.md",
    "feedback_no_console",
    "No console.log in committed code — use the logger",
    "feedback",
    "claude",
    6 * 24 * 60,
    "No console.log in committed code. The app ships a logger that redacts customer identifiers; a bare console statement bypasses it and has twice leaked an email into a support bundle.",
  ],
  [
    "claude:user_commit_style.md",
    "user_commit_style",
    "Conventional commits, imperative subject, no attribution footer",
    "user",
    "claude",
    5 * 24 * 60,
    "Conventional commit prefixes (feat/fix/chore/docs), imperative subject under 72 chars, no trailing attribution footer of any kind.",
  ],
  [
    "claude:user_theme.md",
    "user_theme",
    "Dark mode always, including in screenshots",
    "user",
    "claude",
    9 * 24 * 60,
    "Dark mode always. Screenshots for issues and PRs should be taken in the dark theme so the token values under review are the ones people actually see.",
  ],
  [
    "claude:user_package_manager.md",
    "user_package_manager",
    "bun, never npm or pnpm",
    "user",
    "claude",
    12 * 24 * 60,
    "Always use bun. `bun install`, `bun run <script>`, `bunx`. npm and pnpm lockfiles must never appear in the tree.",
  ],
  [
    "claude:user_tests.md",
    "user_tests",
    "Write the failing test first, then the fix",
    "user",
    "claude",
    7 * 24 * 60,
    "Write the failing test first, then the fix. A bug fix without a regression test gets sent back in review.",
  ],
  [
    "claude:ref_api_surface.md",
    "ref_api_surface",
    "The four calls the API client exposes",
    "reference",
    "claude",
    4 * 24 * 60,
    quoteAfter("src/lib/api.ts", "export const api", 7),
  ],
  [
    "claude:ref_token_scale.md",
    "ref_token_scale",
    "Radius and font tokens, and the light-mode overrides",
    "reference",
    "claude",
    8 * 24 * 60,
    quoteAfter("src/styles/tokens.css", "--radius-sm", 6),
  ],
  [
    "claude:memory_scratch.md",
    "memory_scratch",
    "Scratch notes from the /v2 migration spike",
    // Empty `kind` in the file falls back to "memory" — the Tree's last branch.
    "memory",
    "claude",
    31 * 60,
    "Scratch: the /v2 user reads need the plan column, the admin table paginates at 50, and the focus refetch has to go before any of it lands.",
  ],
  [
    "claude:CLAUDE.md",
    "CLAUDE.md",
    "Project instructions for agents",
    "instruction",
    "claude",
    2 * 24 * 60,
    "Project instructions for agents: bun only, zod schemas are the source of truth, colours come from tokens.css, tests before fixes.",
  ],
  [
    "claude:CLAUDE.md@global",
    "CLAUDE.md (global)",
    "Global agent instructions",
    "instruction",
    "claude",
    40 * 24 * 60,
    "Global instructions: be concise, never add an attribution footer to a commit, ask before adding a dependency.",
  ],
  [
    "codex:AGENTS.md",
    "AGENTS.md",
    "Project instructions for Codex",
    "instruction",
    "codex",
    2 * 24 * 60 + 90,
    "Project instructions for Codex. Mirrors CLAUDE.md; kept in sync by hand, which is why the two drift.",
  ],
  [
    "codex:0193f1a2-6c44-7b1e-9f00-2a5d8e4c1001",
    "Switch the API client to the v2 user endpoints",
    "Switch the API client to the v2 user endpoints",
    "thread",
    "codex",
    22 * 60,
    "Switch the API client to the v2 user endpoints without changing the call signatures, and keep withRetry's 4xx behaviour.",
  ],
  [
    "codex:0193f1a2-6c44-7b1e-9f00-2a5d8e4c1002",
    "Why does the admin table refetch on window focus",
    "Why does the admin table refetch on window focus",
    "thread",
    "codex",
    3 * 24 * 60 + 200,
    "Why does the admin table refetch every time the window regains focus, and what is the least invasive way to stop it?",
  ],
  [
    "codex:0193f1a2-6c44-7b1e-9f00-2a5d8e4c1003",
    "Regenerate the palette after the design-token bump and reconcile every surface that still reads a raw hex",
    "Regenerate the palette after the design-token bump and reconcile every surface that still reads a raw hex",
    "thread",
    "codex",
    5 * 24 * 60,
    "Regenerate the palette after the design-token bump and reconcile every surface that still reads a raw hex value instead of a token, including the two that only appear in the light-mode media query.",
  ],
  [
    "kb:architecture/overview",
    "Architecture overview",
    "How web, api and worker fit together",
    "note",
    "note",
    45,
    "acme-app is a Next.js front end talking to a Hono API, backed by Postgres and a Redis cache. See [[architecture/auth-flow]].",
  ],
  [
    "kb:guides/debugging-guide",
    "Debugging guide",
    "Where to look, in order, when production is wrong",
    "note",
    "note",
    20,
    "Where to look, in order, when something is wrong in production: is it deployed, what do the traces say, then the two failures that keep recurring.",
  ],
  [
    "kb:decisions/adr-002-edge-caching",
    "ADR 002: Edge caching",
    "Cache catalog reads for 5 minutes at the edge",
    "note",
    "note",
    2 * 24 * 60,
    "Cache GET /catalog/* for 5 minutes at the edge with surrogate keys, purged on write. Open question: per-org price overrides.",
  ],
  [
    "shared:decision:14",
    "Keep withRetry's 4xx passthrough",
    "Keep withRetry's 4xx passthrough",
    "decision",
    "shared",
    90,
    "Keep withRetry's 4xx passthrough when moving to /v2: a 409 from the new endpoint is a real conflict, not a transient error.",
  ],
  [
    "shared:fact:9",
    "Staging seeds 200 users and 3 orgs",
    "Staging seeds 200 users and 3 orgs",
    "fact",
    "shared",
    5 * 60,
    "Staging seeds 200 users across 3 orgs; the pagination bug only reproduces past page 3.",
  ],
  [
    "claude:feedback_legacy_auth.md",
    "feedback_legacy_auth",
    "src/legacy/auth.ts is deleted — stop trying to read it",
    "feedback",
    "claude",
    // A memory whose file mtime could not be read: Rust sends 0, and the
    // temporal scrubber has to treat that as "unknown", not as 1970.
    0,
    "src/legacy/auth.ts was deleted in 2c3d4e5. Tool calls that try to read it fail with ENOENT; the replacement lives in src/lib/api.ts.",
  ],
];

/** `[from, to, kind]`, authored oldest-first; `kind: "link"` is a wikilink and
 *  is what the Tree view nests on (similarity edges never nest). */
const EDGE_SEEDS: [string, string, string][] = [
  ["claude:MEMORY.md", "claude:project_stack.md", "link"],
  ["claude:MEMORY.md", "claude:user_commit_style.md", "link"],
  ["claude:MEMORY.md", "claude:feedback_no_hex.md", "link"],
  ["claude:MEMORY.md", "claude:ref_api_surface.md", "link"],
  ["claude:CLAUDE.md", "claude:project_conventions.md", "link"],
  ["claude:CLAUDE.md", "claude:feedback_no_console.md", "link"],
  ["claude:ref_api_surface.md", "claude:feedback_retry_only_5xx.md", "link"],
  ["claude:feedback_retry_only_5xx.md", "shared:decision:14", "link"],
  ["claude:feedback_v2_endpoints.md", "claude:memory_scratch.md", "link"],
  ["kb:architecture/overview", "kb:decisions/adr-002-edge-caching", "link"],
  ["kb:architecture/overview", "kb:guides/debugging-guide", "link"],
  ["claude:project_stack.md", "claude:user_package_manager.md", "similarity"],
  ["claude:project_stack.md", "codex:AGENTS.md", "similarity"],
  ["claude:CLAUDE.md", "codex:AGENTS.md", "similarity"],
  ["claude:CLAUDE.md@global", "claude:user_commit_style.md", "similarity"],
  ["claude:feedback_no_hex.md", "claude:ref_token_scale.md", "similarity"],
  ["claude:feedback_no_hex.md", "codex:0193f1a2-6c44-7b1e-9f00-2a5d8e4c1003", "similarity"],
  ["claude:ref_token_scale.md", "codex:0193f1a2-6c44-7b1e-9f00-2a5d8e4c1003", "similarity"],
  ["claude:ref_api_surface.md", "codex:0193f1a2-6c44-7b1e-9f00-2a5d8e4c1001", "similarity"],
  ["claude:feedback_v2_endpoints.md", "codex:0193f1a2-6c44-7b1e-9f00-2a5d8e4c1001", "similarity"],
  ["claude:user_tests.md", "claude:user_commit_style.md", "similarity"],
  ["claude:user_theme.md", "claude:feedback_no_hex.md", "similarity"],
  ["claude:memory_scratch.md", "codex:0193f1a2-6c44-7b1e-9f00-2a5d8e4c1002", "similarity"],
  ["kb:guides/debugging-guide", "claude:feedback_legacy_auth.md", "similarity"],
  ["shared:fact:9", "codex:0193f1a2-6c44-7b1e-9f00-2a5d8e4c1002", "similarity"],
  ["claude:project_conventions.md", "claude:project_stack.md", "similarity"],
];

const nodeTs = new Map(NODE_SEEDS.map((seed) => [seed[0], seed[5] === 0 ? 0 : ago(seed[5])]));

/** Deterministic pseudo-random in [0, 1) from a string — stand-in for the
 *  cosine score `BruteForce::all_pairs_topk` would have produced. */
function hashUnit(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return (h >>> 0) / 0xffffffff;
}

/** Rust orients every edge older → newer so the UI can trace influence
 *  forward in time; unknown timestamps (0) sort oldest. Weight mirrors
 *  `memory_graph.rs`: an explicit `link` is always 1, a `similarity` edge
 *  carries the cosine score that put it above `SIM_THRESHOLD` (0.35). */
function orientedEdges(): MemoryEdge[] {
  return EDGE_SEEDS.map(([a, b, kind]) => {
    const older = (nodeTs.get(a) ?? 0) <= (nodeTs.get(b) ?? 0) ? a : b;
    const newer = older === a ? b : a;
    const weight = kind === "link" ? 1 : 0.35 + hashUnit(a + "|" + b) * 0.6;
    return { from: older, to: newer, weight, kind };
  });
}

function buildGraph(): MemoryGraphData {
  const edges = orientedEdges();
  const degree = new Map<string, number>();
  for (const edge of edges) {
    degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1);
    degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1);
  }
  const nodes: MemoryNode[] = NODE_SEEDS.map(
    ([id, title, summary, kind, source, minutesAgo, snippet]) => ({
      id,
      title,
      summary,
      kind,
      source,
      snippet,
      degree: degree.get(id) ?? 0,
      timestampMs: minutesAgo === 0 ? 0 : ago(minutesAgo),
    }),
  );
  return { nodes, edges };
}

const GRAPH = buildGraph();

/**
 * Nodes the *last* index build picked up. Shared-memory events appended since
 * then are not in it — `memory_index_build` folds them in, so appending an
 * event in the Shared view and then pressing Reindex in the Graph view really
 * does grow the graph, the way the corpus reader does.
 */
let indexedExtraSeqs: number[] = [];

function extraNodes(projectPath: string): MemoryNode[] {
  const events = eventsFor(projectPath);
  return indexedExtraSeqs.flatMap((seq) => {
    const event = events.find((candidate) => candidate.seq === seq);
    if (!event) return [];
    const text = String(event.payload.text ?? event.payload.summary ?? event.key);
    return [
      {
        id: `shared:${event.kind}:${event.seq}`,
        title: snip(text).slice(0, 60),
        summary: snip(text).slice(0, 60),
        kind: event.kind,
        source: "shared",
        snippet: snip(text),
        degree: 0,
        timestampMs: event.ts,
      } satisfies MemoryNode,
    ];
  });
}

function graphFor(projectPath: string): MemoryGraphData {
  // Only the primary project has memory; the other two answer with an empty
  // corpus, which is the "No memory to graph yet." state.
  if (projectPath !== MOCK_PROJECT.path) return { nodes: [], edges: [] };
  return { nodes: [...GRAPH.nodes, ...extraNodes(projectPath)], edges: GRAPH.edges };
}

/**
 * Keyword stand-in for a cosine search. Scores are shaped like MiniLM's: the
 * best match lands in the high 0.7s, the tail trails towards the 0.35 edge
 * where the graph stops drawing a similarity edge at all.
 */
function queryGraph(projectPath: string, query: string, topK: number): QueryHit[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const terms = needle.split(/\s+/).filter((term) => term.length > 2);
  const scored = graphFor(projectPath)
    .nodes.map((node) => {
      const hay = `${node.title} ${node.summary} ${node.kind} ${node.snippet}`.toLowerCase();
      const hits = terms.filter((term) => hay.includes(term)).length;
      return { id: node.id, hits, length: hay.length };
    })
    .filter((row) => row.hits > 0)
    .sort((a, b) => b.hits - a.hits || a.length - b.length);

  return scored
    .slice(0, topK)
    .map((row, index) => ({ id: row.id, score: Number((0.79 - index * 0.031).toFixed(4)) }));
}

// ── Graph layout ────────────────────────────────────────────────────────────

/**
 * A layout somebody has already dragged into shape: kinds cluster in bands, so
 * the canvas opens on something arranged rather than on a force simulation
 * settling. The last three nodes are deliberately absent — an unsaved node has
 * no stored position and has to fall back to the force layout.
 *
 * Rust's `memory_graph_layout_save` is a pure passthrough (`commands/memory_graph.rs`)
 * — it persists whatever px positions the frontend's Matter world already had,
 * which are always canvas-relative (0,0 at the canvas's top-left corner, per
 * `memory-graph-canvas.tsx`'s wall bodies) and therefore always on-screen. A
 * real saved layout can never be centred on (0,0) the way an origin-centred
 * scheme would produce, because nothing in the live simulation would ever push
 * a node to a negative coordinate and leave it there. Band/row offsets here
 * are centred on a nominal on-canvas point instead, so this fake stays a
 * layout the real backend could actually have saved.
 */
function seedLayout(): GraphLayout {
  const bands = ["index", "instruction", "project", "reference", "feedback", "user", "thread"];
  const columns = bands.length + 1; // +1 for the "kind not in `bands`" overflow column
  const CENTER_X = 460;
  const CENTER_Y = 300;
  const COLUMN_W = 100;
  const ROW_H = 65;
  const positions: Record<string, { x: number; y: number }> = {};
  const placed = GRAPH.nodes.slice(0, GRAPH.nodes.length - 3);
  const perBand = new Map<string, number>();
  for (const node of placed) {
    const band = bands.indexOf(node.kind);
    const column = band === -1 ? bands.length : band;
    const row = perBand.get(node.kind) ?? 0;
    perBand.set(node.kind, row + 1);
    positions[node.id] = {
      x: CENTER_X + (column - (columns - 1) / 2) * COLUMN_W,
      y: CENTER_Y + row * ROW_H - 100 + (band % 2) * 25,
    };
  }
  return { positions };
}

const layouts = new Map<string, GraphLayout>([[MOCK_PROJECT.path, seedLayout()]]);

// ── Policy ──────────────────────────────────────────────────────────────────

/**
 * The Policy table has no enabled/disabled flag — a policy is described by
 * three axes the view filters on, and this set covers every combination of
 * them: strong vs soft (a MUST/NEVER rule vs a preference), preference vs
 * codebase (a curated probe match vs a raw feedback memory), and semantic vs
 * keyword (cosine-matched vs listed directly). The two rows sourced from the
 * global `~/.claude/CLAUDE.md` are the inherited ones — same table, a file
 * outside the project.
 */
const POLICY_SEEDS: Policy[] = [
  {
    id: "Version control",
    key: "Version control",
    hint: "Committing, pushing, staging",
    value: "NEVER commit or push; the user drives git themselves.",
    category: "strong",
    origin: "preference",
    match_kind: "semantic",
    source: "claude",
    file_path: `${CLAUDE_MEM}/user_commit_style.md`,
    doc_title: "user_commit_style",
    score: 0.81,
  },
  {
    id: "Package manager",
    key: "Package manager",
    hint: "npm / pnpm / yarn / bun",
    value: "ALWAYS use bun — never npm or pnpm.",
    category: "strong",
    origin: "preference",
    match_kind: "semantic",
    source: "claude",
    file_path: `${CLAUDE_MEM}/user_package_manager.md`,
    doc_title: "user_package_manager",
    score: 0.93,
  },
  {
    id: "Theme",
    key: "Theme",
    hint: "Light or dark appearance",
    value: "Prefers dark mode, including in screenshots attached to reviews.",
    category: "soft",
    origin: "preference",
    match_kind: "semantic",
    source: "claude",
    file_path: `${CLAUDE_MEM}/user_theme.md`,
    doc_title: "user_theme",
    score: 0.64,
  },
  {
    id: "Testing",
    key: "Testing",
    hint: "Running and writing tests",
    value: "Write the failing test first, then the fix.",
    category: "soft",
    origin: "preference",
    match_kind: "semantic",
    source: "claude",
    file_path: `${CLAUDE_MEM}/user_tests.md`,
    doc_title: "user_tests",
    score: 0.72,
  },
  {
    id: "Commit messages",
    key: "Commit messages",
    hint: "Message format",
    value:
      "Conventional prefixes, imperative subject under 72 characters, and NEVER an attribution footer — not a Co-Authored-By line, not a generated-with line, not in an amend or a squash either.",
    // A value long enough to need the inline editor's wrapping and the
    // truncated read-only row above it.
    category: "strong",
    origin: "preference",
    match_kind: "semantic",
    source: "claude",
    file_path: `${HOME}/.claude/CLAUDE.md`,
    doc_title: "CLAUDE.md (global)",
    score: 0.58,
  },
  {
    id: "Communication",
    key: "Communication",
    hint: "Verbosity and tone",
    value: "Be concise; skip the preamble and answer first.",
    category: "soft",
    origin: "preference",
    match_kind: "semantic",
    source: "claude",
    file_path: `${HOME}/.claude/CLAUDE.md`,
    doc_title: "CLAUDE.md (global)",
    score: 0.44,
  },
  {
    id: "Dependencies & files",
    key: "Dependencies & files",
    hint: "Adding deps / new files",
    value: "ALWAYS ask before adding a top-level dependency.",
    category: "strong",
    origin: "preference",
    match_kind: "semantic",
    source: "codex",
    file_path: `${MOCK_PROJECT.path}/AGENTS.md`,
    doc_title: "AGENTS.md",
    score: 0.69,
  },
  {
    id: "Languages & frameworks",
    key: "Languages & frameworks",
    hint: "Preferred stack",
    value: "Bun + Vite + React 19 on the front end; Hono on the API.",
    category: "soft",
    origin: "preference",
    match_kind: "semantic",
    source: "claude",
    file_path: `${CLAUDE_MEM}/project_stack.md`,
    doc_title: "project_stack",
    score: 0.87,
  },
  // ── Behavioral rows: every `feedback` memory, listed directly (score 1.0).
  {
    id: "fb:claude:feedback_no_hex.md",
    key: "feedback_no_hex",
    hint: "Codebase behavior",
    value: "NEVER hardcode a hex colour — every colour is a token in src/styles/tokens.css.",
    category: "strong",
    origin: "codebase",
    match_kind: "keyword",
    source: "claude",
    file_path: `${CLAUDE_MEM}/feedback_no_hex.md`,
    doc_title: "feedback_no_hex",
    score: 1,
  },
  {
    id: "fb:claude:feedback_retry_only_5xx.md",
    key: "feedback_retry_only_5xx",
    hint: "Codebase behavior",
    value: "Retry 5xx and network errors only; a 4xx must propagate untouched.",
    category: "strong",
    origin: "codebase",
    match_kind: "keyword",
    source: "claude",
    file_path: `${CLAUDE_MEM}/feedback_retry_only_5xx.md`,
    doc_title: "feedback_retry_only_5xx",
    score: 1,
  },
  {
    id: "fb:claude:feedback_no_console.md",
    key: "feedback_no_console",
    hint: "Codebase behavior",
    value: "Use the redacting logger instead of console.log in committed code.",
    category: "soft",
    origin: "codebase",
    match_kind: "keyword",
    source: "claude",
    file_path: `${CLAUDE_MEM}/feedback_no_console.md`,
    doc_title: "feedback_no_console",
    score: 1,
  },
  {
    id: "fb:claude:feedback_legacy_auth.md",
    key: "feedback_legacy_auth",
    hint: "Codebase behavior",
    value: "src/legacy/auth.ts is deleted — read src/lib/api.ts instead.",
    category: "soft",
    origin: "codebase",
    match_kind: "keyword",
    source: "claude",
    file_path: `${CLAUDE_MEM}/feedback_legacy_auth.md`,
    doc_title: "feedback_legacy_auth",
    score: 1,
  },
];

/** Edited values live here for the session, so a saved row stays saved across a
 *  sub-tab switch (the policy list is re-fetched on remount). */
const policies: Policy[] = POLICY_SEEDS.map((policy) => ({ ...policy }));

// ── Sharing ─────────────────────────────────────────────────────────────────

/**
 * Sharing is per project, so the switcher has one shared project and two
 * private ones — reopening the toggle after switching projects shows a
 * different answer, which is the bug this panel keeps having.
 */
const sharingEnabled = new Map<string, boolean>([
  [MOCK_PROJECT.path, true],
  [ALL_PROJECTS[1].path, false],
  [ALL_PROJECTS[2].path, false],
]);

/** The BYOK summariser, so the provider/model picker opens on a selection
 *  rather than on the default `raw` (which hides the picker entirely). */
const summarizers = new Map<string, SummarizerPref>([
  [MOCK_PROJECT.path, { mode: "provider", provider: "anthropic", model: "claude-sonnet-4-5" }],
  [ALL_PROJECTS[1].path, { mode: "raw", provider: "", model: "" }],
]);

const DEFAULT_SUMMARIZER: SummarizerPref = { mode: "raw", provider: "", model: "" };

// ── Shared cross-agent memory ───────────────────────────────────────────────

type EventSeed = [
  minutesAgo: number,
  agent: string,
  sessionId: string,
  kind: EventKind,
  key: string,
  payload: Record<string, unknown>,
];

const S1 = "0193f0aa-1111-7000-9000-aaaaaaaaaaaa";
const S2 = "0193f0bb-2222-7000-9000-bbbbbbbbbbbb";
const S3 = "0193f0cc-3333-7000-9000-cccccccccccc";
const S4 = "0193f0dd-4444-7000-9000-dddddddddddd";

/**
 * Four sessions over five days, two agents plus one installed from the ACP
 * registry — enough for the view's agent and kind filters to have more than one
 * option each, and for a plan to be superseded twice so the Plans tab shows a
 * history rather than a single row.
 */
const EVENT_SEEDS: EventSeed[] = [
  [(5 * DAY) / MIN, "claude", S1, "session_start", "", { cwd: MOCK_PROJECT.path }],
  [
    (5 * DAY) / MIN - 4,
    "claude",
    S1,
    "plan_set",
    "plan",
    {
      status: "active",
      text: "1. Audit every raw hex in the tree\n2. Map each to a token\n3. Regenerate the palette",
    },
  ],
  [
    (5 * DAY) / MIN - 9,
    "claude",
    S1,
    "file_changed",
    "src/styles/tokens.css",
    { path: "src/styles/tokens.css", summary: "Added the light-mode override block" },
  ],
  [
    (5 * DAY) / MIN - 12,
    "claude",
    S1,
    "decision",
    "colour-source",
    { text: "Tokens are the only colour source; no hex literals in JSX." },
  ],
  [
    (5 * DAY) / MIN - 15,
    "claude",
    S1,
    "architecture",
    "",
    { text: "web holds no state; every write goes through the Hono API." },
  ],
  [
    (5 * DAY) / MIN - 20,
    "claude",
    S1,
    "todo_added",
    "purge-hex",
    { text: "Purge the last 3 hexes" },
  ],
  [
    (5 * DAY) / MIN - 26,
    "claude",
    S1,
    "plan_set",
    "plan",
    { status: "done", text: "Palette regenerated; the last three hexes are gone." },
  ],
  [(5 * DAY) / MIN - 30, "claude", S1, "session_end", "", { turns: 14 }],

  [(3 * DAY) / MIN, "codex", S2, "session_start", "", { cwd: MOCK_PROJECT.path }],
  [
    (3 * DAY) / MIN - 3,
    "codex",
    S2,
    "plan_set",
    "plan",
    {
      status: "active",
      text: "Move user reads onto /v2 without changing any call signature, then re-run the contract tests.",
    },
  ],
  [
    (3 * DAY) / MIN - 11,
    "codex",
    S2,
    "fact",
    "",
    { text: "The /v2 user payload adds `plan` and drops `legacyId`." },
  ],
  [
    (3 * DAY) / MIN - 18,
    "codex",
    S2,
    "decision",
    "retry-policy",
    { text: "Keep withRetry's 4xx passthrough — a 409 from /v2 is a real conflict." },
  ],
  [
    (3 * DAY) / MIN - 20,
    "codex",
    S2,
    "failure",
    "",
    {
      text: "Patching the palette by hand — regenerate from tokens.json instead, the hand edits get clobbered.",
    },
  ],
  [
    (3 * DAY) / MIN - 22,
    "codex",
    S2,
    "architecture",
    "",
    { text: "Sessions are opaque tokens in Redis, keyed by a hash of the cookie value." },
  ],
  [
    (3 * DAY) / MIN - 24,
    "codex",
    S2,
    "file_changed",
    "src/lib/api.ts",
    { path: "src/lib/api.ts", summary: "Repointed getUser/listUsers at /v2" },
  ],
  [
    (3 * DAY) / MIN - 26,
    "codex",
    S2,
    "file_changed",
    "src/lib/utils.ts",
    { path: "src/lib/utils.ts", summary: "timeAgo now takes an explicit `now`" },
  ],
  [(3 * DAY) / MIN - 40, "codex", S2, "todo_done", "purge-hex", { text: "Purge the last 3 hexes" }],
  [(3 * DAY) / MIN - 44, "codex", S2, "session_end", "", { turns: 31 }],

  [(26 * HOUR) / MIN, "opencode", S3, "session_start", "", { cwd: MOCK_PROJECT.path }],
  [
    (26 * HOUR) / MIN - 5,
    "opencode",
    S3,
    "fact",
    "",
    { text: "Staging seeds 200 users across 3 orgs; pagination only breaks past page 3." },
  ],
  [
    (26 * HOUR) / MIN - 14,
    "opencode",
    S3,
    "decision",
    // Same key as the codex row above: the later one supersedes it in the
    // derived view while both stay in the event log.
    "retry-policy",
    { text: "Keep the 4xx passthrough, and log the 409 body before rethrowing." },
  ],
  [
    (26 * HOUR) / MIN - 20,
    "opencode",
    S3,
    "failure",
    "",
    {
      text: "Disabling the focus listener globally broke the session refresh; scope it to the admin table.",
    },
  ],
  [
    (26 * HOUR) / MIN - 30,
    "opencode",
    S3,
    "file_changed",
    "src/components/header.tsx",
    { path: "src/components/header.tsx", summary: "Debounced the search callback" },
  ],
  [(26 * HOUR) / MIN - 55, "opencode", S3, "session_end", "", { turns: 7 }],

  [(4 * HOUR) / MIN, "claude", S4, "session_start", "", { cwd: MOCK_PROJECT.path }],
  [
    (4 * HOUR) / MIN - 2,
    "claude",
    S4,
    "plan_set",
    "plan",
    {
      status: "active",
      text: "1. Reproduce the focus refetch\n2. Find the listener\n3. Add the regression test\n4. Ship behind the flag",
    },
  ],
  [
    (4 * HOUR) / MIN - 8,
    "claude",
    S4,
    "fact",
    "",
    { text: "The refetch comes from the window `focus` listener in main.tsx, not from the query." },
  ],
  [
    (4 * HOUR) / MIN - 15,
    "claude",
    S4,
    "todo_added",
    "focus-test",
    { text: "Regression test for the focus refetch" },
  ],
  // No `text`, no `summary`, no `path`: the Detail column falls back to `key`,
  // and an event with an empty payload has to render as a row all the same.
  [90, "claude", S4, "fact", "reviewer-asked-for-a-test", {}],
];

function seededEvents(): MemoryEvent[] {
  return EVENT_SEEDS.map(([minutesAgo, agent, sessionId, kind, key, payload], index) => ({
    seq: index + 1,
    ts: ago(minutesAgo),
    agent,
    sessionId,
    kind,
    key,
    payload,
  }));
}

const eventLog = new Map<string, MemoryEvent[]>([[MOCK_PROJECT.path, seededEvents()]]);

/** Projects nobody has run an agent in answer with an empty log, which is the
 *  view's "No shared memory yet" state. */
const eventsFor = (projectPath: string): MemoryEvent[] => eventLog.get(projectPath) ?? [];

/** The same fold Rust runs (`shared_memory.rs::SharedState::apply`), so an
 *  appended event changes the derived view and a clear empties it. */
function foldEvents(events: MemoryEvent[]): SharedState {
  const state: SharedState = {
    lastSeq: 0,
    activePlan: null,
    decisions: [],
    recentChanges: [],
    facts: [],
    failures: [],
    architecture: [],
    sessionAgents: {},
    updatedAt: 0,
  };
  for (const event of events) {
    state.lastSeq = Math.max(state.lastSeq, event.seq);
    state.updatedAt = event.ts;
    const text = String(event.payload.text ?? "").trim();
    if (event.kind === "plan_set") {
      const status = String(event.payload.status ?? "active");
      if (status === "done" || status === "abandoned") state.activePlan = null;
      else if (text) state.activePlan = { seq: event.seq, agent: event.agent, text, status };
    } else if (event.kind === "decision" && text) {
      state.decisions = state.decisions.filter(
        (decision) => !(event.key && decision.key === event.key) && decision.text !== text,
      );
      state.decisions.push({ seq: event.seq, agent: event.agent, key: event.key, text });
    } else if (event.kind === "file_changed") {
      const path = String(event.payload.path ?? event.key);
      if (path) {
        state.recentChanges = state.recentChanges.filter((change) => change.path !== path);
        state.recentChanges.push({
          seq: event.seq,
          agent: event.agent,
          path,
          summary: String(event.payload.summary ?? ""),
        });
      }
    } else if (event.kind === "fact" && text) {
      state.facts = state.facts.filter((fact) => fact.text !== text);
      state.facts.push({ seq: event.seq, agent: event.agent, text });
    } else if (event.kind === "failure" && text) {
      state.failures = state.failures.filter((f) => f.text !== text);
      state.failures.push({ seq: event.seq, agent: event.agent, text });
    } else if (event.kind === "architecture" && text) {
      state.architecture = state.architecture.filter((a) => a.text !== text);
      state.architecture.push({ seq: event.seq, agent: event.agent, text });
    } else if (event.kind === "session_start") {
      state.sessionAgents[event.sessionId] = event.agent;
    }
  }
  return state;
}

// ── Handlers ────────────────────────────────────────────────────────────────

/**
 * What the frontend reads from each command below — the type argument of its
 * `invoke<T>`, or `Unread` where it awaits only success or failure.
 */
export interface MemoryResponses {
  memory_embed_status: EmbedStatus;
  memory_embed_download: Unit;
  memory_index_build: MemoryGraphData & { dim: number; doc_count: number };
  memory_index_query: QueryHit[];
  memory_graph_layout_load: GraphLayout;
  memory_graph_layout_save: Unread;
  memory_policies: Policy[];
  memory_policy_update: Unit;
  memory_sharing_get: boolean;
  memory_sharing_set: Unit;
  memory_summarizer_get: SummarizerPref;
  memory_summarizer_set: Unit;
  memory_get_state: SharedState;
  memory_list_events: MemoryEvent[];
  memory_query: MemoryEvent[];
  memory_append_event: number;
  memory_clear_project: Unit;
  memory_indexer_close_project: Unread;
}

export const memoryHandlers: TypedHandlers<MemoryResponses> = {
  // ── embedding model ──────────────────────────────────────────────────────
  memory_embed_status: (): EmbedStatus => ({
    downloaded: MODEL_READY,
    model: MODEL_ID,
    model_dir: `${HOME}/Library/Application Support/dev.atlas.app/models/${MODEL_ID}`,
  }),
  memory_embed_download: (): null => {
    streamModelDownload();
    return null;
  },

  // ── graph ────────────────────────────────────────────────────────────────
  memory_index_build: ({ projectPath }): MemoryGraphData & { dim: number; doc_count: number } => {
    if (!MODEL_READY) throw new Error("model-not-downloaded");
    // Re-indexing picks up everything appended since the last build, so the
    // Reindex button changes the graph instead of redrawing the same nodes.
    indexedExtraSeqs = eventsFor(String(projectPath))
      .filter((event) => event.seq > EVENT_SEEDS.length)
      .map((event) => event.seq);
    const graph = graphFor(String(projectPath));
    return { ...graph, dim: graph.nodes.length ? 384 : 0, doc_count: graph.nodes.length };
  },
  memory_index_query: ({ projectPath, query, topK }): QueryHit[] => {
    if (!MODEL_READY) throw new Error("model-not-downloaded");
    return queryGraph(String(projectPath), String(query ?? ""), Number(topK ?? 10));
  },
  memory_graph_layout_load: ({ projectPath }): GraphLayout =>
    layouts.get(String(projectPath)) ?? { positions: {} },
  memory_graph_layout_save: ({ projectPath, layout }): null => {
    layouts.set(String(projectPath), layout as GraphLayout);
    return null;
  },

  // ── policy ───────────────────────────────────────────────────────────────
  memory_policies: ({ projectPath }): Policy[] => {
    if (!MODEL_READY) throw new Error("model-not-downloaded");
    return String(projectPath) === MOCK_PROJECT.path ? policies : [];
  },
  memory_policy_update: ({ filePath, oldText, newText }): null => {
    const row = policies.find(
      (policy) => policy.file_path === String(filePath) && policy.value === String(oldText),
    );
    // Rust's two real failures: a file it isn't allowed to touch, and text that
    // has moved on since the table was built. The second is the one the inline
    // editor's error toast exists for.
    if (!String(filePath).startsWith(HOME)) throw new Error("path not allowed");
    if (!row) throw new Error("original text not found in file");
    row.value = String(newText);
    return null;
  },

  // ── sharing ──────────────────────────────────────────────────────────────
  memory_sharing_get: ({ projectPath }): boolean => sharingEnabled.get(String(projectPath)) ?? true,
  memory_sharing_set: ({ projectPath, enabled }): null => {
    sharingEnabled.set(String(projectPath), Boolean(enabled));
    return null;
  },
  memory_summarizer_get: ({ projectPath }): SummarizerPref =>
    summarizers.get(String(projectPath)) ?? DEFAULT_SUMMARIZER,
  memory_summarizer_set: ({ projectPath, pref }): null => {
    summarizers.set(String(projectPath), pref as SummarizerPref);
    return null;
  },

  // ── shared cross-agent memory ────────────────────────────────────────────
  memory_get_state: ({ projectPath }): SharedState => foldEvents(eventsFor(String(projectPath))),
  memory_list_events: ({ projectPath }): MemoryEvent[] => eventsFor(String(projectPath)),
  memory_query: ({ projectPath, query, limit }): MemoryEvent[] => {
    const needle = String(query ?? "")
      .trim()
      .toLowerCase();
    if (!needle) return [];
    return eventsFor(String(projectPath))
      .filter((event) =>
        `${event.agent} ${event.kind} ${event.key} ${JSON.stringify(event.payload)}`
          .toLowerCase()
          .includes(needle),
      )
      .slice(0, Number(limit ?? 20));
  },
  memory_append_event: ({ projectPath, agent, sessionId, kind, key, payload }): number => {
    const path = String(projectPath);
    const events = eventsFor(path);
    const event: MemoryEvent = {
      seq: (events.length ? events[events.length - 1].seq : 0) + 1,
      ts: Date.now(),
      agent: String(agent),
      sessionId: String(sessionId),
      kind: kind as EventKind,
      // Rust stores a keyless event as the empty string, never null.
      key: key == null ? "" : String(key),
      payload: (payload ?? {}) as Record<string, unknown>,
    };
    eventLog.set(path, [...events, event]);
    return event.seq;
  },
  memory_clear_project: ({ projectPath }): null => {
    eventLog.set(String(projectPath), []);
    indexedExtraSeqs = [];
    return null;
  },

  // ── housekeeping ─────────────────────────────────────────────────────────
  memory_indexer_close_project: (): null => null,
};
