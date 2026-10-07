// "Memory updated": what this chat session saved to shared memory, under its
// transcript, with a one-click Forget (memory plan M4). It makes an agent's
// writes visible where they happen, which is also the cheapest check against
// a bad memory: the user sees "always force-push" right after the turn that
// wrote it. Nothing renders until the session writes something.

import { useState } from "react";
import { Brain, ChevronDown, ChevronRight } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { FileTreeConfirmDelete } from "@/features/explorer/components/file-tree-confirm-delete";
import { sharedMemory } from "../lib/shared-memory-api";
import {
  useSessionMemoryWrites,
  writesSummary,
  type SessionWrite,
} from "../lib/use-session-memory-writes";

export function MemoryUpdatedCard({
  projectPath,
  sessionId,
  since = 0,
  className,
}: {
  projectPath: string | null;
  sessionId: string | null;
  since?: number;
  className?: string;
}) {
  const { writes, refresh } = useSessionMemoryWrites(projectPath, sessionId, since);
  const [open, setOpen] = useState(false);
  const [forgetting, setForgetting] = useState<SessionWrite | null>(null);
  if (!projectPath || writes.length === 0) return null;

  const forget = async (w: SessionWrite) => {
    try {
      await sharedMemory.forgetEntry(projectPath, w.id);
    } catch (err) {
      toast.error(`Couldn't forget: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      await refresh();
    }
  };

  return (
    <div
      className={cn(
        "mx-auto my-2 w-full max-w-[760px] rounded-md border border-[var(--border)] bg-[var(--card)] text-xs",
        className,
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-[var(--secondary-foreground)]"
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <Brain size={12} className="text-[var(--muted-foreground)]" />
        <span>Memory updated: {writesSummary(writes)}</span>
      </button>
      {open && (
        <ul className="flex flex-col border-t border-[var(--border)]">
          {writes.map((w) => (
            <li key={w.rev} className="flex items-baseline gap-2 px-2.5 py-1.5">
              <span className="w-16 shrink-0 text-3xs uppercase tracking-wide text-[var(--atlas-text-disabled)]">
                {w.kind}
              </span>
              <span className="min-w-0 flex-1 break-words text-[var(--foreground)]">
                {w.content || "(forgotten)"}
              </span>
              {w.live && w.state === "candidate" && (
                <span className="shrink-0 text-3xs uppercase text-[var(--muted-foreground)]">
                  candidate
                </span>
              )}
              {/* Forgotten or archived since, by anyone: nothing left to forget. */}
              {!w.live && w.op !== "forget" && (
                <span className="shrink-0 text-3xs uppercase text-[var(--muted-foreground)]">
                  removed
                </span>
              )}
              {w.live && (
                <button
                  type="button"
                  onClick={() => setForgetting(w)}
                  className="shrink-0 text-2xs text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                >
                  Forget
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <FileTreeConfirmDelete
        open={forgetting !== null}
        name={forgetting?.content ?? ""}
        isDir={false}
        title="Forget this memory?"
        body="Every agent on this project stops seeing it, and it no longer shows in search. This can't be undone."
        confirmLabel="Forget"
        onConfirm={() => {
          if (forgetting) void forget(forgetting);
          setForgetting(null);
        }}
        onOpenChange={(v) => {
          if (!v) setForgetting(null);
        }}
      />
    </div>
  );
}
