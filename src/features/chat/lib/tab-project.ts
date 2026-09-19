import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { useChatStore } from "@/features/chat/stores/chat-store";
import { useProjectStore } from "@/features/projects/stores/project-store";
import { useTerminalStore } from "@/features/terminal/stores/terminal-store";

/**
 * Tab ↔ project resolution. Tab ids are unique across projects, so a tab
 * has exactly one owner: the project the live layout mirror represents if
 * it's in the mirror, else whichever committed `viewsByWs` entry contains it,
 * else (for a bound chat) the project whose path matches the session's cwd.
 *
 * The mirror's owner is `currentViewWsId`, NOT `activeProjectId`. A switch
 * sets `activeProjectId` (step 2) well before it swaps the mirror via
 * `loadProjectView` (step 4) — there are awaited flushes in between. Reading
 * `activeProjectId` here answered "the incoming project" for tabs that
 * still belonged to the outgoing one, so a bind landing mid-switch created the
 * session with the WRONG cwd and filed its history row under the wrong project.
 */
export function projectIdForTab(tabId: string): string | null {
  const layout = useLayoutStore.getState();
  const ws = useProjectStore.getState();
  if (layout.tabs.some((t) => t.id === tabId)) {
    return layout.currentViewWsId ?? ws.activeProjectId;
  }
  for (const [wsId, view] of Object.entries(layout.viewsByWs)) {
    if (view.tabs.some((t) => t.id === tabId)) return wsId;
  }
  // A terminal tab records its owner when it is initialised — the only
  // answer for one whose project view has not been committed yet.
  const owner = useTerminalStore.getState().owners[tabId];
  if (owner) return owner;
  const path = useChatStore.getState().sessions[tabId]?.workingDirectory;
  if (path) {
    // Paths are unique per ORG, not globally (the same folder can be a
    // project in several organisations). Prefer the active project when
    // it matches, so a cross-org twin never claims the active org's tab.
    const active = ws.projects.find((w) => w.id === ws.activeProjectId);
    if (active?.path === path) return active.id;
    return ws.projects.find((w) => w.path === path)?.id ?? null;
  }
  return null;
}

/** The project root a tab lives in — what a chat bind must use as cwd. The
 *  global `currentProject` is the ACTIVE project's, which is wrong for a
 *  background project's still-mounted chat panel. */
export function projectPathForTab(tabId: string): string | null {
  const id = projectIdForTab(tabId);
  if (!id) return null;
  return useProjectStore.getState().projects.find((w) => w.id === id)?.path ?? null;
}

/**
 * Bring a chat tab into view from anywhere: switch to its project first if
 * needed (a bare `setActiveTab` on a foreign tab id falls back to `tabs[0]` of
 * the CURRENT project), then activate + focus it.
 */
export async function jumpToSession(tabId: string): Promise<void> {
  const ws = useProjectStore.getState();
  const ownerId = projectIdForTab(tabId);
  if (ownerId && ownerId !== ws.activeProjectId) {
    await ws.actions.switchTo(ownerId);
  }
  useLayoutStore.getState().actions.setActiveTab(tabId);
  window.dispatchEvent(new CustomEvent("atlas:chat-focus", { detail: { tabId } }));
}
