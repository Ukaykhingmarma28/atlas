import { useEffect } from "react";
import { Archive } from "lucide-react";
import { useGitStore } from "../../stores/git-store";
import { handleGitError } from "../../lib/git-errors";

export function StashesView() {
  const repoPath = useGitStore.use.repoPath();
  const stashes = useGitStore.use.stashes();
  const files = useGitStore.use.files();
  const actions = useGitStore.use.actions();

  useEffect(() => {
    if (repoPath) void actions.loadStashes();
  }, [repoPath, actions]);

  const run = async (fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      handleGitError(e);
    }
  };

  return (
    <div className="h-full flex flex-col">
      <div className="shrink-0 border-b border-border p-2">
        <button
          onClick={() => run(() => actions.stashPush())}
          disabled={files.length === 0}
          className="w-full flex items-center justify-center gap-1.5 h-7 rounded-md text-xs font-medium bg-card text-secondary-foreground hover:text-foreground hover:bg-element-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          <Archive size={12} />
          Stash all changes
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto hide-scrollbar">
        {stashes.length === 0 ? (
          <div className="px-3 py-8 text-center text-xs text-muted-foreground">No stashes</div>
        ) : (
          stashes.map((s) => (
            <div
              key={s.index}
              className="group flex flex-col gap-1 px-3 py-2 border-b border-border-subtle"
            >
              <span className="text-xs text-secondary-foreground truncate">{s.message}</span>
              <div className="flex items-center gap-2">
                <span className="text-3xs font-mono text-muted-foreground flex-1">
                  stash@{`{${s.index}}`} {s.branch && `· ${s.branch}`}
                </span>
                <button
                  onClick={() => run(() => actions.stashApply(s.index))}
                  className="text-2xs text-muted-foreground hover:text-foreground"
                >
                  Apply
                </button>
                <button
                  onClick={() => run(() => actions.stashPop(s.index))}
                  className="text-2xs text-muted-foreground hover:text-foreground"
                >
                  Pop
                </button>
                <button
                  onClick={() => run(() => actions.stashDrop(s.index))}
                  className="text-2xs text-muted-foreground hover:text-[var(--atlas-status-error-foreground)]"
                >
                  Drop
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
