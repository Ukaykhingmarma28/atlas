/**
 * The composer's handles on a session's attached projects.
 *
 * `SessionProjectsContext` hands the chips the session id. Chip node views
 * render inside the editor's React tree, so a provider around the composer
 * reaches them. The list itself is in `session-projects-store`, kept current
 * by the composer's history read (`use-live-elsewhere-feed.ts`).
 */

import { createContext, useContext } from "react";
import { toast } from "sonner";

import type { ProjectAccess } from "../lib/history-api";
import { setSessionProjectAccess } from "../lib/session-projects-api";
import { useSessionProjectsStore } from "../stores/session-projects-store";

/** The live ACP session id the composer sends to; `null` before it binds. */
export const SessionProjectsContext = createContext<string | null>(null);

export function useComposerSessionId(): string | null {
  return useContext(SessionProjectsContext);
}

/**
 * Change an attached project's access and say when it takes effect. A grant
 * the agent's sandbox cannot take mid-session (an ACP agent) is kept and
 * applied when the session is next resumed; the toast says so rather than
 * letting the user believe the agent can already write there.
 */
export async function changeProjectAccess(
  sessionId: string,
  path: string,
  access: ProjectAccess,
): Promise<void> {
  try {
    const change = await setSessionProjectAccess(sessionId, path, access);
    useSessionProjectsStore.getState().actions.replace(sessionId, change.projects);
    if (change.changed && access === "read_write" && !change.appliedLive) {
      toast.message("Write access saved", {
        description: "This agent picks it up when the session is resumed.",
      });
    }
  } catch (err) {
    toast.error("Could not change the project's access", { description: String(err) });
  }
}
