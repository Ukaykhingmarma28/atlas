// Bridge to the native `git_repo_pull_requests` command — a repository's pull
// requests, one per head branch, read through the user's own GitHub CLI
// (`gh`), so private repositories work. Never an error: the result says why
// there is nothing (see `RepoPullRequests`).
//
// One `gh` call per repository, shared by every card in it: the agent sidebar
// mounts all its thread cards at once, and a call per branch was a burst of
// network-bound processes on every open.
//
// A missing or signed-out `gh` holds every repository's read back through the
// shared gh gate (`pull-requests/lib/pr-errors.ts`) — for a bounded time, and
// only until the window is focused again, so a `gh auth login` run in a
// terminal is picked up without restarting Atlas.

import { useCallback } from "react";
import { useQuery, type Query } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";

import { ghGate, noteGhOutcome, resetGhGateForTests } from "@/features/pull-requests/lib/pr-errors";

export interface BranchPullRequest {
  number: number;
  /** Lowercased from GitHub's `OPEN` / `CLOSED` / `MERGED`. */
  state: "open" | "closed" | "merged";
  title: string;
  /** The PR's page on GitHub. */
  url: string;
  isDraft: boolean;
}

/**
 * - `ok` — `gh` answered; `byBranch` holds the PR worth showing per head
 *   branch (an open one if there is one, else the most recently created).
 * - `unavailable` — `gh` is not installed or not signed in. True of every
 *   repository until fixed, so reads wait behind the gh gate.
 * - `failed` — this repository could not be answered for; `reason` says
 *   whether asking again soon can help.
 */
export type RepoPullRequests =
  | { kind: "ok"; byBranch: Record<string, BranchPullRequest> }
  | { kind: "unavailable"; reason: "notInstalled" | "notAuthenticated" }
  | { kind: "failed"; reason: "network" | "rateLimited" | "unsupported" | "other" };

export function repoPullRequests(path: string): Promise<RepoPullRequests> {
  return invoke<RepoPullRequests>("git_repo_pull_requests", { path });
}

/** The query key for one repository's PRs — what a turn end invalidates. */
export function repoPullRequestsKey(cwd: string) {
  return ["repo-pull-requests", cwd] as const;
}

/** Test seam: forget that `gh` was found unavailable. */
export function resetGhAvailabilityForTests(): void {
  resetGhGateForTests();
}

export async function fetchRepoPullRequests(cwd: string): Promise<RepoPullRequests> {
  const held = ghGate();
  if (held?.kind === "notInstalled" || held?.kind === "notAuthenticated") {
    return { kind: "unavailable", reason: held.kind };
  }
  if (held?.kind === "rateLimited") return { kind: "failed", reason: "rateLimited" };
  const result = await repoPullRequests(cwd);
  if (result.kind === "unavailable") {
    noteGhOutcome({ kind: result.reason ?? "notInstalled" });
  } else if (result.kind === "failed" && result.reason === "rateLimited") {
    noteGhOutcome({ kind: "rateLimited" });
  } else if (result.kind === "ok") {
    noteGhOutcome(null);
  }
  return result;
}

/** When to ask again after an answer: an `ok` stays fresh for five minutes
 *  (a turn end invalidates it sooner); a transient failure is retried soon;
 *  anything else waits for the gate, or for the window's next focus. */
export function repoPullRequestsStaleTime(data: RepoPullRequests | undefined): number {
  if (!data) return 0;
  if (data.kind === "ok") return 5 * 60_000;
  if (data.kind === "failed" && data.reason === "unsupported") return 30 * 60_000;
  return 0;
}

export function repoPullRequestsRefetchInterval(
  data: RepoPullRequests | undefined,
): number | false {
  if (data?.kind !== "failed") return false;
  if (data.reason === "network") return 30_000;
  if (data.reason === "rateLimited") return 2 * 60_000;
  return false;
}

/**
 * The PR for `branch` in the repository at `cwd`, or `null`. Every caller in
 * the same repository shares one query; `enabled: false` (a card not yet on
 * screen) asks nothing.
 */
export function useBranchPullRequest(
  cwd: string,
  branch: string | null,
  enabled: boolean,
): BranchPullRequest | null {
  const select = useCallback(
    (data: RepoPullRequests) =>
      data.kind === "ok" && branch ? (data.byBranch[branch] ?? null) : null,
    [branch],
  );
  const { data } = useQuery({
    queryKey: repoPullRequestsKey(cwd),
    queryFn: () => fetchRepoPullRequests(cwd),
    enabled: enabled && !!cwd && !!branch,
    select,
    staleTime: (query: Query<RepoPullRequests>) => repoPullRequestsStaleTime(query.state.data),
    refetchInterval: (query: Query<RepoPullRequests>) =>
      repoPullRequestsRefetchInterval(query.state.data),
    refetchIntervalInBackground: false,
    retry: false,
  });
  return data ?? null;
}

/** Open a PR's page in the system browser. */
export function openPullRequest(url: string): void {
  void openUrl(url).catch(() => window.open(url, "_blank"));
}
