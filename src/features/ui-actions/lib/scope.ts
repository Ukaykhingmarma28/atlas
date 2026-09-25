/**
 * **Project-scoped** (CONTEXT.md): a UI action acts on the active project's
 * view and never switches projects. A tab another project owns is refused,
 * and the refusal names that project so the model can tell the user.
 */

import { useLayoutStore, type Tab } from "@/features/layout/stores/layout-store";
import { useProjectStore } from "@/features/projects/stores/project-store";
import { projectIdForTab } from "@/features/chat/lib/tab-project";
import { useAppStore } from "@/features/app/stores/app-store";
import { refuse } from "./args";

/** The tab `tabId` in the active project's view, or a refusal saying why not. */
export function tabInScope(tabId: string): Tab {
  const tab = useLayoutStore.getState().tabs.find((t) => t.id === tabId);
  if (tab) return tab;
  const ownerId = projectIdForTab(tabId);
  const owner = ownerId
    ? useProjectStore.getState().projects.find((p) => p.id === ownerId)
    : undefined;
  if (owner) {
    return refuse(
      `tab ${tabId} belongs to project "${owner.name}", not the active one; UI actions never switch projects — ask the user to switch`,
    );
  }
  return refuse(`no tab ${tabId} in the active project; ui_state lists the open tabs`);
}

/** The active project, or a refusal when none is open. */
export function activeProject(): { name: string; path: string } {
  return useAppStore.getState().currentProject ?? refuse("no project is open in Atlas");
}

/** `path` made absolute: relative paths resolve against the calling session's
 *  working directory when it is inside the active project, else the project. */
export function resolvePath(path: string, cwd: string): string {
  if (path.startsWith("/")) return path;
  const project = activeProject().path;
  const base = cwd === project || cwd.startsWith(`${project}/`) ? cwd : project;
  const clean = path.replace(/^\.\//, "");
  return `${base.replace(/\/$/, "")}/${clean}`;
}
