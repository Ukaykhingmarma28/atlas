// The fake project every scenario opens: one org, one workspace, a small tree.

import type { FileEntry } from "@/features/explorer/stores/explorer-store";
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

/** `path` relative to the workspace root. */
export const abs = (path: string) => `${MOCK_WORKSPACE.path}/${path}`;

export function appState(overrides: Partial<AppStateWire> = {}): AppStateWire {
  return {
    currentProject: null,
    recentProjects: [],
    workspaces: [MOCK_WORKSPACE],
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

// Directories end with "/".
const TREE = [
  "src/",
  "src/components/",
  "src/components/button.tsx",
  "src/components/header.tsx",
  "src/lib/",
  "src/lib/api.ts",
  "src/lib/utils.ts",
  "src/main.tsx",
  "public/",
  "public/favicon.svg",
  "package.json",
  "README.md",
  "tsconfig.json",
];

/** `read_directory` over the fake tree. */
export function listDir(absPath: string): FileEntry[] {
  const root = MOCK_WORKSPACE.path;
  const rel = absPath === root ? "" : absPath.slice(root.length + 1).replace(/\/?$/, "/");
  return TREE.filter((p) => {
    if (!p.startsWith(rel) || p === rel) return false;
    return !p.slice(rel.length).replace(/\/$/, "").includes("/");
  }).map((p) => {
    const isDir = p.endsWith("/");
    const name = p.replace(/\/$/, "").split("/").pop()!;
    const dot = name.lastIndexOf(".");
    return {
      name,
      path: abs(p.replace(/\/$/, "")),
      is_dir: isDir,
      is_symlink: false,
      size: isDir ? 0 : 1024,
      extension: !isDir && dot > 0 ? name.slice(dot + 1) : null,
    };
  });
}
