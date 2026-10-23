import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import { PanelLeftOpen } from "lucide-react";
import { IconButton } from "@/ui/icon-button";
import { Hint } from "@/ui/tooltip";
import { PanelSkeleton } from "@/components/panel-skeleton";
import { useAppStore } from "@/features/app/stores/app-store";
import { groupOf, useLayoutStore } from "@/features/layout/stores/layout-store";
import { useFileTabTreeStore } from "../stores/file-tab-tree-store";
import { relativeTo } from "../lib/project-file-ops";

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
 */
export function FileTabFrame({
  tabId,
  filePath,
  children,
}: {
  tabId: string;
  filePath: string | undefined;
  children: ReactNode;
}) {
  const root = useAppStore.use.currentProject()?.path ?? null;
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
  if (!inProject) return <>{children}</>;

  return (
    <div className="flex h-full min-h-0 w-full">
      {shown ? (
        <aside
          className="flex min-h-0 shrink-0 flex-col border-r border-border"
          style={{ width: "min(22rem, 46%)" }}
        >
          {active && (
            <Suspense fallback={<PanelSkeleton rows={8} />}>
              <ProjectFileTree
                root={root}
                activeFile={filePath}
                revealNonce={revealNonce}
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
