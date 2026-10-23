// A file tab's "Open in <editor>": the preferred editor at the cursor line,
// and a ▾ listing every other installed editor.

import { ChevronDown, SquareArrowOutUpRight } from "lucide-react";
import { Button } from "@/ui/button";
import { IconButton } from "@/ui/icon-button";
import { Hint } from "@/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import type { EditorPosition } from "../lib/external-editor-api";
import { openInEditor, openInLabel, usePreferredEditor } from "../lib/preferred-editor";
import { editorMenuEntries } from "./open-in-editor-menu";

export function OpenInEditorButton({
  path,
  position,
}: {
  path: string;
  /** Read at click time: the cursor moves without re-rendering the header. */
  position?: () => EditorPosition | undefined;
}) {
  const { editors, preferred } = usePreferredEditor();
  const { primary, others } = editorMenuEntries(editors, preferred);
  if (!primary) return null;
  const label = openInLabel(primary);
  return (
    <div className="flex shrink-0 items-center">
      <Hint label={`${label}, at the cursor`}>
        <Button
          variant="ghost"
          size="xs"
          onClick={() => void openInEditor(primary.id, path, position?.())}
        >
          <SquareArrowOutUpRight size={12} aria-hidden />
          {label}
        </Button>
      </Hint>
      {others.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<IconButton icon={ChevronDown} size="xs" label="Open in another editor" />}
          />
          <DropdownMenuContent align="end" className="min-w-44">
            {others.map((editor) => (
              <DropdownMenuItem
                key={editor.id}
                onClick={() => void openInEditor(editor.id, path, position?.())}
              >
                {openInLabel(editor)}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
