// Where the session runs — the Workspace group.
//
// An Atlas session always runs on this machine, in the project folder, so the
// first row states that rather than offering a choice of machine or run mode.
// The second row's split opens the project in the preferred editor (the file
// manager when no editor is installed); its menu lists every installed editor,
// then the file manager, a terminal and the clipboard.

import {
  Copy,
  Folder,
  FolderOpen,
  Laptop,
  SquareArrowOutUpRight,
  SquareTerminal,
} from "lucide-react";

import { useProjectStore } from "@/features/projects/stores/project-store";
import { OpenInEditorDropdownItems } from "@/features/external-editor/components/open-in-editor-menu";
import { SYSTEM_EDITOR_ID } from "@/features/external-editor/lib/external-editor-api";
import {
  openInEditor,
  openInLabel,
  usePreferredEditor,
} from "@/features/external-editor/lib/preferred-editor";
import { DropdownMenuSeparator } from "@/ui/dropdown-menu";
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
  // The system default opens a folder in the file manager, which the menu
  // already offers in its own words, so only a real editor takes the row.
  const { preferred } = usePreferredEditor();
  const editor = preferred && preferred.id !== SYSTEM_EDITOR_ID ? preferred : null;

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
        onClick={() =>
          void (editor ? openInEditor(editor.id, projectPath) : revealProject(projectPath))
        }
        menuLabel="Other ways to open the project"
        menu={
          <>
            <OpenInEditorDropdownItems path={projectPath} />
            {editor && <DropdownMenuSeparator />}
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
        <RowIcon icon={editor ? SquareArrowOutUpRight : FolderOpen} />
        <RowLabel>{editor ? openInLabel(editor) : `Open in ${FILE_MANAGER}`}</RowLabel>
      </ContextSplitRow>
    </ContextSection>
  );
}
