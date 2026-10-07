// What one chat session wrote to shared memory, for the "Memory updated"
// card under its transcript (memory plan M4). Re-read on mount and on every
// `atlas:memory-changed`, debounced (the health hook's shape).

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { MEMORY_CHANGED_EVENT } from "../stores/shared-memory-store";

/** One revision a session wrote, newest first. */
export interface SessionWrite {
  id: number;
  rev: number;
  /** `insert`, `replace`, `merge`, `edit`, `forget`, `feedback` or `rewind`. */
  op: string;
  kind: string;
  content: string;
  /** `active`, `candidate`, `archived` or `tombstoned`. */
  state: string;
  at: number;
}

const DEBOUNCE_MS = 300;

export function useSessionMemoryWrites(
  projectPath: string | null,
  sessionId: string | null,
  since = 0,
): { writes: SessionWrite[]; refresh: () => Promise<void> } {
  const [writes, setWrites] = useState<SessionWrite[]>([]);
  const seq = useRef(0);
  const refresh = useCallback(async () => {
    if (!projectPath || !sessionId) return;
    const mine = ++seq.current;
    try {
      const next = await invoke<SessionWrite[]>("memory_session_writes", {
        projectPath,
        sessionId,
        since,
      });
      if (mine === seq.current) setWrites(next);
    } catch {
      // A failed read keeps the last answer.
    }
  }, [projectPath, sessionId, since]);

  useEffect(() => {
    if (!projectPath || !sessionId) {
      setWrites([]);
      return;
    }
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
  }, [projectPath, sessionId, refresh]);

  return { writes, refresh };
}

const OP_LABEL: Record<string, string> = {
  insert: "saved",
  merge: "confirmed",
  replace: "replaced",
  edit: "edited",
  forget: "forgotten",
  feedback: "rated",
  rewind: "taken back",
};

/** "2 saved, 1 replaced": counts by op, in the order ops first appear. */
export function writesSummary(writes: SessionWrite[]): string {
  const counts = new Map<string, number>();
  for (const w of writes) {
    const label = OP_LABEL[w.op] ?? w.op;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts].map(([label, n]) => `${n} ${label}`).join(", ");
}
