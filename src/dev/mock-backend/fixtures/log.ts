// The activity console and Mission Control.
//
// Both read from Rust as flat rows: the console gets JSONL it parses one line
// at a time (a malformed line is skipped, which is why one deliberately broken
// row is seeded), Mission Control gets a single aggregate. Neither surface is
// worth looking at with three rows in it, so the log is seeded dense enough to
// scroll and the usage series covers a full 90 days so every range toggle has
// a shape.
//
// Writes are kept for the session: pinning an entry, appending one, or
// clearing the buffer all survive until reload, so those buttons do something.

import type { LogEntry, LogSource } from "@/features/log/stores/log-store";
import type {
  AgentMetrics,
  DailyBucket,
  MissionControlUsage,
  ProjectMetrics,
} from "@/features/mission-control/types";
import type { MockHandlers } from "../types";
import { ALL_WORKSPACES, MOCK_ORG_ID, MOCK_WORKSPACE } from "../workspace";

const DAY = 86_400_000;
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
  ["project", "open", "acme-app", { path: MOCK_WORKSPACE.path }],
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
      projectPath: MOCK_WORKSPACE.path,
      projectName: MOCK_WORKSPACE.name,
      ...(payload ? { payload } : {}),
    } satisfies LogEntry;
  });
}

const toJsonl = (rows: LogEntry[]) => rows.map((row) => JSON.stringify(row)).join("\n") + "\n";

/** Oldest-first on disk — the store sorts newest-first on read. */
const SEEDED = seedEntries().reverse();

const projectLogs = new Map<string, string>([
  [
    MOCK_WORKSPACE.path,
    // A truncated last line: the reader skips malformed JSON, and a log that
    // was being appended to when the app died really does look like this.
    toJsonl(SEEDED) + '{"id":"seed_trunc","timestamp":"2026-09-18T11:3',
  ],
]);

const pinnedLogs = new Map<string, string>([
  [MOCK_ORG_ID, toJsonl(SEEDED.filter((row) => row.kind === "error" || row.kind === "commit"))],
]);

// ── Mission Control ───────────────────────────────────────────────────────

/** Deterministic 0..1 noise, so the charts look organic but never move. */
function wobble(seed: number): number {
  const x = Math.sin(seed * 12.9898) * 43_758.5453;
  return x - Math.floor(x);
}

const PER_PROJECT_WEIGHT: Record<string, number> = {
  [MOCK_WORKSPACE.path]: 1,
  [ALL_WORKSPACES[1].path]: 0.42,
  [ALL_WORKSPACES[2].path]: 0.08,
};

function dailySeries(paths: string[]): DailyBucket[] {
  const out: DailyBucket[] = [];
  for (let back = 89; back >= 0; back--) {
    const date = new Date(NOW - back * DAY).toISOString().slice(0, 10);
    const weekday = new Date(NOW - back * DAY).getUTCDay();
    // Weekends dip; the run ramps up over the quarter.
    const ramp = 0.35 + (89 - back) / 120;
    const weekend = weekday === 0 || weekday === 6 ? 0.2 : 1;
    for (const path of paths) {
      const weight = PER_PROJECT_WEIGHT[path] ?? 0.25;
      const noise = 0.6 + wobble(back * 7 + path.length) * 0.8;
      const scale = ramp * weekend * weight * noise;
      // A day with no activity is a real shape the chart has to survive.
      if (scale < 0.12) continue;
      const input = Math.round(120_000 * scale);
      const output = Math.round(9_400 * scale);
      out.push({
        date,
        projectPath: path,
        agentInput: input,
        agentOutput: output,
        agentCost: Number(((input * 3 + output * 15) / 1_000_000).toFixed(4)),
        agentMessages: Math.max(1, Math.round(18 * scale)),
      });
    }
  }
  return out;
}

function foldProject(path: string, buckets: DailyBucket[]): ProjectMetrics {
  const mine = buckets.filter((bucket) => bucket.projectPath === path);
  const agents: AgentMetrics = mine.reduce<AgentMetrics>(
    (acc, bucket) => ({
      inputTokens: acc.inputTokens + bucket.agentInput,
      outputTokens: acc.outputTokens + bucket.agentOutput,
      // Atlas sessions are overwhelmingly cache traffic; keep that proportion.
      cacheCreationTokens: acc.cacheCreationTokens + Math.round(bucket.agentInput * 0.35),
      cacheReadTokens: acc.cacheReadTokens + Math.round(bucket.agentInput * 6.2),
      messages: acc.messages + bucket.agentMessages,
      costUsd: acc.costUsd + bucket.agentCost,
      sessions: acc.sessions + (bucket.agentMessages > 10 ? 2 : 1),
    }),
    {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      messages: 0,
      costUsd: 0,
      sessions: 0,
    },
  );
  const workspace = ALL_WORKSPACES.find((candidate) => candidate.path === path);
  return {
    projectPath: path,
    projectName: workspace?.name ?? path.split("/").pop() ?? path,
    agents,
    firstActivityMs: mine.length ? Date.parse(`${mine[0].date}T09:00:00Z`) : null,
    lastActivityMs: mine.length ? Date.parse(`${mine[mine.length - 1].date}T18:00:00Z`) : null,
    totalTokens:
      agents.inputTokens +
      agents.outputTokens +
      agents.cacheCreationTokens +
      agents.cacheReadTokens,
  };
}

function usage(paths: string[]): MissionControlUsage {
  const daily = dailySeries(paths);
  const projects = paths.map((path) => foldProject(path, daily));
  const byokDaily = daily
    .filter((bucket) => bucket.projectPath === paths[0])
    .slice(-45)
    .map((bucket) => ({
      date: bucket.date,
      input: Math.round(bucket.agentInput * 0.18),
      output: Math.round(bucket.agentOutput * 0.22),
      cost: Number((bucket.agentCost * 0.14).toFixed(4)),
    }));

  const agentCost = projects.reduce((sum, project) => sum + project.agents.costUsd, 0);
  const byokCost = byokDaily.reduce((sum, day) => sum + day.cost, 0);
  const totalTokens = projects.reduce((sum, project) => sum + project.totalTokens, 0);
  return {
    projects,
    daily,
    byokDaily,
    totals: {
      agentInput: projects.reduce((sum, p) => sum + p.agents.inputTokens, 0),
      agentOutput: projects.reduce((sum, p) => sum + p.agents.outputTokens, 0),
      agentCache: projects.reduce(
        (sum, p) => sum + p.agents.cacheCreationTokens + p.agents.cacheReadTokens,
        0,
      ),
      agentCost: Number(agentCost.toFixed(2)),
      agentMessages: projects.reduce((sum, p) => sum + p.agents.messages, 0),
      agentSessions: projects.reduce((sum, p) => sum + p.agents.sessions, 0),
      byokInput: byokDaily.reduce((sum, day) => sum + day.input, 0),
      byokOutput: byokDaily.reduce((sum, day) => sum + day.output, 0),
      byokCost: Number(byokCost.toFixed(2)),
      byokRequests: byokDaily.length * 7,
      totalTokens,
      totalCostUsd: Number((agentCost + byokCost).toFixed(2)),
    },
    byokSince: byokDaily[0]?.date ?? null,
    generatedAt: new Date(NOW).toISOString(),
  };
}

export const logHandlers: MockHandlers = {
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
  // Mission Control calls this with no `org` at all; fall back to the only one.
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

  mission_control_usage: ({ projectPaths }): MissionControlUsage => {
    const paths = Array.isArray(projectPaths) ? (projectPaths as string[]) : [];
    return usage(paths.length ? paths : ALL_WORKSPACES.map((workspace) => workspace.path));
  },
};
