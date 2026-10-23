import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import { PanelLeftOpen } from "lucide-react";
import { IconButton } from "@/ui/icon-button";
import { Hint } from "@/ui/tooltip";
import { PanelSkeleton } from "@/components/panel-skeleton";
import { useProjectStore } from "@/features/projects/stores/project-store";
import { groupOf, useLayoutStore } from "@/features/layout/stores/layout-store";
import { useFileTabTreeStore } from "../stores/file-tab-tree-store";
import { relativeTo } from "../lib/project-file-ops";
import { showWorkingTreeDiff } from "@/features/git/lib/open-review-file";

// The tree is the heavy part (its model, file operations, drag hooks); a file
// tab with the tree hidden, or outside the project, never loads it.
const ProjectFileTree = lazy(() =>
  import("./project-file-tree").then((m) => ({ default: m.ProjectFileTree })),
);

/**
 * A file tab's frame: the project tree in a side column beside the file, so
 * picking the next file never means leaving the one you are reading.
 *
 * The tree shows only for a file inside the open project. An attachment, or
 * anything else outside it, has no tree to place it in. Its visibility is
 * one persisted preference for every file tab. The tree mounts only while
 * the tab is on screen: an editor tab stays mounted when hidden, and a dozen
 * open files must not each keep a tree, a watcher subscription and a
 * virtualizer alive. The tree's model is per project, so remounting keeps
 * what was expanded.
 *
 * The frame's shape never changes, only whether its tree column is filled.
 * Editor tabs of background projects stay mounted, and the file they hold
 * goes in and out of "the project" as the user switches; a frame that
 * dropped its wrapper then would remount the editor and lose unsaved edits
 * and undo history. For the same reason the root is the tab's own project,
 * never whichever one happens to be active.
 */
export function FileTabFrame({
  tabId,
  projectId,
  filePath,
  children,
}: {
  tabId: string;
  /** The project the tab belongs to; null for the projectless strip. */
  projectId: string | null;
  filePath: string | undefined;
  children: ReactNode;
}) {
  const root = useProjectStore(
    (s) => (projectId && s.projects.find((p) => p.id === projectId)?.path) || null,
  );
  const shown = useFileTabTreeStore.use.shown();
  const { setShown } = useFileTabTreeStore.use.actions();
  const active = useLayoutStore((s) => {
    const tab = s.tabs.find((t) => t.id === tabId);
    return !!tab && s.activeByGroup[groupOf(tab)] === tabId;
  });

  // Each time the tab comes back on screen (or its file is opened again,
  // which focuses it), reveal its file afresh.
  const [revealNonce, setRevealNonce] = useState(0);
  const wasActive = useRef(active);
  useEffect(() => {
    if (active && !wasActive.current) setRevealNonce((n) => n + 1);
    wasActive.current = active;
  }, [active]);

  const inProject =
    !!root &&
    !!filePath &&
    !filePath.startsWith("untitled:") &&
    relativeTo(root, filePath) !== null;

  // Always this element tree: the tree column is a slot that may be empty,
  // so `children` keeps its position (and its state) whatever the slot holds.
  return (
    <div className="flex h-full min-h-0 w-full">
      {!inProject ? null : shown ? (
        <aside
          className="flex min-h-0 shrink-0 flex-col border-r border-border"
          style={{ width: "min(22rem, 46%)" }}
        >
          {active && (
            <Suspense fallback={<PanelSkeleton rows={8} />}>
              <ProjectFileTree
                root={root!}
                activeFile={filePath}
                revealNonce={revealNonce}
                onShowDiff={(path) => showWorkingTreeDiff(root!, path)}
                onHide={() => setShown(false)}
              />
            </Suspense>
          )}
        </aside>
      ) : (
        <div className="flex shrink-0 flex-col items-center border-r border-border py-1">
          <Hint label="Show file tree">
            <IconButton
              size="sm"
              icon={PanelLeftOpen}
              label="Show file tree"
              onClick={() => setShown(true)}
            />
          </Hint>
        </div>
      )}
      <div className="h-full min-h-0 min-w-0 flex-1">{children}</div>
    </div>
  );
}
