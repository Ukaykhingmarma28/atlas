import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { PanelSkeleton } from "@/components/panel-skeleton";
import { useProjectStore } from "@/features/projects/stores/project-store";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { showWorkingTreeDiff } from "@/features/git/lib/open-review-file";
import { useFilesRevealStore } from "../stores/files-reveal-store";
import { relativeTo } from "../lib/project-file-ops";

const ProjectFileTree = lazy(() =>
  import("./project-file-tree").then((m) => ({ default: m.ProjectFileTree })),
);

/**
 * The Files surface: the project tree on its own, for when no file is open
 * yet. Picking a file opens that file's tab and closes this one, since the
 * file tab shows the same tree beside the file (see `files-surface.ts`).
 *
 * A path asked for by `revealFiles(path)` (an agent's `ui_focus` explorer) is
 * highlighted and its folders opened; otherwise the tree follows the file
 * being read. The request is taken once: this surface keeps it while it is
 * open and clears it from the store, so the next Files opened starts fresh.
 */
export function FilesPanel({ tabId, projectId }: { tabId: string; projectId: string | null }) {
  const root = useProjectStore(
    (s) => (projectId && s.projects.find((p) => p.id === projectId)?.path) || null,
  );

  const request = useFilesRevealStore.use.request();
  const [reveal, setReveal] = useState<{ path: string; nonce: number } | null>(null);
  const [seen, setSeen] = useState<number | null>(null);
  // Taken during render, not in an effect: the tree must mount already
  // pointed at the path, not reveal the reader's file for a frame first. A
  // path in another project (or none) means follow the reader.
  if (root && request && request.nonce !== seen) {
    setSeen(request.nonce);
    const path = request.path;
    setReveal(
      path !== null && relativeTo(root, path) !== null ? { path, nonce: request.nonce } : null,
    );
  }
  const { take } = useFilesRevealStore.use.actions();
  useEffect(() => {
    if (root && request) take();
  }, [root, request, take]);
  // Nothing outlives the surface: a request it never read is stale once it
  // closes.
  useEffect(() => take, [take]);

  const handOff = useCallback(() => {
    useLayoutStore.getState().actions.closeTab(tabId);
  }, [tabId]);

  const showDiff = useCallback((path: string) => root && showWorkingTreeDiff(root, path), [root]);

  if (!root) {
    return (
      <div className="flex h-full items-center justify-center px-4 text-center text-sm text-muted-foreground">
        Open a project to browse its files.
      </div>
    );
  }
  return (
    <Suspense fallback={<PanelSkeleton rows={10} />}>
      <ProjectFileTree
        root={root}
        onShowDiff={showDiff}
        onFileOpened={handOff}
        activeFile={reveal ? reveal.path : undefined}
        revealNonce={reveal?.nonce}
      />
    </Suspense>
  );
}
