// The Changes row's numbers for a chat tab: the same join the thread
// overview's Changes card makes (`mergeChanges` over the capture record and
// the transcript's own tally), reduced to a total.
//
// Atlas has no branch-vs-base diffstat command; what it does have is the
// session's own record of what it changed, which is the more useful number on
// a thread's overlay anyway — it is what *this* agent did.
//
// The total covers every root the session wrote in: the tally's paths outside
// the main project are absolute and stay in. `byRoot` breaks it down with the
// grouping every changes surface uses (`session-roots.ts`).

import { useMemo } from "react";

import { useSessionRoots } from "@/features/chat/hooks/use-session-roots";
import { useSessionFiles } from "@/features/chat/lib/session-files";
import { groupByRoot } from "@/features/chat/lib/session-roots";
import { mergeChanges, tallyChanges, type ChangeRow } from "@/features/chat/lib/session-overview";
import { useChatStore } from "@/features/chat/stores/chat-store";

/** One root's share of the session's changes. */
export interface RootChanges {
  label: string;
  files: number;
  added: number;
  removed: number;
}

export interface SessionChanges {
  rows: ChangeRow[];
  /** Summed over the rows that carry line counts; `null` when none do. */
  added: number | null;
  removed: number | null;
  /** Per root, when the changes reach past the main project; else empty. */
  byRoot: RootChanges[];
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
  const roots = useSessionRoots(sessionId, projectPath);
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
    const groups = groupByRoot(rows, roots, (row) => row.path);
    const byRoot =
      groups.length > 1
        ? groups.map((g) => {
            let a = 0;
            let r = 0;
            for (const row of g.items) {
              a += row.added ?? 0;
              r += row.removed ?? 0;
            }
            return { label: g.label, files: g.items.length, added: a, removed: r };
          })
        : [];
    return {
      rows,
      added: counted ? added : null,
      removed: counted ? removed : null,
      byRoot,
      sessionId,
    };
  }, [messages, live, recorded, projectPath, sessionId, roots]);
}
