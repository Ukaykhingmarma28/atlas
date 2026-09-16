// Answers every scenario gets: the commands Atlas calls just to start up.
// A scenario overrides any of these by naming the same command.
//
// Each answer is typed with the same type the frontend's API wrapper uses, so
// `bun run typecheck` flags a fake that no longer matches what Rust returns.

import type { AcpRegistryListing } from "@/features/agents/lib/agent-registry-api";
import type { AuthSnapshot } from "@/features/auth/lib/auth-api";
import type { KeybindingsLoadResult } from "@/features/keybindings/lib/keybindings-api";
import { DEFAULT_KEYBINDINGS_FILE } from "@/features/keybindings/lib/types";
import type { ModelStatus } from "@/features/settings/lib/models-api";
import type { UpdaterSnapshot } from "@/features/updater/lib/updater-api";
import type { AgentCatalog } from "@/types/agent-catalog";
import type { CaptureHealth } from "@/features/capture/types";
import type { ThreadProject } from "@/features/chat/lib/history-api";
import type { RecentFile } from "@/features/chat/stores/recent-files-store";
import type { FileEntry } from "@/features/explorer/stores/explorer-store";
import type { FileIndexStatus } from "@/features/file-picker/lib/file-picker-api";
import type { GitSummary } from "@/features/workspaces/stores/workspace-git-store";
import type { MockHandlers } from "../types";
import { agentHandlers } from "../fake-agent";
import { appState, listDir, MOCK_WORKSPACE } from "../workspace";

const nothing = () => null;

export const baseHandlers: MockHandlers = {
  // ── boot ────────────────────────────────────────────────────────────────
  bootstrap_app_state: () => appState(),
  cli_take_initial_project_path: nothing,
  cli_install_helper: nothing,
  set_window_title: nothing,
  telemetry_config: () => ({
    enabled: false,
    host: "",
    anonId: "mock-device",
    accountId: null,
    usingDefaultKey: false,
    // null keeps posthog-js from ever loading in mock mode.
    key: null,
  }),
  auth_snapshot: (): AuthSnapshot => ({ status: "signed-out" }),
  update_state: (): UpdaterSnapshot => ({
    phase: "idle",
    version: null,
    currentVersion: "0.0.0-mock",
  }),
  keybindings_load: (): KeybindingsLoadResult => ({
    file: DEFAULT_KEYBINDINGS_FILE,
    path: "~/.config/atlas/keybindings.json",
    warnings: [],
  }),

  // ── workspace open ──────────────────────────────────────────────────────
  save_app_state: nothing,
  append_project_log: nothing,
  asset_allow_dir: nothing,
  ensure_atlas_gitignore: nothing,
  load_editor_state: () => "{}",
  save_editor_state: nothing,
  load_project_session: () => "{}",
  read_directory: ({ path }): FileEntry[] => listDir(path),
  fileindex_open_project: () => 0,
  fileindex_status: (): FileIndexStatus => ({
    indexed: true,
    count: 0,
    root: MOCK_WORKSPACE.path,
  }),
  recent_files_open_project: (): RecentFile[] => [],
  codebase_index_status: () => ({ indexed: false, fileCount: 0, summaryCount: 0, builtAtMs: 0 }),
  list_knowledge: () => [],
  knowledge_meta_load: () => ({ version: 1, pages: {} }),
  threads_projects: (): ThreadProject[] => [],
  capture_activate: nothing,
  capture_binding: nothing,
  capture_health: (): CaptureHealth => ({
    state: "off",
    summary: "",
    issues: [],
    flaggedSessions: 0,
    failedRows: 0,
    pendingRows: 0,
  }),

  // ── git (clean repo; git scenarios override) ────────────────────────────
  git_watch_start: nothing,
  git_workspace_summary: (): GitSummary => ({
    isRepo: true,
    branch: "main",
    headSubject: "Initial commit",
    dirty: false,
    additions: 0,
    deletions: 0,
  }),
  git_snapshot: () => ({
    isRepo: true,
    branch: "main",
    detached: false,
    upstream: "origin/main",
    ahead: 0,
    behind: 0,
    files: [],
    branches: [],
    stashes: [],
    inProgress: null,
  }),
  git_log: () => [],
  git_diff_all: () => "",
  git_remotes: () => [{ name: "origin", url: "git@github.com:acme/acme-app.git" }],
  git_tags: () => [],

  // ── agents ──────────────────────────────────────────────────────────────
  agents_catalog: (): AgentCatalog => ({
    entries: [],
    lastRefreshedAt: null,
    lastDiscoveredAt: null,
    lastError: null,
  }),
  acp_registry_list: (): AcpRegistryListing => ({
    entries: [],
    lastRefreshedAt: null,
    lastError: null,
    isFetching: false,
  }),
  models_list: (): ModelStatus[] => [],

  ...agentHandlers,
  agents_set_effort: nothing,

  // ── fire-and-forget housekeeping ────────────────────────────────────────
  comms_ready: nothing,
  fileindex_close_project: nothing,
  recent_files_close_project: nothing,
  mention_cache_clear: nothing,
  mention_cache_set_knowledge: nothing,
  telemetry_set_org: nothing,

  // ── Tauri plugins ───────────────────────────────────────────────────────
  "plugin:app|version": () => "0.0.0-mock",
  "plugin:notification|is_permission_granted": () => false,
  "plugin:window|is_focused": () => true,
  "plugin:window|is_fullscreen": () => false,
  "plugin:webview|set_webview_zoom": nothing,
};
