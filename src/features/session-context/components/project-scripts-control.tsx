// The project's scripts, as one row.
//
// No scripts: "+ Add project script", which opens the editor. Otherwise a
// split: the main button runs the script last run here (else the first) in a
// terminal tab at the project root; the ▾ lists every script — click to run,
// the pencil to edit — then "Add project script".
//
// The editor is a dialog the store holds (`editScript`), mounted outside the
// popover, so it survives the popover closing as focus moves into it.

import { Pencil, Plus } from "lucide-react";

import { DropdownMenuItem, DropdownMenuSeparator } from "@/ui/dropdown-menu";

import {
  preferredProjectScriptId,
  primaryProjectScript,
  runProjectScript,
  useProjectScripts,
} from "../lib/project-scripts";
import { useSessionContextStore } from "../stores/session-context-store";
import { ContextRow, ContextSplitRow, RowIcon, RowLabel } from "./context-rows";
import { ProjectScriptGlyph } from "./project-script-icons";

export function ProjectScriptsControl({ projectPath }: { projectPath: string }) {
  const scripts = useProjectScripts(projectPath).data ?? [];
  const editScript = useSessionContextStore.use.actions().editScript;
  const primary = primaryProjectScript(scripts, preferredProjectScriptId(projectPath));

  if (!primary) {
    return (
      <ContextRow onClick={() => editScript({ projectPath, script: null })}>
        <RowIcon icon={Plus} />
        <RowLabel>Add project script</RowLabel>
      </ContextRow>
    );
  }

  return (
    <ContextSplitRow
      title={primary.command}
      onClick={() => runProjectScript(projectPath, primary)}
      menuLabel="Project scripts"
      menu={
        <>
          {scripts.map((script) => (
            <DropdownMenuItem
              key={script.id}
              title={script.command}
              onClick={() => runProjectScript(projectPath, script)}
            >
              <ProjectScriptGlyph icon={script.icon} />
              <span className="min-w-0 flex-1 truncate">{script.name}</span>
              <span
                role="button"
                tabIndex={-1}
                aria-label={`Edit ${script.name}`}
                className="-me-1 flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-element-active hover:text-foreground"
                onClick={(event) => {
                  event.stopPropagation();
                  editScript({ projectPath, script });
                }}
              >
                <Pencil className="size-3" />
              </span>
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => editScript({ projectPath, script: null })}>
            <Plus />
            Add project script
          </DropdownMenuItem>
        </>
      }
    >
      <ProjectScriptGlyph icon={primary.icon} muted />
      <RowLabel>{primary.name}</RowLabel>
    </ContextSplitRow>
  );
}
