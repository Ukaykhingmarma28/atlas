// The pull-request reads as react-query hooks: one key family per checkout,
// stale times matched to how fast each answer actually changes, and one
// invalidation an agent's turn end can call.
//
// Freshness, in three layers:
//  - stale times per read (below) — a list moves faster than a merged pull
//    request's detail, which effectively never does;
//  - a slow poll (`REFRESH_INTERVAL_MS`) while a read is on screen, plus a
//    refetch when the window regains focus;
//  - `invalidatePullRequestQueries` on an agent's turn end, which is when a
//    session is likely to have pushed.
// Conditional REST reads cost no quota when nothing changed (the native
// side revalidates with an ETag), so the poll is cheaper than it looks.

import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";

import { ghGate, prRetryDelay, shouldRetryPrError } from "./pr-errors";
import {
  prAction,
  prActivity,
  prComment,
  prCommits,
  prDetail,
  prDiff,
  prFilesViewed,
  prLabelCandidates,
  prReviewerCandidates,
  prList,
  prProvider,
  prReact,
  prReplyToThread,
  prRequestReviewers,
  prResolveThread,
  prSetFilesViewed,
  prSetLabels,
  prSubmitReview,
  prTimeline,
  prUpdate,
} from "./pull-requests-api";
import type {
  PrActionInput,
  PrActivity,
  PrCommitsPage,
  PrDetail,
  PrDiffResult,
  PrError,
  PrFilesViewed,
  PrFileViewedChange,
  PrLabelCandidates,
  PrReviewerCandidates,
  PrListQuery,
  PrListResult,
  PrProvider,
  PrReactionContent,
  PrReviewCommentDraft,
  PrReviewerRef,
  PrReviewVerdict,
  PrTimelinePage,
} from "./pull-requests-types";

export const STALE = {
  list: 30_000,
  detail: 60_000,
  /** A merged pull request changes only by new comments. */
  mergedDetail: 10 * 60_000,
  activity: 60_000,
  checks: 15_000,
  diff: 60_000,
  /** A commit's diff never changes. */
  commitDiff: 10 * 60_000,
  filesViewed: 15_000,
  provider: 10 * 60_000,
} as const;

export const REFRESH_INTERVAL_MS = 5 * 60_000;

/** Every key starts with this and the checkout, so one call clears a checkout. */
export const pullRequestKeys = {
  all: (cwd: string) => ["pull-requests", cwd] as const,
  provider: (cwd: string) => ["pull-requests", cwd, "provider"] as const,
  list: (cwd: string, query: PrListQuery) => ["pull-requests", cwd, "list", query] as const,
  pull: (cwd: string, number: number) => ["pull-requests", cwd, "pull", number] as const,
  detail: (cwd: string, number: number) =>
    ["pull-requests", cwd, "pull", number, "detail"] as const,
  activity: (cwd: string, number: number) =>
    ["pull-requests", cwd, "pull", number, "activity"] as const,
  timeline: (cwd: string, number: number, cursor: string | null) =>
    ["pull-requests", cwd, "pull", number, "timeline", cursor] as const,
  commits: (cwd: string, number: number, cursor: string | null) =>
    ["pull-requests", cwd, "pull", number, "commits", cursor] as const,
  diff: (cwd: string, number: number, cursor: string | null, commit: string | null) =>
    ["pull-requests", cwd, "pull", number, "diff", cursor, commit] as const,
  filesViewed: (cwd: string, number: number) =>
    ["pull-requests", cwd, "pull", number, "files-viewed"] as const,
  reviewerCandidates: (cwd: string, number: number) =>
    ["pull-requests", cwd, "pull", number, "reviewer-candidates"] as const,
  labelCandidates: (cwd: string, number: number) =>
    ["pull-requests", cwd, "pull", number, "label-candidates"] as const,
};

/** Shared by every read: retry only what is transient, with back-off; never
 *  poll while the gh gate is closed. */
const COMMON = {
  retry: shouldRetryPrError,
  retryDelay: (attempt: number) => prRetryDelay(attempt),
  refetchOnWindowFocus: true,
  refetchInterval: () => (ghGate() ? false : REFRESH_INTERVAL_MS),
  refetchIntervalInBackground: false,
} as const;

type Result<T> = UseQueryResult<T, PrError>;

export function usePrProvider(cwd: string | null): Result<PrProvider> {
  return useQuery<PrProvider, PrError>({
    ...COMMON,
    queryKey: pullRequestKeys.provider(cwd ?? ""),
    queryFn: () => prProvider(cwd!),
    enabled: !!cwd,
    staleTime: STALE.provider,
    refetchInterval: false,
  });
}

export function usePrList(cwd: string | null, query: PrListQuery = {}): Result<PrListResult> {
  return useQuery<PrListResult, PrError>({
    ...COMMON,
    queryKey: pullRequestKeys.list(cwd ?? "", query),
    queryFn: () => prList(cwd!, query),
    enabled: !!cwd,
    staleTime: STALE.list,
  });
}

/** How long a detail stays fresh: a merged one barely changes, and an open
 *  one with checks still running changes fastest of all. */
export function detailStaleTime(detail: PrDetail | undefined): number {
  if (!detail) return STALE.detail;
  if (detail.state === "merged") return STALE.mergedDetail;
  if (detail.state === "open" && detail.checksState === "pending") return STALE.checks;
  return STALE.detail;
}

export function usePrDetail(cwd: string | null, number: number | null): Result<PrDetail> {
  return useQuery<PrDetail, PrError>({
    ...COMMON,
    queryKey: pullRequestKeys.detail(cwd ?? "", number ?? 0),
    queryFn: () => prDetail(cwd!, number!),
    enabled: !!cwd && !!number,
    staleTime: (query) => detailStaleTime(query.state.data),
  });
}

export function usePrActivity(cwd: string | null, number: number | null): Result<PrActivity> {
  return useQuery<PrActivity, PrError>({
    ...COMMON,
    queryKey: pullRequestKeys.activity(cwd ?? "", number ?? 0),
    queryFn: () => prActivity(cwd!, number!),
    enabled: !!cwd && !!number,
    staleTime: STALE.activity,
  });
}

export function usePrTimeline(
  cwd: string | null,
  number: number | null,
  cursor: string | null = null,
): Result<PrTimelinePage> {
  return useQuery<PrTimelinePage, PrError>({
    ...COMMON,
    queryKey: pullRequestKeys.timeline(cwd ?? "", number ?? 0, cursor),
    queryFn: () => prTimeline(cwd!, number!, cursor),
    enabled: !!cwd && !!number,
    staleTime: STALE.activity,
  });
}

export function usePrCommits(
  cwd: string | null,
  number: number | null,
  cursor: string | null = null,
): Result<PrCommitsPage> {
  return useQuery<PrCommitsPage, PrError>({
    ...COMMON,
    queryKey: pullRequestKeys.commits(cwd ?? "", number ?? 0, cursor),
    queryFn: () => prCommits(cwd!, number!, cursor),
    enabled: !!cwd && !!number,
    staleTime: STALE.activity,
  });
}

export function usePrDiff(
  cwd: string | null,
  number: number | null,
  cursor: string | null = null,
  commit: string | null = null,
): Result<PrDiffResult> {
  return useQuery<PrDiffResult, PrError>({
    ...COMMON,
    queryKey: pullRequestKeys.diff(cwd ?? "", number ?? 0, cursor, commit),
    queryFn: () => prDiff(cwd!, number!, cursor, commit),
    enabled: !!cwd && !!number,
    staleTime: commit ? STALE.commitDiff : STALE.diff,
    // A commit's diff is immutable, and a whole patch is too large to poll.
    refetchInterval: false,
  });
}

export function usePrFilesViewed(cwd: string | null, number: number | null): Result<PrFilesViewed> {
  return useQuery<PrFilesViewed, PrError>({
    ...COMMON,
    queryKey: pullRequestKeys.filesViewed(cwd ?? "", number ?? 0),
    queryFn: () => prFilesViewed(cwd!, number!),
    enabled: !!cwd && !!number,
    staleTime: STALE.filesViewed,
  });
}

/** The reviewer picker's rows. Read only while the picker is open
 *  (`enabled`): most readers never open it. */
export function usePrReviewerCandidates(
  cwd: string,
  number: number,
  enabled: boolean,
): Result<PrReviewerCandidates> {
  return useQuery<PrReviewerCandidates, PrError>({
    ...COMMON,
    queryKey: pullRequestKeys.reviewerCandidates(cwd, number),
    queryFn: () => prReviewerCandidates(cwd, number),
    enabled,
    staleTime: STALE.detail,
    refetchInterval: false,
  });
}

/** The label picker's rows, read only while it is open. */
export function usePrLabelCandidates(
  cwd: string,
  number: number,
  enabled: boolean,
): Result<PrLabelCandidates> {
  return useQuery<PrLabelCandidates, PrError>({
    ...COMMON,
    queryKey: pullRequestKeys.labelCandidates(cwd, number),
    queryFn: () => prLabelCandidates(cwd, number),
    enabled,
    staleTime: STALE.detail,
    refetchInterval: false,
  });
}

/** Mark every pull-request read for a checkout stale — what an agent's turn
 *  end calls, since a push is likely to have changed them. Only queries on
 *  screen refetch. */
export function invalidatePullRequestQueries(client: QueryClient, cwd: string): Promise<void> {
  return client.invalidateQueries({ queryKey: pullRequestKeys.all(cwd) });
}

// ── writes ──────────────────────────────────────────────────────────────

/** A write on one pull request; on success its reads (and the checkout's
 *  listings) are marked stale. */
function usePrMutation<V>(
  cwd: string,
  number: number,
  run: (vars: V) => Promise<void>,
  options: { listings?: boolean } = {},
) {
  const client = useQueryClient();
  return useMutation<void, PrError, V>({
    mutationFn: run,
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: pullRequestKeys.pull(cwd, number) });
      if (options.listings) {
        await client.invalidateQueries({ queryKey: ["pull-requests", cwd, "list"] });
      }
    },
  });
}

export function usePrActionMutation(cwd: string, number: number) {
  return usePrMutation<PrActionInput>(cwd, number, (input) => prAction(cwd, number, input), {
    listings: true,
  });
}

export function usePrCommentMutation(cwd: string, number: number) {
  return usePrMutation<string>(cwd, number, (body) => prComment(cwd, number, body));
}

export function usePrReplyMutation(cwd: string, number: number) {
  return usePrMutation<{ threadId: string; body: string }>(cwd, number, ({ threadId, body }) =>
    prReplyToThread(cwd, number, threadId, body),
  );
}

export function usePrResolveMutation(cwd: string, number: number) {
  return usePrMutation<{ threadId: string; resolved: boolean }>(
    cwd,
    number,
    ({ threadId, resolved }) => prResolveThread(cwd, number, threadId, resolved),
  );
}

export function usePrReactMutation(cwd: string, number: number) {
  return usePrMutation<{ subjectId: string | null; content: PrReactionContent; reacted: boolean }>(
    cwd,
    number,
    ({ subjectId, content, reacted }) => prReact(cwd, number, subjectId, content, reacted),
  );
}

export function usePrSubmitReviewMutation(cwd: string, number: number) {
  return usePrMutation<{
    verdict: PrReviewVerdict;
    body: string;
    comments: PrReviewCommentDraft[];
  }>(
    cwd,
    number,
    ({ verdict, body, comments }) => prSubmitReview(cwd, number, verdict, body, comments),
    { listings: true },
  );
}

export function usePrUpdateMutation(cwd: string, number: number) {
  return usePrMutation<{ title: string | null; body: string | null }>(
    cwd,
    number,
    ({ title, body }) => prUpdate(cwd, number, title, body),
    { listings: true },
  );
}

export function usePrReviewersMutation(cwd: string, number: number) {
  return usePrMutation<{ reviewers: PrReviewerRef[]; requested: boolean }>(
    cwd,
    number,
    ({ reviewers, requested }) => prRequestReviewers(cwd, number, reviewers, requested),
  );
}

export function usePrLabelsMutation(cwd: string, number: number) {
  return usePrMutation<{ labels: string[]; applied: boolean }>(
    cwd,
    number,
    ({ labels, applied }) => prSetLabels(cwd, number, labels, applied),
    { listings: true },
  );
}

/** Ticking files viewed updates the cache at once and rolls back on failure:
 *  a reader clearing files one after another should not wait on GitHub. */
export function usePrSetFilesViewedMutation(cwd: string, number: number) {
  const client = useQueryClient();
  const key = pullRequestKeys.filesViewed(cwd, number);
  return useMutation<void, PrError, PrFileViewedChange[], { previous?: PrFilesViewed }>({
    mutationFn: (files) => prSetFilesViewed(cwd, number, files),
    onMutate: async (files) => {
      await client.cancelQueries({ queryKey: key });
      const previous = client.getQueryData<PrFilesViewed>(key);
      if (previous) {
        const next = new Map(previous.files.map((f) => [f.path, f.state]));
        for (const f of files) next.set(f.path, f.viewed ? "viewed" : "unviewed");
        client.setQueryData<PrFilesViewed>(key, {
          ...previous,
          files: [...next].map(([path, state]) => ({ path, state })),
        });
      }
      return { previous };
    },
    onError: (_error, _files, context) => {
      if (context?.previous) client.setQueryData(key, context.previous);
    },
    onSettled: () => client.invalidateQueries({ queryKey: key }),
  });
}
