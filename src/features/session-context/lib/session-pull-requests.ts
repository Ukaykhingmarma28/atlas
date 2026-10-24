// The session's pull requests: every pull request opened from the branch the
// session works on, newest activity first, through the pull-request data
// layer (`pr_list` with a `head:` filter).
//
// A session's pull requests are the ones it has touched. An Atlas session's
// work lands on its branch, so the branch's pull requests — open, merged and
// closed — are those. The first row is the
// one that matters now (the open one, if any); the rest fold under
// "Show N more".

import { useMemo } from "react";

import { usePrList } from "@/features/pull-requests/lib/pull-requests-queries";
import type { PrListEntry } from "@/features/pull-requests/lib/pull-requests-types";

/** How many of the branch's pull requests to ask for. */
const LIMIT = 20;

export interface SessionPullRequests {
  /** The open one when there is one, else the most recently active. */
  current: PrListEntry | null;
  /** The rest, newest activity first. */
  rest: PrListEntry[];
  /** Whether the branch has an open pull request (Create PR steps aside). */
  hasOpen: boolean;
  loading: boolean;
}

/** Split the branch's pull requests into the one to show and the rest. */
export function orderSessionPullRequests(entries: readonly PrListEntry[]): {
  current: PrListEntry | null;
  rest: PrListEntry[];
} {
  const sorted = [...entries].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const open = sorted.find((e) => e.state === "open") ?? null;
  const current = open ?? sorted[0] ?? null;
  return { current, rest: sorted.filter((e) => e !== current) };
}

export function useSessionPullRequests(
  projectPath: string | null,
  branch: string | null,
): SessionPullRequests {
  const query = useMemo(() => ({ state: "all" as const, head: branch, limit: LIMIT }), [branch]);
  const list = usePrList(branch ? projectPath : null, query);
  return useMemo(() => {
    const { current, rest } = orderSessionPullRequests(list.data?.entries ?? []);
    return {
      current,
      rest,
      hasOpen: current?.state === "open",
      loading: list.isLoading,
    };
  }, [list.data, list.isLoading]);
}
