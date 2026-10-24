// What the sidebar's rows, menus and chords do to a session.
//
// Every write goes through the lifecycle store (`session-lifecycle-store.ts`),
// which owns the invoke and toasts the backend's reason on a refusal; this
// module adds what the sidebar knows and the store does not — the list order a
// parked session moves along, the Undo on a settle, the tab to clear on a
// delete. Handlers read the list at call time through `SidebarListRef`, so
// the memoised rows can share one stable set of callbacks.

import { toast } from "sonner";
import { copyText } from "@/lib/clipboard";
import { useSessionLifecycleStore } from "@/features/chat/stores/session-lifecycle-store";
import { useChatStore } from "@/features/chat/stores/chat-store";
import { useGitStore } from "@/features/git/stores/git-store";
import { useAppStore } from "@/features/app/stores/app-store";
import { deleteThread, markSessionViewed } from "@/features/chat/lib/history-api";
import { confirmDeleteChat } from "@/features/chat/lib/confirm-delete-chat";
import { openNewAgentChat } from "@/features/chat/lib/open-agent-session";
import { openThread, tabShowingSession } from "@/features/chat/lib/open-thread";
import { AGENT_TYPE_BY_SIDEBAR } from "@/features/chat/lib/sidebar-agents";
import { pinOrderKeyForNewPin, planPinnedReorder } from "@/features/chat/lib/pin-order";
import { useProjectStore } from "@/features/projects/stores/project-store";
import { useOrgStore } from "@/features/organisations/stores/org-store";
import { useSettingsNav } from "@/features/settings/stores/settings-nav-store";
import { openSettingsSection } from "@/features/settings/lib/open-settings";
import type { SwitchableAgent } from "@/types/agent";
import { nextAfterParking, type SidebarSession } from "./sidebar-sessions";

/** How long the Undo on a settle, snooze or unpin stays up. */
const UNDO_MS = 5_000;

/** What the handlers read at call time: the list as shown, and the session
 *  the window is looking at. */
export interface SidebarListSnapshot {
  pinned: readonly SidebarSession[];
  active: readonly SidebarSession[];
  settled: readonly SidebarSession[];
  activeSessionId: string | null;
}

const lifecycle = () => useSessionLifecycleStore.getState().actions;

export function openSession(session: SidebarSession, intoTab?: string): void {
  void openThread(session, intoTab ? { intoTab } : {});
}

/** The open session was just parked (settled or snoozed): move its tab on to
 *  the next session in the list, or a fresh one when there is none. A row
 *  already open in another tab is skipped — opening it would focus that tab
 *  and leave this one showing the parked session. */
function advanceFrom(session: SidebarSession, list: SidebarListSnapshot): void {
  const tabId = tabShowingSession(session.sessionId);
  const rows = [...list.pinned, ...list.active].filter(
    (row) => row.threadId === session.threadId || !tabShowingSession(row.sessionId),
  );
  const next = nextAfterParking(rows, session.threadId);
  if (next && next.threadId !== session.threadId) openSession(next, tabId ?? undefined);
  else openNewAgentChat();
}

export async function settleSession(
  session: SidebarSession,
  list: SidebarListSnapshot,
): Promise<void> {
  const wasOpen = session.sessionId !== "" && session.sessionId === list.activeSessionId;
  if (!(await lifecycle().settle(session.threadId))) return;
  if (wasOpen) advanceFrom(session, list);
  toast("Session settled", {
    duration: UNDO_MS,
    action: {
      label: "Undo",
      onClick: () => {
        void lifecycle()
          .unsettle(session.threadId)
          .then((ok) => {
            if (ok && wasOpen) openSession(session);
          });
      },
    },
  });
}

export function unsettleSession(session: SidebarSession): void {
  void lifecycle().unsettle(session.threadId);
}

export async function snoozeSession(
  session: SidebarSession,
  until: string,
  list: SidebarListSnapshot,
): Promise<void> {
  const wasOpen = session.sessionId !== "" && session.sessionId === list.activeSessionId;
  if (!(await lifecycle().snooze(session.threadId, until))) return;
  if (wasOpen) advanceFrom(session, list);
  toast("Session snoozed", {
    duration: UNDO_MS,
    action: { label: "Undo", onClick: () => void lifecycle().wake(session.threadId) },
  });
}

export function pinSession(session: SidebarSession, list: SidebarListSnapshot): void {
  void lifecycle().pin(session.threadId, pinOrderKeyForNewPin(list.pinned[0]?.pinOrder ?? null));
}

export async function unpinSession(session: SidebarSession): Promise<void> {
  const key = session.pinOrder;
  if (!(await lifecycle().unpin(session.threadId))) return;
  toast("Session unpinned", {
    duration: UNDO_MS,
    action: {
      label: "Undo",
      onClick: () => void lifecycle().pin(session.threadId, key ?? undefined),
    },
  });
}

/**
 * Drop a pinned session at `index` among the pinned (`orderedIds` is the
 * section's new order, with the moved session in it). Usually one write; a
 * section with a key that cannot be split is re-keyed whole.
 */
export async function reorderPinned(
  movedId: string,
  orderedIds: readonly string[],
  list: SidebarListSnapshot,
): Promise<void> {
  const keysById = new Map(list.pinned.map((row) => [row.threadId, row.pinOrder]));
  const plan = planPinnedReorder({ orderedIds, keysById, movedId });
  for (const { id, orderKey } of plan) {
    if (keysById.has(id)) await lifecycle().reorderPin(id, orderKey);
    else await lifecycle().pin(id, orderKey);
  }
}

export function markUnread(session: SidebarSession): void {
  void lifecycle().markUnread(session.threadId);
}

export function markRead(session: SidebarSession): void {
  if (!session.sessionId) return;
  markSessionViewed(session.sessionId).catch((err: unknown) =>
    toast.error(`Couldn't mark read: ${err instanceof Error ? err.message : String(err)}`),
  );
}

export function wakeSession(session: SidebarSession): void {
  void lifecycle().wake(session.threadId);
}

export async function renameSession(session: SidebarSession, title: string): Promise<void> {
  const next = title.trim();
  if (!next || next === session.title) return;
  await lifecycle().rename(session.threadId, next);
}

export async function deleteSession(session: SidebarSession): Promise<void> {
  if (!(await confirmDeleteChat(session.title))) return;
  try {
    // One call for every agent: Atlas's row always, the agent's copy only
    // when it advertised that it can forget it (ADR-0001).
    await deleteThread(session.threadId);
    const tabId = tabShowingSession(session.sessionId);
    if (tabId) useChatStore.getState().actions.clearSession(tabId);
  } catch (err) {
    toast.error(
      `Couldn't delete session: ${
        typeof err === "object" && err !== null && "message" in err
          ? String((err as { message: unknown }).message)
          : String(err)
      }`,
    );
  }
}

/** Make `path` the active project, registering it in the active organisation
 *  when it is not open there. */
async function activateProject(path: string): Promise<void> {
  if (useAppStore.getState().currentProject?.path === path) return;
  const store = useProjectStore.getState();
  const orgId = useOrgStore.getState().activeOrganisationId;
  const project = store.projects.find((p) => p.path === path && p.orgId === orgId);
  if (project) await store.actions.switchTo(project.id);
  else await store.actions.addProject(path);
}

/**
 * A fresh session on the branch this one ran on, with the same agent. A
 * session in its own worktree is already on its branch; one in the project's
 * checkout switches the checkout to the branch first — and stops there if git
 * refuses (uncommitted changes in the way), saying why.
 */
export async function newSessionOnBranch(session: SidebarSession): Promise<void> {
  await activateProject(session.projectPath);
  if (session.branch && session.cwd === session.projectPath) {
    const git = useGitStore.getState();
    if (git.isRepo && git.branch !== session.branch) {
      try {
        await git.actions.checkout(session.branch);
      } catch (err) {
        toast.error(`Couldn't switch to ${session.branch}`, { description: String(err) });
        return;
      }
    }
  }
  const agent = AGENT_TYPE_BY_SIDEBAR[session.agent] ?? (session.agent as SwitchableAgent);
  openNewAgentChat(agent);
}

/** The project's own settings: the Settings screen, scoped to its folder. */
export function openProjectSettings(projectPath: string): void {
  useSettingsNav.getState().setScope(projectPath);
  openSettingsSection("general");
}

export async function copyToClipboard(value: string, what: string): Promise<void> {
  if (await copyText(value)) toast.success(`${what} copied`);
  else toast.error(`Couldn't copy the ${what.toLowerCase()}`);
}
