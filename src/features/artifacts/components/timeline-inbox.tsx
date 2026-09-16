/**
 * The right pane with nothing open.
 *
 * Deliberately almost empty. The first version put the stats strip here —
 * tracked hours, tokens, checkpoints, a week's sparkline — and it read as a
 * dashboard you had not asked for, over a pane whose only job is to hold the
 * Session you are about to open. Numbers nobody came for are noise.
 *
 * What stays is a way back in: the five most recent Sessions, as suggestions.
 * The nav on the left already lists everything; this is the shortcut for the
 * one you were just in.
 */

import { Layers } from "lucide-react";

import { cn } from "@/lib/utils";

import { formatDuration, sessionState, sessionTitle } from "../lib/board";
import type { BoardSession } from "../types";
import { AgentGlyph } from "./agent-glyph";

/** How many suggestions the empty pane offers. */
const RECENT = 5;

export function TimelineInbox({
  sessions,
  onOpen,
}: {
  /** The rows the nav is showing — filtered, so the suggestions agree with it. */
  sessions: BoardSession[];
  onOpen: (id: string, projectPath: string) => void;
}) {
  // Already newest-first from the store; no sort, just a window.
  const recent = sessions.slice(0, RECENT);

  return (
    <div className="flex h-full min-h-0 flex-col items-center justify-center px-8">
      <Layers size={26} strokeWidth={1.2} className="text-[var(--text-ghost)]" />
      <p className="mt-3 text-[13px] text-[var(--text-secondary)]">Select a session</p>

      {recent.length > 0 && (
        <div className="mt-9 w-full max-w-[460px]">
          <p className="px-3 pb-2 font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--text-ghost)]">
            Recent
          </p>
          <div className="flex flex-col gap-0.5">
            {recent.map((session) => {
              const title = sessionTitle(session.title);
              const live = sessionState(session) === "live";
              return (
                <button
                  key={session.id}
                  type="button"
                  onClick={() => onOpen(session.id, session.projectPath)}
                  title={title ?? undefined}
                  className="flex h-10 cursor-pointer items-center gap-3 rounded-lg px-3 text-left transition-colors hover:bg-[var(--bg-active)]"
                >
                  {session.agent ? (
                    <AgentGlyph agent={session.agent} mono />
                  ) : (
                    <span className="size-[11px]" />
                  )}
                  <span
                    className={cn(
                      "min-w-0 flex-1 truncate text-[13px] leading-tight",
                      title ? "text-[var(--text-secondary)]" : "text-[var(--text-tertiary)]",
                    )}
                  >
                    {title ?? "Untitled session"}
                  </span>
                  <span
                    className={cn(
                      "shrink-0 font-mono text-[11px] tabular-nums",
                      live ? "text-[var(--capture-live)]" : "text-[var(--text-ghost)]",
                    )}
                  >
                    {formatDuration(session.activeSeconds)}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
