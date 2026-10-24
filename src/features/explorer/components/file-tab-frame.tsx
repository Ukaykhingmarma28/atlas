import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { PanelLeftOpen } from "lucide-react";
import { IconButton } from "@/ui/icon-button";
import { cn } from "@/lib/utils";
import { FILE_SURFACE_SUBHEADER_CLASS } from "@/features/editor/components/file-surface-chrome";
import { Hint } from "@/ui/tooltip";
import { PanelSkeleton } from "@/components/panel-skeleton";
import { useProjectStore } from "@/features/projects/stores/project-store";
import { groupOf, useLayoutStore } from "@/features/layout/stores/layout-store";
import { useFileTabTreeStore } from "../stores/file-tab-tree-store";
import { relativeTo } from "../lib/project-file-ops";
import { FileTabFrameContext, type FileTabFrameValue } from "../lib/file-tab-frame-context";
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
  const project = useProjectStore((s) =>
    projectId ? (s.projects.find((p) => p.id === projectId) ?? null) : null,
  );
  const root = project?.path || null;
  const shown = useFileTabTreeStore.use.shown();
  const { setShown } = useFileTabTreeStore.use.actions();
  const active = useLayoutStore((s) => {
    const tab = s.tabs.find((t) => t.id === tabId);
    return !!tab && s.activeByGroup[groupOf(tab)] === tabId;
  });
  // The main column draws no tab strip; every other column, and the
  // projectless strip, has a tab naming the file.
  const titled = useLayoutStore((s) => {
    if (projectId === null) return true;
    const tab = s.tabs.find((t) => t.id === tabId);
    return !tab || groupOf(tab) !== s.groupOrder[0];
  });

  // Each time the tab comes back on screen (or its file is opened again,
  // which focuses it), reveal its file afresh.
  const [revealNonce, setRevealNonce] = useState(0);
  const wasActive = useRef(active);
  useEffect(() => {
    if (active && !wasActive.current) setRevealNonce((n) => n + 1);
    wasActive.current = active;
  }, [active]);

  // The folder the file's breadcrumbs walked up to, revealed in the tree.
  // Back at the file (its tab shown again, the file crumb, another file)
  // the crumbs end at the file again.
  const [crumbFolder, setCrumbFolder] = useState<{ path: string; nonce: number } | null>(null);
  const [crumbFor, setCrumbFor] = useState({ filePath, revealNonce });
  if (crumbFor.filePath !== filePath || crumbFor.revealNonce !== revealNonce) {
    setCrumbFor({ filePath, revealNonce });
    setCrumbFolder(null);
  }

  const inProject =
    !!root &&
    !!filePath &&
    !filePath.startsWith("untitled:") &&
    relativeTo(root, filePath) !== null;

  const frame = useMemo<FileTabFrameValue>(
    () => ({
      root: inProject ? root : null,
      projectName: inProject ? (project?.name ?? null) : null,
      titled,
      crumbFolder: crumbFolder?.path ?? null,
      revealFolder: (path) => {
        setShown(true);
        setCrumbFolder((cur) => ({ path, nonce: (cur?.nonce ?? 0) + 1 }));
      },
      revealFile: () => {
        setShown(true);
        setRevealNonce((n) => n + 1);
      },
    }),
    [inProject, root, project?.name, titled, crumbFolder, setShown],
  );

  // Always this element tree: the tree column is a slot that may be empty,
  // so `children` keeps its position (and its state) whatever the slot holds.
  return (
    <FileTabFrameContext.Provider value={frame}>
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
                  revealFolder={crumbFolder}
                  subheader
                />
              </Suspense>
            )}
          </aside>
        ) : (
          // The rail's button sits in the file's second row, so that row
          // still reads as one band with the tree hidden.
          <div className="flex shrink-0 flex-col border-r border-border">
            <div className={cn("flex items-center px-1", FILE_SURFACE_SUBHEADER_CLASS)}>
              <Hint label="Show file tree">
                <IconButton
                  size="sm"
                  icon={PanelLeftOpen}
                  label="Show file tree"
                  onClick={() => setShown(true)}
                />
              </Hint>
            </div>
          </div>
        )}
        <div className="h-full min-h-0 min-w-0 flex-1">{children}</div>
      </div>
    </FileTabFrameContext.Provider>
  );
}
