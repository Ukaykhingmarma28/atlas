// The fake project every scenario opens: one org, a few workspaces, and the
// helpers that turn a relative path into the absolute one Rust would see.
//
// The tree itself lives in `fixtures/files.ts` (with the files' real content),
// so `read_directory` and `read_file_content` can never disagree about which
// files exist.

import type { AppStateWire } from "@/features/project/stores/project-store";
import type { Workspace } from "@/features/workspaces/stores/workspace-store";

export const MOCK_ORG_ID = "org-mock";

export const MOCK_WORKSPACE = {
  id: "ws-mock",
  name: "acme-app",
  path: "/Users/dev/acme-app",
  groupId: null,
  orgId: MOCK_ORG_ID,
} satisfies Workspace;

/**
 * Two more workspaces, for the surfaces that list or aggregate every project:
 * the switcher, the sidebar's per-workspace git summaries, and Mission
 * Control's project table. One carries a deliberately over-long name so
 * truncation is visible without hunting for a repro.
 */
export const OTHER_WORKSPACES = [
  {
    id: "ws-mock-2",
    name: "acme-platform-migration-experiments",
    path: "/Users/dev/acme-platform-migration-experiments",
    groupId: null,
    orgId: MOCK_ORG_ID,
  },
  {
    id: "ws-mock-3",
    name: "docs",
    path: "/Users/dev/docs",
    groupId: null,
    orgId: MOCK_ORG_ID,
  },
] satisfies Workspace[];

export const ALL_WORKSPACES: Workspace[] = [MOCK_WORKSPACE, ...OTHER_WORKSPACES];

/** `path` relative to the workspace root. */
export const abs = (path: string) => `${MOCK_WORKSPACE.path}/${path}`;

export function appState(overrides: Partial<AppStateWire> = {}): AppStateWire {
  return {
    currentProject: null,
    recentProjects: [],
    workspaces: ALL_WORKSPACES,
    groups: [],
    activeWorkspaceId: MOCK_WORKSPACE.id,
    organisations: [{ id: MOCK_ORG_ID, name: "Acme", slug: "acme", syncEnabled: false }],
    activeOrganisationId: MOCK_ORG_ID,
    configStatus: { status: "ok" },
    configGeneration: 1,
    version: 3,
    ...overrides,
  };
}
