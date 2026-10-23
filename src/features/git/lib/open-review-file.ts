// Opening a file from a diff (its header or its name).
//
// Inside the open project it becomes a file tab in the right panel, one per
// path, with the project tree beside it. A file Atlas has nowhere to place
// (outside the project, or no project open) goes to the app the system opens
// that file type with, through the opener plugin. Atlas has no "external
// editor" preference to prefer over that; if one is added, it goes here.

import { toast } from "sonner";
import { useAppStore } from "@/features/app/stores/app-store";
import { openFile } from "@/lib/open-file";
import { useDiffPanelStore } from "../stores/diff-panel-store";
import { diffTabId, openGitDiff } from "./git-diff-api";

export async function openReviewFile(path: string): Promise<void> {
  const root = useAppStore.getState().currentProject?.path ?? null;
  if (root && (path === root || path.startsWith(`${root}/`))) {
    await openFile(path);
    return;
  }
  try {
    const { openPath } = await import("@tauri-apps/plugin-opener");
    await openPath(path);
  } catch (e) {
    toast.error("Couldn't open the file in your editor", { description: String(e) });
  }
}

/**
 * The other way: from a changed file in a project tree to its change, in the
 * project's review diff on the working-tree scope (where an uncommitted
 * change is), scrolled to that file. `path` is relative to `root`.
 */
export function showWorkingTreeDiff(root: string, path: string): void {
  useDiffPanelStore.getState().actions.setScope(diffTabId(root), "working-tree");
  openGitDiff(root, path, false);
}
