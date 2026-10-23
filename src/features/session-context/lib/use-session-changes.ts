// The Changes row's numbers for a chat tab: the same join the thread
// overview's Changes card makes (`mergeChanges` over the capture record and
// the transcript's own tally), reduced to a total.
//
// Atlas has no branch-vs-base diffstat command; what it does have is the
// session's own record of what it changed, which is the more useful number on
// a thread's overlay anyway — it is what *this* agent did.

import { useMemo } from "react";

import { useSessionFiles } from "@/features/chat/lib/session-files";
import { mergeChanges, tallyChanges, type ChangeRow } from "@/features/chat/lib/thread-overview";
import { useChatStore } from "@/features/chat/stores/chat-store";

export interface SessionChanges {
  rows: ChangeRow[];
  /** Summed over the rows that carry line counts; `null` when none do. */
  added: number | null;
  removed: number | null;
  /** What `openSessionChanges` needs; `null` before the session binds. */
  sessionId: string | null;
}

export function useSessionChanges(
  tabId: string | null,
  projectPath: string | null,
): SessionChanges {
  const sessionId = useChatStore((s) => (tabId ? (s.sessions[tabId]?.acpSessionId ?? null) : null));
  const messages = useChatStore((s) => (tabId ? s.sessions[tabId]?.messages : undefined));
  const live = useChatStore((s) => (tabId ? s.sessions[tabId]?.turnScratch?.tools : undefined));
  const recorded = useSessionFiles(projectPath, sessionId);
  return useMemo(() => {
    const tally = tallyChanges(messages ?? [], live);
    const rows = mergeChanges(recorded, tally, projectPath ?? "");
    let added = 0;
    let removed = 0;
    let counted = false;
    for (const row of rows) {
      if (row.added === undefined || row.removed === undefined) continue;
      counted = true;
      added += row.added;
      removed += row.removed;
    }
    return {
      rows,
      added: counted ? added : null,
      removed: counted ? removed : null,
      sessionId,
    };
  }, [messages, live, recorded, projectPath, sessionId]);
}
