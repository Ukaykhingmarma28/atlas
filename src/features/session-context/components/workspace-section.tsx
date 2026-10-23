// Where the session runs — the Workspace group.
//
// An Atlas session always runs on this machine, in the project folder, so the
// first row states that rather than offering a choice of machine or run mode.
// Atlas has no editor detection yet, so the second row's split opens what the
// backend can: the file manager, a terminal, the clipboard.

import { Copy, Folder, FolderOpen, Laptop, SquareTerminal } from "lucide-react";

import { useProjectStore } from "@/features/projects/stores/project-store";
import { isMac, isWindows } from "@/lib/platform";
import { DropdownMenuItem } from "@/ui/dropdown-menu";

import { copyProjectPath, openProjectInTerminal, revealProject } from "../lib/workspace-actions";
import {
  ContextRow,
  ContextSection,
  ContextSplitRow,
  RowIcon,
  RowLabel,
  RowMeta,
} from "./context-rows";

const FILE_MANAGER = isMac ? "Finder" : isWindows ? "Explorer" : "file manager";

export function WorkspaceSection({ projectPath }: { projectPath: string }) {
  const name = useProjectStore((s) => s.projects.find((p) => p.path === projectPath)?.name ?? null);
  const folder = name ?? projectPath.split(/[\\/]/).pop() ?? projectPath;

  return (
    <ContextSection title="Workspace" showHeading={false} separated={false}>
      <ContextRow title={projectPath}>
        <span className="flex shrink-0 items-center gap-1">
          <RowIcon icon={Laptop} />
          <RowIcon icon={Folder} />
        </span>
        <RowLabel>{folder}</RowLabel>
        <RowMeta>This device</RowMeta>
      </ContextRow>
      <ContextSplitRow
        onClick={() => void revealProject(projectPath)}
        menuLabel="Other ways to open the project"
        menu={
          <>
            <DropdownMenuItem onClick={() => void revealProject(projectPath)}>
              <FolderOpen />
              Reveal in {FILE_MANAGER}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => void openProjectInTerminal(projectPath)}>
              <SquareTerminal />
              Open in Terminal
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => void copyProjectPath(projectPath)}>
              <Copy />
              Copy path
            </DropdownMenuItem>
          </>
        }
      >
        <RowIcon icon={FolderOpen} />
        <RowLabel>Open in {FILE_MANAGER}</RowLabel>
      </ContextSplitRow>
    </ContextSection>
  );
}
