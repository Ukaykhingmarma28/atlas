// What `atlas:open-turn-diff` does once it reaches the chat that owns the turn:
// show that turn's changes in the review panel beside the session, in the
// turn's own scope, scrolled to the file.
//
// The panel is the session's changes tab (`openSessionChanges`), so a turn
// opened twice walks one tab rather than stacking them, and the reader can
// widen the same view to the whole session or the working tree from its
// scope menu.

import { useAppStore } from "@/features/app/stores/app-store";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { openSessionChanges } from "@/features/git/lib/open-session-changes";
import { useChatStore } from "../stores/chat-store";
import { collectTurnEdits } from "./turn-edits";
import type { TurnDiffRequest } from "./open-turn-diff";

/** Show `request`'s turn of the chat in `tabId`. False when there is nothing
 *  to show it in (no project, an unbound session) or nothing to show. */
export function showTurnDiff(tabId: string, request: TurnDiffRequest): boolean {
  const projectPath = useAppStore.getState().currentProject?.path ?? "";
  const session = useChatStore.getState().sessions[tabId];
  const sessionId = session?.acpSessionId;
  if (!projectPath || !sessionId) return false;
  const edits = collectTurnEdits(session.messages, request.turnId, projectPath, request.file);
  if (edits.files.length === 0) return false;
  openSessionChanges({
    projectPath,
    sessionId,
    file: edits.initial,
    title: useLayoutStore.getState().tabs.find((t) => t.id === tabId)?.title,
    turnId: request.turnId,
  });
  return true;
}
