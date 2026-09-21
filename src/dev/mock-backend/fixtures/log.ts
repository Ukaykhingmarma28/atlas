// The activity console and the Usage tab.
//
// Both read from Rust as flat rows: the console gets JSONL it parses one line
// at a time (a malformed line is skipped, which is why one deliberately broken
// row is seeded), Usage gets one `UsageDashboard` of daily buckets and session
// rows. Neither surface is worth looking at with three rows in it, so the log
// is seeded dense enough to scroll and the usage series covers a full 90 days
// so every range preset has a shape.
//
// Writes are kept for the session: pinning an entry, appending one, or
// clearing the buffer all survive until reload, so those buttons do something.

import type { LogEntry, LogSource } from "@/features/log/stores/log-store";
import type { UsageDashboard } from "@/features/usage/types";
import { fixture as usageFixture } from "@/features/usage/lib/__fixtures__/dashboard";
import type { TypedHandlers, Unread } from "../types";
import { ALL_PROJECTS, MOCK_ORG_ID, MOCK_PROJECT } from "../project";

/** Fixed "now" so the seeded series is stable between reloads. */
const NOW = Date.parse("2026-09-18T11:30:00Z");

type Seed = [source: LogSource, kind: string, summary: string, payload?: Record<string, unknown>];

/**
 * The shapes the console has to render: short and long summaries, failures,
 * cancellations, rows with a payload to expand and rows with none.
 */
const SEEDS: Seed[] = [
  [
    "agent",
    "turn",
    "Refactor the API client onto /v2 endpoints",
    { tokens: 18_422, model: "claude-opus-4" },
  ],
  ["agent", "tool", "Edit src/lib/api.ts", { lines: 34 }],
  [
    "agent",
    "error",
    "Tool call failed: read of src/legacy/auth.ts (no such file)",
    { code: "ENOENT" },
  ],
  ["agent", "cancelled", "Turn cancelled by the user after 42s", { elapsedMs: 42_310 }],
  ["chat", "message", "How do I keep the session cache warm across reloads?"],
  [
    "chat",
    "message",
    "Walk me through every place the pricing table is read, why General crashes when it is empty, and what the safest guard would be — I want the whole chain, not just the line that threw",
  ],
  ["editor", "save", "api.ts", { path: "src/lib/api.ts", bytes: 2_184 }],
  ["editor", "save", "tokens.css", { path: "src/styles/tokens.css", bytes: 1_021 }],
  ["editor", "open", "src-tauri/src/lib.rs"],
  [
    "git",
    "commit",
    "feat(api): move user reads onto /v2",
    { files: 4, additions: 61, deletions: 18 },
  ],
  ["git", "checkout", "feature/auth-v2", { branch: "feature/auth-v2" }],
  ["git", "stage", "src/lib/api.ts"],
  ["git", "push", "origin main — rejected, remote has 2 commits you do not have", { ok: false }],
  ["knowledge", "note-create", "Theme token audit"],
  ["knowledge", "link", "Theme token audit → Diff view colours"],
  ["canvas", "export", "architecture.svg", { nodes: 24 }],
  ["github", "clone", "acme/design-tokens", { sizeMb: 12.4 }],
  ["project", "open", "acme-app", { path: MOCK_PROJECT.path }],
  ["system", "index", "Codebase index rebuilt — 1,284 files", { durationMs: 8_120 }],
  ["system", "update", "Checked for updates — already on the latest build"],
  ["atlas", "settings", "Theme changed to Atlas Dark", { theme: "atlas-dark" }],
  ["atlas", "settings", "Telemetry sharing turned off"],
];

function seedEntries(): LogEntry[] {
  return SEEDS.map((seed, index) => {
    const [source, kind, summary, payload] = seed;
    // Bunched in the last few days so the list has runs, not one row per day.
    const at = NOW - index * (37 * 60_000 + (index % 5) * 11 * 60_000);
    return {
      id: `seed_${index.toString().padStart(3, "0")}`,
      timestamp: new Date(at).toISOString(),
      source,
      kind,
      summary,
      orgId: MOCK_ORG_ID,
      projectPath: MOCK_PROJECT.path,
      projectName: MOCK_PROJECT.name,
      ...(payload ? { payload } : {}),
    } satisfies LogEntry;
  });
}

const toJsonl = (rows: LogEntry[]) => rows.map((row) => JSON.stringify(row)).join("\n") + "\n";

/** Oldest-first on disk — the store sorts newest-first on read. */
const SEEDED = seedEntries().reverse();

const projectLogs = new Map<string, string>([
  [
    MOCK_PROJECT.path,
    // A truncated last line: the reader skips malformed JSON, and a log that
    // was being appended to when the app died really does look like this.
    toJsonl(SEEDED) + '{"id":"seed_trunc","timestamp":"2026-09-18T11:3',
  ],
]);

const pinnedLogs = new Map<string, string>([
  [MOCK_ORG_ID, toJsonl(SEEDED.filter((row) => row.kind === "error" || row.kind === "commit"))],
]);

// ── Usage ─────────────────────────────────────────────────────────────────

/**
 * 90 days of deterministic usage, re-pathed onto the mock's own projects.
 *
 * The generator is the same one the Usage unit tests use, so the browser and
 * the suite look at one shape; only the project paths are swapped, because a
 * facet list naming four projects the mock sidebar has never heard of reads as
 * a bug in the org scoping rather than as fixture data.
 */
function usage(paths: string[]): UsageDashboard {
  const data = usageFixture(90);
  const known = [...new Set(data.daily.map((bucket) => bucket.projectPath))];
  const remap = (path: string) => paths[known.indexOf(path) % paths.length] ?? paths[0];
  return {
    ...data,
    daily: data.daily.map((bucket) => ({ ...bucket, projectPath: remap(bucket.projectPath) })),
    sessions: data.sessions.map((row) => ({ ...row, projectPath: remap(row.projectPath) })),
  };
}

/**
 * What the frontend reads from each command below — the type argument of its
 * `invoke<T>`, or `Unread` where it awaits only success or failure.
 */
export interface LogResponses {
  load_project_log: string;
  append_project_log: Unread;
  clear_project_log: Unread;
  load_pinned_log: string;
  append_pinned_log: Unread;
  rewrite_pinned_log: Unread;
  clear_pinned_log: Unread;
  usage_dashboard: UsageDashboard;
}

export const logHandlers: TypedHandlers<LogResponses> = {
  load_project_log: ({ project }): string => projectLogs.get(String(project)) ?? "",
  append_project_log: ({ project, entryJson }): null => {
    const key = String(project);
    projectLogs.set(key, `${projectLogs.get(key) ?? ""}${String(entryJson)}\n`);
    return null;
  },
  clear_project_log: ({ project }): null => {
    projectLogs.set(String(project), "");
    return null;
  },
  // The pinned console calls this with no `org` at all; fall back to the only one.
  load_pinned_log: ({ org }): string => pinnedLogs.get(String(org ?? MOCK_ORG_ID)) ?? "",
  append_pinned_log: ({ org, entryJson }): null => {
    const key = String(org ?? MOCK_ORG_ID);
    pinnedLogs.set(key, `${pinnedLogs.get(key) ?? ""}${String(entryJson)}\n`);
    return null;
  },
  rewrite_pinned_log: ({ org, entriesJson }): null => {
    pinnedLogs.set(String(org), String(entriesJson));
    return null;
  },
  clear_pinned_log: ({ org }): null => {
    pinnedLogs.set(String(org), "");
    return null;
  },

  usage_dashboard: ({ projectPaths }): UsageDashboard => {
    const paths = Array.isArray(projectPaths) ? (projectPaths as string[]) : [];
    return usage(paths.length ? paths : ALL_PROJECTS.map((project) => project.path));
  },
};
