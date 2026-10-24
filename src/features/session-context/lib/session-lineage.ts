// The sessions related to this one: the session it was branched from, and the
// sessions branched from it ("Branch from here"). Subagents — the agents it
// delegated to — come from the transcript (`useSubagents`), not from here.
//
// The fork edges are Atlas's own record (`session_forks` in the thread
// store), carried on each history row as `forkedFromSessionId`. One history
// read answers both directions: this row's parent, and every row that names
// this session as its parent. It refreshes on the store's change event, the
// same signal the sidebar listens to.

import { useEffect, useMemo, useState } from "react";

import { onThreadsChanged, threadHistory, type ThreadRow } from "@/features/chat/lib/history-api";
import { openThread } from "@/features/chat/lib/open-thread";
import { sidebarAgentOf } from "@/features/chat/lib/sidebar-agents";

export type LineageRelation = "parent" | "fork";

export interface LineageEdge {
  relation: LineageRelation;
  row: ThreadRow;
}

/** The parent first, then the forks newest first. Pure, for the test. */
export function lineageEdges(rows: readonly ThreadRow[], sessionId: string | null): LineageEdge[] {
  if (!sessionId) return [];
  const self = rows.find((r) => r.sessionId === sessionId);
  const parentId = self?.forkedFromSessionId ?? null;
  const parent = parentId ? rows.find((r) => r.sessionId === parentId) : undefined;
  const forks = rows
    .filter((r) => r.forkedFromSessionId === sessionId && r.sessionId !== sessionId)
    .sort((a, b) => (b.createdAt ?? b.updatedAt).localeCompare(a.createdAt ?? a.updatedAt));
  return [
    ...(parent ? [{ relation: "parent" as const, row: parent }] : []),
    ...forks.map((row) => ({ relation: "fork" as const, row })),
  ];
}

/** The history rows, re-read whenever the thread store changes. */
export function useThreadHistory(enabled: boolean): ThreadRow[] {
  const [rows, setRows] = useState<ThreadRow[]>([]);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    const load = () =>
      void threadHistory()
        .then((next) => {
          if (live) setRows(next ?? []);
        })
        .catch(() => {});
    load();
    const unlisten = onThreadsChanged(load);
    return () => {
      live = false;
      void unlisten.then((stop) => stop());
    };
  }, [enabled]);
  return rows;
}

export function useSessionLineage(sessionId: string | null): LineageEdge[] {
  const rows = useThreadHistory(!!sessionId);
  return useMemo(() => lineageEdges(rows, sessionId), [rows, sessionId]);
}

/** Open a related session: its tab if one shows it, else resumed. */
export function openLineageSession(row: ThreadRow, fallbackProjectPath: string): void {
  const cwd = row.folderPaths[0] ?? fallbackProjectPath;
  void openThread({
    threadId: row.threadId,
    sessionId: row.sessionId ?? "",
    title: row.title,
    agent: sidebarAgentOf(row.agentId),
    cwd,
    projectPath: fallbackProjectPath || cwd,
  });
}
