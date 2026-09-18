import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { FileCode2, Check } from "lucide-react";
import { HintGroup, HintItem } from "@/ui/hint-group";
import { useGitStore } from "../../stores/git-store";
import { handleGitError } from "../../lib/git-errors";

export interface ConflictFile {
  path: string;
  markerCount: number;
  xy: string;
}

export interface ConflictState {
  files: ConflictFile[];
  message: string;
}

/**
 * Conflicted-files section for an in-progress merge/rebase/cherry-pick:
 * per-file "N conflicts" counts (from `git diff --check`, so an editor-side
 * fix shows up as 0 without re-marking), ours/theirs one-click resolution
 * (side-aware — a deleted side resolves via `git rm`), open-in-editor, and
 * mark-resolved. GitHub Desktop's conflict dialog, inlined.
 */
export function ConflictsView({ onOpenFile }: { onOpenFile: (path: string) => void }) {
  const repoPath = useGitStore.use.repoPath();
  const files = useGitStore.use.files();
  const actions = useGitStore.use.actions();
  const [state, setState] = useState<ConflictState | null>(null);

  const load = useCallback(() => {
    if (!repoPath) return;
    invoke<ConflictState>("git_conflict_state", { path: repoPath })
      .then(setState)
      .catch(() => setState(null));
  }, [repoPath]);

  // Refresh whenever the file list changes (any resolution or external edit
  // lands back here via the snapshot refresh).
  useEffect(() => {
    load();
  }, [load, files]);

  const resolve = async (file: string, resolution: "ours" | "theirs" | "manual") => {
    if (!repoPath) return;
    try {
      await invoke("git_resolve_file", { path: repoPath, file, resolution });
      await actions.refresh(repoPath);
      load();
    } catch (e) {
      handleGitError(e);
    }
  };

  if (!state || state.files.length === 0) return null;

  return (
    <div className="shrink-0 border-b border-border">
      <div className="flex items-center justify-between px-2 h-control-sm bg-[var(--sidebar)] border-b border-border-subtle">
        <span className="text-2xs font-semibold text-muted-foreground uppercase tracking-wider">
          Conflicts ({state.files.length})
        </span>
        <span className="text-3xs text-muted-foreground">resolve each file, then Continue</span>
      </div>
      {state.files.map((f) => (
        <div
          key={f.path}
          className="group flex items-center gap-1.5 h-control-md px-2 text-xs hover:bg-element-hover"
        >
          <span className="shrink-0 w-3 text-center font-mono text-2xs font-semibold text-error">
            !
          </span>
          <span className="truncate flex-1 min-w-0 font-mono text-secondary-foreground">
            {f.path}
          </span>
          {f.markerCount > 0 ? (
            <span className="shrink-0 text-3xs font-mono text-[var(--atlas-status-warning-foreground)]">
              {f.markerCount} marker{f.markerCount === 1 ? "" : "s"}
            </span>
          ) : (
            <span className="shrink-0 text-3xs font-mono text-muted-foreground">no markers</span>
          )}
          <HintGroup>
            <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 shrink-0">
              <button
                onClick={() => void resolve(f.path, "ours")}
                className="px-1.5 h-[16px] rounded border border-border text-3xs text-secondary-foreground hover:text-foreground hover:bg-element-hover"
                title="Keep your version"
              >
                Ours
              </button>
              <button
                onClick={() => void resolve(f.path, "theirs")}
                className="px-1.5 h-[16px] rounded border border-border text-3xs text-secondary-foreground hover:text-foreground hover:bg-element-hover"
                title="Take their version"
              >
                Theirs
              </button>
              <HintItem label="Open in editor">
                <button
                  onClick={() => onOpenFile(f.path)}
                  className="p-0.5 rounded text-muted-foreground hover:text-foreground"
                >
                  <FileCode2 size={11} />
                </button>
              </HintItem>
              <HintItem
                label={
                  f.markerCount > 0
                    ? "Mark resolved (conflict markers still present!)"
                    : "Mark resolved"
                }
              >
                <button
                  onClick={() => void resolve(f.path, "manual")}
                  className="p-0.5 rounded text-muted-foreground hover:text-success"
                >
                  <Check size={11} />
                </button>
              </HintItem>
            </div>
          </HintGroup>
        </div>
      ))}
    </div>
  );
}
