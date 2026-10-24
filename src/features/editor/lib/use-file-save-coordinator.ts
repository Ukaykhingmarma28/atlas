import { createRef, useEffect, useState } from "react";
import { FileSaveCoordinator } from "./file-save-coordinator";

interface FileSaveOptions {
  path: string;
  /** The contents on disk when the session starts. */
  baseline: string;
  persist: (contents: string) => Promise<boolean>;
  onPendingChange: (pending: boolean) => void;
  onConfirmed: (contents: string) => void;
}

export interface FileSaveSession {
  change: (contents: string) => void;
  reset: (contents: string) => void;
  flush: () => Promise<boolean>;
}

/**
 * One `FileSaveCoordinator` per open file. A session owns what is pending, so
 * it outlives re-renders and is replaced only when the file it writes to
 * changes. Callbacks are read at call time, so a new closure never restarts
 * the session.
 */
export function useFileSaveCoordinator(options: FileSaveOptions): FileSaveSession {
  const [latest] = useState(() => ({ current: options }));
  latest.current = options;
  const [current, setCurrent] = useState(() => ({
    path: options.path,
    session: createFileSaveSession(latest),
  }));
  if (current.path !== options.path) {
    setCurrent({ path: options.path, session: createFileSaveSession(latest) });
  }
  const session = current.session;

  // StrictMode replays effect setup. A retired session stays inert, while the
  // replay gets a fresh coordinator instead of reusing a disposed one.
  useEffect(session.setup, [session]);
  return session;
}

function createFileSaveSession(latest: { current: FileSaveOptions }) {
  const coordinatorRef = createRef<FileSaveCoordinator>();
  return {
    change: (contents: string) => coordinatorRef.current?.change(contents),
    reset: (contents: string) => coordinatorRef.current?.reset(contents),
    flush: () => coordinatorRef.current?.flush() ?? Promise.resolve(false),
    setup: () => {
      const coordinator = new FileSaveCoordinator({
        debounceMs: null,
        persist: (contents) => latest.current.persist(contents),
        onPendingChange: (pending) => latest.current.onPendingChange(pending),
        onConfirmed: (contents) => latest.current.onConfirmed(contents),
      });
      coordinator.reset(latest.current.baseline);
      coordinatorRef.current = coordinator;
      return () => {
        coordinatorRef.current = null;
        coordinator.dispose();
      };
    },
  };
}
