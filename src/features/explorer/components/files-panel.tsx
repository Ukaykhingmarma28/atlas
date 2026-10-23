import { lazy, Suspense, useCallback } from "react";
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
 * being read.
 */
export function FilesPanel({ tabId, projectId }: { tabId: string; projectId: string | null }) {
  const root = useProjectStore(
    (s) => (projectId && s.projects.find((p) => p.id === projectId)?.path) || null,
  );
  const request = useFilesRevealStore.use.request();
  const reveal = root && request && relativeTo(root, request.path) !== null ? request : null;

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
