import { DiffPanel } from "./diff-panel";

/**
 * What a review surface beside the session shows. One view today; the
 * project's file tree joins as `files`, and each view is a branch here rather
 * than a new tab type, so the two share one surface the way they share one
 * right panel.
 */
export type ReviewView = "diff";

export interface ReviewPanelProps {
  tabId: string;
  repoPath: string;
  sessionId?: string | null;
  view?: ReviewView;
}

export function ReviewPanel({
  tabId,
  repoPath,
  sessionId = null,
  view = "diff",
}: ReviewPanelProps) {
  switch (view) {
    case "diff":
      // `actions` is where commit, push and branch controls go when source
      // control moves into this panel.
      return <DiffPanel tabId={tabId} repoPath={repoPath} sessionId={sessionId} />;
  }
}
