import { useEffect, useState } from "react";
import { CopyGlyph } from "@/ui/animated-icon";
import { Popover } from "@base-ui/react/popover";
import { invoke } from "@tauri-apps/api/core";
import { ArrowLeft, Undo2, GitGraph, RotateCcw, Sparkles, Tag } from "lucide-react";
import { cn } from "@/lib/utils";
import { HintGroup, HintItem } from "@/ui/hint-group";
import { useGitStore } from "../../stores/git-store";
import { handleGitError } from "../../lib/git-errors";
import { useArtifactsStore } from "@/features/artifacts/stores/artifacts-store";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { DiffView } from "../diff-view";

export function HistoryView() {
  const repoPath = useGitStore.use.repoPath();
  const log = useGitStore.use.log();
  const selected = useGitStore.use.selectedCommit();
  const actions = useGitStore.use.actions();
  const [copied, setCopied] = useState(false);
  const [tagging, setTagging] = useState(false);
  const [tagName, setTagName] = useState("");

  useEffect(() => {
    if (repoPath) void actions.loadLog(repoPath);
  }, [repoPath, actions]);

  const run = async (fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      handleGitError(e);
    }
  };

  // ── Commit detail ──────────────────────────────────────────────
  if (selected) {
    return (
      <div className="h-full flex flex-col">
        <div className="shrink-0 border-b border-border">
          <HintGroup>
            <div className="flex items-center gap-2 px-2 h-[30px]">
              <HintItem label="Back to history">
                <button
                  onClick={() => actions.clearSelectedCommit()}
                  className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-element-hover"
                >
                  <ArrowLeft size={13} />
                </button>
              </HintItem>
              <span className="font-mono text-xs text-secondary-foreground">
                {selected.shortHash}
              </span>
              <div className="ml-auto flex items-center gap-0.5">
                <HintItem label="Copy SHA">
                  <button
                    onClick={() => {
                      void navigator.clipboard.writeText(selected.hash).catch(() => {});
                      setCopied(true);
                      setTimeout(() => setCopied(false), 1200);
                    }}
                    className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-element-hover"
                  >
                    <CopyGlyph
                      copied={copied}
                      size="sm"
                      className={copied ? "text-success" : undefined}
                    />
                  </button>
                </HintItem>
                <HintItem label="Cherry-pick onto current branch">
                  <button
                    onClick={() => run(() => actions.cherryPick(selected.hash))}
                    className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-element-hover"
                  >
                    <GitGraph size={12} />
                  </button>
                </HintItem>
                <HintItem label="Revert this commit">
                  <button
                    onClick={() => run(() => actions.revert(selected.hash))}
                    className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-element-hover"
                  >
                    <Undo2 size={12} />
                  </button>
                </HintItem>
                <ResetMenu onReset={(mode) => run(() => actions.reset(selected.hash, mode))} />
                <HintItem label="Tag this commit">
                  <button
                    onClick={() => setTagging((v) => !v)}
                    className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-element-hover"
                  >
                    <Tag size={12} />
                  </button>
                </HintItem>
              </div>
            </div>
          </HintGroup>
          {tagging && (
            <div className="px-2 pb-2">
              <input
                value={tagName}
                onChange={(e) => setTagName(e.target.value)}
                autoFocus
                placeholder="tag name → Enter"
                className="w-full h-7 rounded border border-border bg-panel-input px-2 text-xs font-mono text-foreground outline-none focus:border-border-strong"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && tagName.trim()) {
                    void run(() => actions.createTag(tagName.trim(), selected.hash));
                    setTagging(false);
                    setTagName("");
                  } else if (e.key === "Escape") {
                    setTagging(false);
                    setTagName("");
                  }
                }}
              />
            </div>
          )}
          <div className="px-3 pb-2">
            <div className="text-sm text-foreground font-medium">{selected.subject}</div>
            {selected.body && (
              <pre className="mt-1 max-h-32 overflow-y-auto hide-scrollbar whitespace-pre-wrap break-words font-sans text-xs text-muted-foreground">
                {selected.body}
              </pre>
            )}
            <div className="mt-1 text-2xs text-muted-foreground">
              {selected.author} · {selected.date}
            </div>
            <CommitSessions sha={selected.hash} />
          </div>
        </div>
        <DiffView diff={selected.diff} className="flex-1 min-h-0" emptyLabel="No file changes" />
      </div>
    );
  }

  // ── Commit list ────────────────────────────────────────────────
  return (
    <div className="h-full overflow-y-auto hide-scrollbar">
      {log.length === 0 ? (
        <div className="px-3 py-8 text-center text-xs text-muted-foreground">No history</div>
      ) : (
        log.map((c, i) => (
          <div key={c.hash} className="relative group">
            <button
              onClick={() => void actions.loadCommit(c.hash)}
              className="w-full text-left flex flex-col gap-0.5 px-3 py-1.5 border-b border-border-subtle hover:bg-element-hover"
            >
              <span className="text-xs text-secondary-foreground group-hover:text-foreground truncate pr-12">
                {c.message}
              </span>
              <span className="text-3xs text-muted-foreground font-mono">
                {c.short_hash} · {c.author} · {c.date}
              </span>
            </button>
            {i === 0 && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  void run(() => actions.undoCommit());
                }}
                className="absolute right-2 top-1.5 opacity-0 group-hover:opacity-100 px-1.5 h-[16px] rounded border border-border text-3xs text-secondary-foreground hover:text-foreground hover:bg-element-hover"
                title="Undo this commit — changes return to the staged area (blocked once pushed)"
              >
                Undo
              </button>
            )}
          </div>
        ))
      )}
    </div>
  );
}

function ResetMenu({ onReset }: { onReset: (mode: "soft" | "mixed" | "hard") => void }) {
  const [open, setOpen] = useState(false);
  const item = (mode: "soft" | "mixed" | "hard", label: string, desc: string) => (
    <button
      onClick={() => {
        onReset(mode);
        setOpen(false);
      }}
      className="w-full text-left px-3 py-1.5 hover:bg-element-hover"
    >
      <div className="text-xs text-foreground">{label}</div>
      <div className="text-3xs text-muted-foreground">{desc}</div>
    </button>
  );
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <HintItem label="Reset current branch to this commit">
        <Popover.Trigger
          render={
            <button
              className={cn(
                "p-1 rounded hover:bg-element-hover",
                open ? "text-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              <RotateCcw size={12} />
            </button>
          }
        />
      </HintItem>
      <Popover.Portal>
        <Popover.Positioner className="z-popover" side="bottom" align="end" sideOffset={4}>
          <Popover.Popup className="w-[200px] rounded-lg border border-border bg-[var(--card)] shadow-md py-1">
            <div className="px-3 py-1 text-3xs uppercase tracking-wider text-muted-foreground">
              Reset to here
            </div>
            {item("soft", "Soft", "keep changes staged")}
            {item("mixed", "Mixed", "keep changes unstaged")}
            {item("hard", "Hard", "discard all changes")}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** One Session that produced this commit. */
export interface CommitSession {
  sessionId: string;
  title: string | null;
  messageCount: number;
  toolCallCount: number;
  files: string[];
}

/**
 * The Sessions behind the selected commit — the answer to "why is this written
 * this way", offered where the question actually gets asked.
 *
 * Renders nothing at all when the commit has no recorded Session, which is the
 * common case: capture may be off, the commit may predate it, or it may be
 * human work the link rule deliberately did not attribute to an agent.
 */
function CommitSessions({ sha }: { sha: string }) {
  const repoPath = useGitStore.use.repoPath();
  const addTab = useLayoutStore.use.actions().addTab;
  const [sessions, setSessions] = useState<CommitSession[]>([]);

  useEffect(() => {
    if (!repoPath) return;
    let cancelled = false;
    setSessions([]);
    invoke<CommitSession[]>("capture_commit_sessions", { projectPath: repoPath, commitSha: sha })
      .then((found) => {
        // Typed as an array, but guard the null a future backend change (or an
        // unmocked dev command) could send instead of throwing — `sessions.length`
        // below would otherwise crash on it.
        if (!cancelled) setSessions(found ?? []);
      })
      // A Project with capture off returns an empty list rather than failing,
      // so reaching here means a store-level problem. The git panel is not the
      // place to report it — capture health already owns that signal.
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [repoPath, sha]);

  if (sessions.length === 0) return null;

  const open = (sessionId: string) => {
    if (!repoPath) return;
    // The sha travels with the request so the Session lands on this commit's
    // Checkpoint rather than at the top of a conversation that may have
    // produced several.
    useArtifactsStore
      .getState()
      .actions.openSession({ sessionId, projectPath: repoPath, commitSha: sha });
    addTab({
      id: "artifacts",
      type: "artifacts",
      title: "Timeline",
      closable: true,
      dirty: false,
      data: {},
    });
  };

  return (
    <div className="mt-2 border-t border-border-subtle pt-2">
      <div className="text-3xs uppercase tracking-wider text-muted-foreground">
        Produced by {sessions.length} session{sessions.length === 1 ? "" : "s"}
      </div>
      {sessions.map((s) => (
        <button
          key={s.sessionId}
          onClick={() => open(s.sessionId)}
          className="mt-1 w-full rounded border border-border bg-card px-2 py-1.5 text-left hover:bg-element-hover group"
          title="Open this Session in the Timeline"
        >
          <div className="flex items-start gap-1.5">
            <Sparkles size={11} className="mt-0.5 shrink-0 text-muted-foreground" />
            <span className="text-xs text-secondary-foreground group-hover:text-foreground line-clamp-2">
              {s.title ?? "Untitled session"}
            </span>
          </div>
          <div className="mt-0.5 pl-[18px] text-3xs text-muted-foreground truncate">
            {s.messageCount} message{s.messageCount === 1 ? "" : "s"} · {s.toolCallCount} tool call
            {s.toolCallCount === 1 ? "" : "s"}
            {s.files.length > 0 && ` · ${s.files.join(", ")}`}
          </div>
        </button>
      ))}
    </div>
  );
}
