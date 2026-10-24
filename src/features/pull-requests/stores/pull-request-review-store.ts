// Line comments written in the Code tab and not yet sent: a review in
// progress, per pull request. They go to GitHub together with the review's
// verdict and summary (`pr_submit_review`, from the composer's Review mode),
// the way a reviewer works through a change and then submits once. GitHub's
// own pending-review state is not used: nothing here is on GitHub until the
// review is submitted, and the drafts last as long as the app does.

import { create } from "zustand";

import { createSelectors } from "@/lib/create-selectors";

import type { PrReviewCommentDraft } from "../lib/pull-requests-types";

export interface PendingReviewComment extends PrReviewCommentDraft {
  /** A counter, not derived from the comment: two equal remarks on one line
   *  must not share a key, or discarding one would discard both. */
  id: string;
}

let sequence = 0;
export function nextPendingCommentId(): string {
  sequence += 1;
  return `pending-review-comment-${sequence}`;
}

export function reviewKeyOf(repoPath: string, number: number): string {
  return `${repoPath}\0${number}`;
}

interface PullRequestReviewState {
  drafts: Record<string, readonly PendingReviewComment[]>;
  actions: {
    add: (key: string, comment: PendingReviewComment) => void;
    remove: (key: string, id: string) => void;
    /** Drop the ones a submitted review carried, keeping any written since. */
    removeMany: (key: string, ids: readonly string[]) => void;
  };
}

export const NO_PENDING: readonly PendingReviewComment[] = [];

function without(
  drafts: Record<string, readonly PendingReviewComment[]>,
  key: string,
  drop: (c: PendingReviewComment) => boolean,
) {
  const remaining = (drafts[key] ?? NO_PENDING).filter((c) => !drop(c));
  if (remaining.length > 0) return { drafts: { ...drafts, [key]: remaining } };
  const { [key]: _removed, ...rest } = drafts;
  return { drafts: rest };
}

export const usePullRequestReviewStore = createSelectors(
  create<PullRequestReviewState>()((set) => ({
    drafts: {},
    actions: {
      add: (key, comment) =>
        set((s) => ({
          drafts: { ...s.drafts, [key]: [...(s.drafts[key] ?? NO_PENDING), comment] },
        })),
      remove: (key, id) => set((s) => without(s.drafts, key, (c) => c.id === id)),
      removeMany: (key, ids) => {
        const sent = new Set(ids);
        set((s) => without(s.drafts, key, (c) => sent.has(c.id)));
      },
    },
  })),
);

export function usePendingReviewComments(
  repoPath: string,
  number: number,
): readonly PendingReviewComment[] {
  return usePullRequestReviewStore((s) => s.drafts[reviewKeyOf(repoPath, number)] ?? NO_PENDING);
}
