import { lazy, Suspense, useCallback } from "react";
import { Segmented, type SegmentedOption } from "@/ui/segmented";
import { PanelSkeleton } from "@/components/panel-skeleton";
import { requestDiffJump } from "../../lib/diff-jump";
import { useDiffPanelStore } from "../../stores/diff-panel-store";
import { useReviewViewStore, type ReviewView } from "../../stores/review-view-store";
import { DiffPanel } from "./diff-panel";

export type { ReviewView };

// The tree pulls in the explorer's file operations and drag hooks; a panel
// that only ever shows the diff should not load them.
const ProjectFileTree = lazy(() =>
  import("@/features/explorer/components/project-file-tree").then((m) => ({
    default: m.ProjectFileTree,
  })),
);

const VIEWS: readonly SegmentedOption<ReviewView>[] = [
  { value: "diff", label: "Changes" },
  { value: "files", label: "Files" },
];

/**
 * What a review surface beside the session shows: the diff, or the project's
 * files. Each view is a branch here rather than a new tab type, so the two
 * share one surface the way they share one right panel, and the switch
 * between them heads both.
 */
export interface ReviewPanelProps {
  tabId: string;
  repoPath: string;
  sessionId?: string | null;
  /** The view before the reader has picked one for this panel. */
  view?: ReviewView;
}

export function ReviewPanel({
  tabId,
  repoPath,
  sessionId = null,
  view: initialView = "diff",
}: ReviewPanelProps) {
  const view = useReviewViewStore((s) => s.view[tabId]) ?? initialView;
  const { setView } = useReviewViewStore.use.actions();

  // From a changed file in the tree to its diff, in this same panel. The jump
  // waits for the diff view to mount and take it (see `diff-jump.ts`).
  const showDiff = useCallback(
    (path: string) => {
      useDiffPanelStore.getState().actions.setScope(tabId, "working-tree");
      requestDiffJump(tabId, path);
      setView(tabId, "diff");
    },
    [tabId, setView],
  );

  const backToDiff = useCallback(() => setView(tabId, "diff"), [tabId, setView]);

  const switcher = (
    <Segmented
      size="sm"
      aria-label="Review view"
      value={view}
      options={VIEWS}
      onValueChange={(next) => setView(tabId, next)}
    />
  );

  switch (view) {
    case "files":
      return (
        <Suspense fallback={<PanelSkeleton rows={10} />}>
          <ProjectFileTree
            root={repoPath}
            leading={switcher}
            onShowDiff={showDiff}
            // The opened file's tab carries the tree from here on, so this
            // panel goes back to being the diff rather than a second tree.
            onFileOpened={backToDiff}
          />
        </Suspense>
      );
    case "diff":
    default:
      // `actions` is where commit, push and branch controls go when source
      // control moves into this panel.
      return (
        <DiffPanel tabId={tabId} repoPath={repoPath} sessionId={sessionId} leading={switcher} />
      );
  }
}
