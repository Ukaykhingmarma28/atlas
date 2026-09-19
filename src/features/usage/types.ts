/**
 * Wire types for the Usage dashboard — mirrors `src-tauri/src/commands/usage_dashboard.rs`.
 *
 * Every rollup (`projects`, `agents`, `models`, `totals`) is folded from `daily` on the Rust
 * side, so the frontend re-folds the SAME rows after filtering and the numbers agree with what
 * an unfiltered view shows. The frontend never needs a refetch to change range or facets.
 */

/** The token/cost block every rollup shares. `sessions` = distinct sessions in the bucket. */
export interface Metrics {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Informational: rides inside `output` for every provider that reports it. Never priced. */
  reasoning: number;
  cost: number;
  messages: number;
  sessions: number;
}

/** One local day × project × agent × model. */
export interface DailyBucket extends Metrics {
  /** Local "YYYY-MM-DD". */
  date: string;
  projectPath: string;
  agent: string;
  model: string;
}

export interface ProjectMetrics extends Metrics {
  projectPath: string;
  projectName: string;
  firstActivityMs: number | null;
  lastActivityMs: number | null;
}

export interface AgentMetrics extends Metrics {
  agent: string;
}

export interface ModelMetrics extends Metrics {
  model: string;
}

export interface SessionRow {
  sessionId: string;
  projectPath: string;
  agent: string;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  messages: number;
  cost: number;
  startedMs: number;
  lastActivityMs: number | null;
  title: string;
  /** Day attribution came from the per-turn ledger (true) or the last-active day (false). */
  ledgered: boolean;
}

export interface ByokDay {
  date: string;
  provider: string;
  model: string;
  input: number;
  output: number;
  cost: number;
  requests: number;
}

export interface GrandTotals extends Metrics {
  byokInput: number;
  byokOutput: number;
  byokCost: number;
  byokRequests: number;
  /** agents(in+out) + byok(in+out); cache and reasoning excluded. */
  totalTokens: number;
  totalCostUsd: number;
}

export interface UsageDashboard {
  totals: GrandTotals;
  projects: ProjectMetrics[];
  agents: AgentMetrics[];
  models: ModelMetrics[];
  daily: DailyBucket[];
  /** Most-recent first, capped at `SESSION_ROW_CAP` (2000) on the Rust side. */
  sessions: SessionRow[];
  sessionsTotal: number;
  byokDaily: ByokDay[];
  byokSince: string | null;
  /** The pseudo project path BYOK rows are filed under ("byok"). */
  byokProjectPath: string;
  /** RFC 3339 of the earliest ledger row across the org, or null before any. */
  ledgerSince: string | null;
  generatedAt: string;
}

// ── UI state vocabulary ─────────────────────────────────────────────────────

export type RangePreset = "7d" | "30d" | "90d" | "all" | "custom";

export interface DateRange {
  preset: RangePreset;
  /** Inclusive local "YYYY-MM-DD" bounds; only set for `custom`. */
  from?: string;
  to?: string;
}

export type GroupBy = "project" | "agent" | "model";
export type Metric = "tokens" | "cost" | "messages";
export type TableTab = "sessions" | "projects" | "agents" | "models";

export interface Facets {
  projects: string[];
  agents: string[];
  models: string[];
}

export const NO_FACETS: Facets = { projects: [], agents: [], models: [] };

/** The label Rust uses for a missing agent/model. */
export const UNKNOWN = "unknown";
/** Pseudo agent id BYOK rows carry once mapped into `daily`. */
export const BYOK_AGENT = "byok";
