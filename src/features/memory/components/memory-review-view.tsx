// The Memory panel's Review tab (memory plan M4): what waits for the user.
// Candidates (captured lines nobody confirmed) are approved or dismissed;
// near-duplicates the health pass found are merged into one survivor or told
// apart; contradicting memories are settled by keeping one side or both.
// Nothing here is automatic: every action is the user's, and a dismissed or
// merged memory is archived, never deleted (its history stays).

import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { cn } from "@/lib/utils";
import {
  sharedMemory,
  type DreamProposal,
  type MemoryEntry,
  type ReviewQueue,
} from "../lib/shared-memory-api";
import { MEMORY_CHANGED_EVENT } from "../stores/shared-memory-store";

const EMPTY: ReviewQueue = { candidates: [], merges: [], conflicts: [], dreams: [] };
const DEBOUNCE_MS = 300;

export function MemoryReviewView({
  projectPath,
  className,
}: {
  projectPath: string;
  className?: string;
}) {
  const [queue, setQueue] = useState<ReviewQueue>(EMPTY);
  const [loaded, setLoaded] = useState(false);
  const seq = useRef(0);

  const refresh = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const next = await sharedMemory.review(projectPath);
      if (mine === seq.current) setQueue(next);
    } catch {
      // A failed read keeps the last queue.
    } finally {
      if (mine === seq.current) setLoaded(true);
    }
  }, [projectPath]);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unlisten: (() => void) | undefined;
    void refresh();
    void listen(MEMORY_CHANGED_EVENT, () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void refresh(), DEBOUNCE_MS);
    }).then((u) => {
      if (alive) unlisten = u;
      else u();
    });
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      unlisten?.();
    };
  }, [refresh]);

  /** Run one action, then re-read the queue. */
  const act = (run: () => Promise<unknown>) => async () => {
    try {
      await run();
    } finally {
      await refresh();
    }
  };

  const dreams = queue.dreams ?? [];
  const empty =
    queue.candidates.length === 0 &&
    queue.merges.length === 0 &&
    queue.conflicts.length === 0 &&
    dreams.length === 0;

  return (
    <div className={cn("flex-1 min-h-0 overflow-y-auto px-3 py-2", className)}>
      {loaded && empty ? (
        <p className="py-8 text-center text-sm text-[var(--muted-foreground)]">Nothing to review</p>
      ) : null}
      {dreams.length > 0 && (
        <Section title="Proposed by the nightly review" count={dreams.length}>
          {dreams.map((d) => (
            <Card key={d.id}>
              <div className="text-xs text-[var(--foreground)]">{dreamLabel(d.op)}</div>
              {d.why && <div className="text-2xs text-[var(--muted-foreground)]">{d.why}</div>}
              {d.entries.map((e) => (
                <Line key={e.id} entry={e} muted />
              ))}
              <Actions>
                <Action
                  label="Accept"
                  onClick={act(() => sharedMemory.acceptDream(projectPath, d.id))}
                />
                <Action
                  label="Dismiss"
                  onClick={act(() => sharedMemory.dismissDream(projectPath, d.id))}
                />
              </Actions>
            </Card>
          ))}
        </Section>
      )}
      {queue.conflicts.length > 0 && (
        <Section title="Contradictions" count={queue.conflicts.length}>
          {queue.conflicts.map(({ a, b }) => (
            <Card key={`${a.id}-${b.id}`}>
              <Line label="A" entry={a} />
              <Line label="B" entry={b} />
              <Actions>
                <Action
                  label="Keep A"
                  onClick={act(() => sharedMemory.resolveConflict(projectPath, a.id, b.id, "a"))}
                />
                <Action
                  label="Keep B"
                  onClick={act(() => sharedMemory.resolveConflict(projectPath, a.id, b.id, "b"))}
                />
                <Action
                  label="Both hold"
                  onClick={act(() => sharedMemory.resolveConflict(projectPath, a.id, b.id, "both"))}
                />
              </Actions>
            </Card>
          ))}
        </Section>
      )}
      {queue.merges.length > 0 && (
        <Section title="Duplicates" count={queue.merges.length}>
          {queue.merges.map(({ keep, drop }) => (
            <Card key={keep.id}>
              <Line label="Keep" entry={keep} />
              {drop.map((d) => (
                <Line key={d.id} label="Same as" entry={d} muted />
              ))}
              <Actions>
                <Action
                  label="Merge"
                  onClick={act(() =>
                    sharedMemory.merge(
                      projectPath,
                      keep.id,
                      drop.map((d) => d.id),
                    ),
                  )}
                />
                <Action
                  label="Not the same"
                  onClick={act(async () => {
                    for (const d of drop) {
                      await sharedMemory.resolveConflict(projectPath, keep.id, d.id, "both");
                    }
                  })}
                />
              </Actions>
            </Card>
          ))}
        </Section>
      )}
      {queue.candidates.length > 0 && (
        <Section title="Unconfirmed" count={queue.candidates.length}>
          {queue.candidates.map((c) => (
            <Card key={c.id}>
              <Line entry={c} />
              <Actions>
                <Action
                  label="Approve"
                  onClick={act(() => sharedMemory.promote(projectPath, c.id))}
                />
                <Action
                  label="Dismiss"
                  onClick={act(() => sharedMemory.archive(projectPath, [c.id]))}
                />
              </Actions>
            </Card>
          ))}
        </Section>
      )}
    </div>
  );
}

/** One line saying what a proposal would do. */
function dreamLabel(op: DreamProposal["op"]): string {
  switch (op.op) {
    case "add":
      return `Add ${op.kind ?? "memory"}: ${op.content ?? ""}`;
    case "merge":
      return "Merge these into the first";
    case "archive":
      return `Archive (${op.reason ?? "unused"})`;
    case "rewrite":
      return `Rewrite as: ${op.content ?? ""}`;
    case "link":
      return op.rel === "supersedes" ? "The first replaces the second" : "These contradict";
    default:
      return op.op;
  }
}

function Section({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-3">
      <h3 className="mb-1.5 flex items-center gap-1.5 text-3xs uppercase tracking-wider text-[var(--atlas-text-disabled)]">
        {title}
        <span className="tabular-nums">{count}</span>
      </h3>
      <div className="flex flex-col gap-1.5">{children}</div>
    </section>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 rounded-md border border-[var(--border)] bg-[var(--card)] px-2.5 py-2">
      {children}
    </div>
  );
}

function Line({ label, entry, muted }: { label?: string; entry: MemoryEntry; muted?: boolean }) {
  return (
    <div className="flex items-baseline gap-2 text-xs">
      {label && (
        <span className="w-12 shrink-0 text-3xs uppercase tracking-wide text-[var(--atlas-text-disabled)]">
          {label}
        </span>
      )}
      <span
        className={cn(
          "min-w-0 flex-1 break-words",
          muted ? "text-[var(--muted-foreground)]" : "text-[var(--foreground)]",
        )}
      >
        {entry.content}
      </span>
      <span className="shrink-0 text-2xs text-[var(--muted-foreground)]">
        {entry.kind} · {entry.agent || entry.source} · {Math.round(entry.confidence * 100)}%
      </span>
    </div>
  );
}

function Actions({ children }: { children: React.ReactNode }) {
  return <div className="mt-1 flex items-center gap-1.5">{children}</div>;
}

function Action({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="h-6 rounded-md border border-[var(--border)] px-2 text-xs text-[var(--secondary-foreground)] transition-colors hover:bg-[var(--atlas-element-hover)] hover:text-[var(--foreground)]"
    >
      {label}
    </button>
  );
}
