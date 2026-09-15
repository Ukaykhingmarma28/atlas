import { FileTree } from "@/features/explorer/components/file-tree";

/**
 * Left panel (Cmd+B) — a pure, performative FILE TREE. The old section
 * switcher (Files / Knowledge / Analysis / Explore) was removed: analysis +
 * explore (project symbol analysis) are gone entirely, and knowledge lives in
 * its own KB tab. `FileTree` renders its own header (workspace name on the
 * left, expand/collapse-all + open-folder on the right).
 *
 * A collapsible project "Usage" report used to be docked at the bottom (a
 * cost donut + per-session list, with a full-screen table behind it). Removed
 * 2026-09-16: the numbers belong in Mission Control, which shows them across
 * every project instead of squatting on half the file tree.
 */
export function LeftPanel() {
  return (
    <div className="atlas-vibrant-panel h-full flex flex-col bg-[var(--panel-bg)]">
      <div className="flex-1 min-h-0">
        <FileTree />
      </div>
    </div>
  );
}
