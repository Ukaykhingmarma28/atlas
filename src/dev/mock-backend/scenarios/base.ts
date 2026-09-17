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
import type { MentionData } from "@/features/chat/lib/mentions";
import type { ThreadProject } from "@/features/chat/lib/history-api";
import type { FileEntry } from "@/features/explorer/stores/explorer-store";
import type { ClonedRepo } from "@/features/github/types";
import type { GraphLayout } from "@/features/knowledge/components/knowledge-graph";
import type { ProjectGraph } from "@/features/knowledge/stores/knowledge-graph-store";
import type { Backlink, LinkCounts } from "@/features/knowledge/stores/knowledge-links-store";
import type { MetaFile, RustPageMeta } from "@/features/knowledge/stores/knowledge-meta-store";
import type { KnowledgeEntry } from "@/features/knowledge/stores/knowledge-store";
import type { Theme, ThemeSummary } from "@/features/theme/lib/theme-api";
import type { GitSummary } from "@/features/workspaces/stores/workspace-git-store";
import type { MockHandlers } from "../types";
import builtinThemesJson from "../fixtures/builtin-themes.json";
import { agentHandlers } from "../fake-agent";
import { fsHandlers, listDir } from "../fixtures/files";
import { appState, MOCK_WORKSPACE } from "../workspace";

const nothing = () => null;

// Generated from the TOML themes by the atlas-theme crate; `cargo test -p
// atlas-theme` fails when this snapshot is stale.
const builtinThemes = builtinThemesJson as Theme[];

// Inline `invoke<…>` result types in the knowledge panel / footer, restated
// here (Rust: `KbImportResult` in knowledge.rs, `knowledge_export_server`).
export interface KbImportResult {
  notes_imported: number;
  files_copied: number;
}
export interface KbServerExport {
  binaryPath: string;
  noteCount: number;
}

export const baseHandlers: MockHandlers = {
  // ── theme ──────────────────────────────────────────────────────────────
  list_themes: (): ThemeSummary[] =>
    builtinThemes.map((theme) => ({
      id: theme.id,
      name: theme.name,
      author: theme.author,
      license: theme.license,
      hasDark: Boolean(theme.dark),
      hasLight: Boolean(theme.light),
      builtIn: true,
      warnings: theme.warnings ?? [],
    })),
  get_theme: (a): Theme => {
    const theme = builtinThemes.find((candidate) => candidate.id === a.id);
    if (!theme) throw new Error(`theme '${String(a.id)}' was not found`);
    return theme;
  },

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
  codebase_index_status: () => ({ indexed: false, fileCount: 0, summaryCount: 0, builtAtMs: 0 }),
  // Knowledge: an empty base. Writes are accepted and forgotten; the
  // `knowledge` scenario overrides all of these with a live in-memory store.
  list_knowledge: (): KnowledgeEntry[] => [],
  knowledge_meta_load: (): MetaFile => ({ version: 1, pages: {} }),
  knowledge_meta_patch: ({ patch }): RustPageMeta => ({ ...patch }),
  knowledge_meta_delete: nothing,
  save_knowledge_note: ({ id }) => `${MOCK_WORKSPACE.path}/.atlas/knowledge/${id}.md`,
  delete_knowledge_note: nothing,
  create_knowledge_dir: nothing,
  import_into_knowledge: (): KbImportResult => ({ notes_imported: 0, files_copied: 0 }),
  log_interaction: nothing,
  knowledge_backlinks: (): Backlink[] => [],
  knowledge_link_counts: (): LinkCounts => ({ backlinks: 0, forwardlinks: 0 }),
  knowledge_links_graph: (): ProjectGraph => ({ nodes: [], edges: [] }),
  knowledge_links_invalidate: nothing,
  knowledge_graph_layout_load: (): GraphLayout => ({ positions: {} }),
  knowledge_graph_layout_save: nothing,
  // Rust hands gradient refs back untouched; there are no image covers here.
  knowledge_cover_data_url: ({ cover }): string => {
    if (String(cover).startsWith("gradient:")) return cover;
    throw new Error("cover not found");
  },
  knowledge_cover_upload: ({ entryId }): string => `covers/${entryId.replace(/\//g, "__")}.png`,
  // The real command always returns a list; the sidebar also guards null.
  list_cloned_repos: (): ClonedRepo[] => [],
  read_repo_readme: () => {
    throw new Error("No README found");
  },
  delete_cloned_repo: nothing,
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

  // ── files ───────────────────────────────────────────────────────────────
  ...fsHandlers,

  // ── fire-and-forget housekeeping ────────────────────────────────────────
  comms_ready: nothing,
  fileindex_close_project: nothing,
  recent_files_close_project: nothing,
  mention_cache_clear: nothing,
  mention_cache_set_knowledge: nothing,
  // The unscoped `@` picker spreads this result, so `null` would throw.
  mention_search: (): MentionData[] => [],
  knowledge_export_note_md: nothing,
  knowledge_export_note_html: nothing,
  knowledge_export_workspace_md: nothing,
  knowledge_export_workspace_html: nothing,
  knowledge_export_server: (): KbServerExport => ({
    binaryPath: "/Users/dev/Downloads/atlas-kb-server",
    noteCount: 0,
  }),
  telemetry_set_org: nothing,

  // ── Tauri plugins ───────────────────────────────────────────────────────
  "plugin:app|version": () => "0.0.0-mock",
  "plugin:notification|is_permission_granted": () => false,
  "plugin:window|is_focused": () => true,
  "plugin:window|is_fullscreen": () => false,
  "plugin:webview|set_webview_zoom": nothing,
};
