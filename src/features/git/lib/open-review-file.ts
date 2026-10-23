// Opening a file from a diff (its header or its name).
//
// Inside the open project it becomes a file tab in the right panel, one per
// path, with the project tree beside it. A file Atlas has nowhere to place
// (outside the project, or no project open) goes to the system's default
// editor instead, through the opener plugin.

import { toast } from "sonner";
import { useAppStore } from "@/features/app/stores/app-store";
import { openFile } from "@/lib/open-file";

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
