// Shared Cross-Agent Memory (v2) — UI state for the Memory panel's "Shared"
// view. Loads the per-project derived state (active plan, decisions, recent
// changes, facts) and supports an on-demand query + clear. Scoped to one
// project at a time (the active workspace), reloaded via `load(projectPath)`.
// Mirrors `memory-sharing-store.ts`.
//
// Live refresh: every write to shared memory emits `atlas:memory-changed`
// (payload: the scope root and the affected kinds). The store re-pulls the
// bound project on each one; the manual Refresh button stays. The payload's
// root is the repository's main worktree, which the frontend cannot derive
// from the launch directory (a linked worktree lives elsewhere), so every
// change re-pulls — it is two cheap reads, and they are coalesced.

import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { createSelectors } from "@/lib/create-selectors";
import { sharedMemory, type MemoryEvent, type SharedState } from "../lib/shared-memory-api";

const EMPTY_STATE: SharedState = {
  lastSeq: 0,
  activePlan: null,
  decisions: [],
  recentChanges: [],
  facts: [],
  failures: [],
  architecture: [],
  sessionAgents: {},
  updatedAt: 0,
};

/** Emitted by the backend after every write to a shared-memory scope. */
export const MEMORY_CHANGED_EVENT = "atlas:memory-changed";

interface MemoryChangedPayload {
  root: string;
  kinds: string[];
}

interface SharedMemoryStore {
  projectPath: string | null;
  state: SharedState;
  events: MemoryEvent[];
  loaded: boolean;
  queryText: string;
  queryResults: MemoryEvent[];
  actions: {
    load: (projectPath: string) => Promise<void>;
    refresh: () => Promise<void>;
    runQuery: (query: string) => Promise<void>;
    clear: () => Promise<void>;
  };
}

let refreshing: Promise<void> | null = null;
let refreshAgain = false;

/** One app-lifetime subscription, taken on the first load. The handler
 *  re-pulls whichever project is bound when the event arrives, so switching
 *  projects needs no re-subscribe. */
let subscription: Promise<unknown> | null = null;
function subscribe(onChange: () => void) {
  if (subscription) return;
  subscription = listen<MemoryChangedPayload>(MEMORY_CHANGED_EVENT, onChange).catch(() => {
    // No Tauri runtime (tests, a plain browser): manual refresh still works.
    subscription = null;
  });
}

export const useSharedMemoryStore = createSelectors(
  create<SharedMemoryStore>((set, get) => ({
    projectPath: null,
    state: EMPTY_STATE,
    events: [],
    loaded: false,
    queryText: "",
    queryResults: [],
    actions: {
      load: async (projectPath) => {
        set({ projectPath, loaded: false });
        subscribe(() => void get().actions.refresh());
        try {
          // Derived view + the raw event log (newest-first) in parallel.
          const [state, events] = await Promise.all([
            sharedMemory.getState(projectPath),
            sharedMemory.listEvents(projectPath),
          ]);
          // Ignore a stale response if the project changed mid-flight.
          if (get().projectPath !== projectPath) return;
          set({ state, events, loaded: true });
        } catch {
          if (get().projectPath !== projectPath) return;
          set({ state: EMPTY_STATE, events: [], loaded: true });
        }
      },
      refresh: async () => {
        // A burst of writes (an agent editing many files) becomes one pull in
        // flight plus at most one after it, never one pull per write.
        if (refreshing) {
          refreshAgain = true;
          return refreshing;
        }
        refreshing = (async () => {
          do {
            refreshAgain = false;
            const { projectPath } = get();
            if (!projectPath) return;
            try {
              const [state, events] = await Promise.all([
                sharedMemory.getState(projectPath),
                sharedMemory.listEvents(projectPath),
              ]);
              if (get().projectPath !== projectPath) continue;
              set({ state, events });
            } catch {
              /* keep last good state */
            }
          } while (refreshAgain);
        })().finally(() => {
          refreshing = null;
        });
        return refreshing;
      },
      runQuery: async (query) => {
        const { projectPath } = get();
        set({ queryText: query });
        if (!projectPath || !query.trim()) {
          set({ queryResults: [] });
          return;
        }
        try {
          const queryResults = await sharedMemory.query(projectPath, query);
          if (get().projectPath !== projectPath) return;
          set({ queryResults });
        } catch {
          set({ queryResults: [] });
        }
      },
      clear: async () => {
        const { projectPath } = get();
        if (!projectPath) return;
        await sharedMemory.clear(projectPath);
        if (get().projectPath !== projectPath) return;
        set({ state: EMPTY_STATE, events: [], queryResults: [], queryText: "" });
      },
    },
  })),
);
