// Shared Cross-Agent Memory (v2) — UI state for the Memory panel's "Shared"
// view. Loads the per-project derived state (active plan, decisions, recent
// changes, facts) and supports an on-demand query + clear. Scoped to one
// project at a time (the active project), reloaded via `load(projectPath)`.
// Mirrors `memory-sharing-store.ts`.
//
// Live refresh: every write to shared memory emits `atlas:memory-changed`
// (payload: the scope root and the affected kinds). The store re-pulls the
// bound project on each one; the manual Refresh button stays. The payload's
// root is the repository's main worktree, which the frontend cannot derive
// from the launch directory (a linked worktree lives elsewhere), so every
// change re-pulls — it is three cheap reads, and they are coalesced.
//
// Memories: every record entry with its provenance (source, agent) and
// confidence. The user can edit one (written as source `user`, confidence 1)
// or forget it; both go through the backend, which announces the change.
//
// Import: the user can pull the project's Claude auto-memory in. The preview
// writes nothing; only confirming (with the lines the user kept) writes.

import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { createSelectors } from "@/lib/create-selectors";
import {
  sharedMemory,
  type ClaudeImportPreview,
  type MemoryEntry,
  type MemoryEvent,
  type SharedState,
} from "../lib/shared-memory-api";

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
  /** Every record entry, newest write first, with provenance + confidence. */
  entries: MemoryEntry[];
  loaded: boolean;
  queryText: string;
  queryResults: MemoryEvent[];
  actions: {
    load: (projectPath: string) => Promise<void>;
    refresh: () => Promise<void>;
    runQuery: (query: string) => Promise<void>;
    clear: () => Promise<void>;
    /** Rewrite an entry's content as the user. Throws on failure. */
    editEntry: (id: number, content: string) => Promise<void>;
    /** Forget (delete) an entry. Throws on failure. */
    forgetEntry: (id: number) => Promise<void>;
    /** What importing Claude's auto-memory would write. Reads only. */
    previewClaudeImport: () => Promise<ClaudeImportPreview | null>;
    /** Import the previewed lines in `ids`; returns how many were written.
     *  Throws on failure. */
    importClaude: (ids: string[]) => Promise<number>;
  };
}

/** State, events and entries for one project. Entries degrade to none on
 *  their own, so an older backend without them still shows the rest. */
async function pull(projectPath: string) {
  const [state, events, entries] = await Promise.all([
    sharedMemory.getState(projectPath),
    sharedMemory.listEvents(projectPath),
    sharedMemory.listEntries(projectPath).catch(() => [] as MemoryEntry[]),
  ]);
  return { state, events, entries: entries ?? [] };
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
    entries: [],
    loaded: false,
    queryText: "",
    queryResults: [],
    actions: {
      load: async (projectPath) => {
        set({ projectPath, loaded: false });
        subscribe(() => void get().actions.refresh());
        try {
          // Derived view, the raw event log (newest-first) and the entries
          // in parallel.
          const pulled = await pull(projectPath);
          // Ignore a stale response if the project changed mid-flight.
          if (get().projectPath !== projectPath) return;
          set({ ...pulled, loaded: true });
        } catch {
          if (get().projectPath !== projectPath) return;
          set({ state: EMPTY_STATE, events: [], entries: [], loaded: true });
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
              const pulled = await pull(projectPath);
              if (get().projectPath !== projectPath) continue;
              set(pulled);
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
        set({ state: EMPTY_STATE, events: [], entries: [], queryResults: [], queryText: "" });
      },
      editEntry: async (id, content) => {
        const { projectPath } = get();
        if (!projectPath) return;
        const edited = await sharedMemory.editEntry(projectPath, id, content);
        if (get().projectPath !== projectPath) return;
        set({ entries: get().entries.map((e) => (e.id === id ? edited : e)) });
        // The state view and event log changed too; memory-changed also
        // re-pulls, this covers a runtime that does not deliver it.
        await get().actions.refresh();
      },
      forgetEntry: async (id) => {
        const { projectPath } = get();
        if (!projectPath) return;
        await sharedMemory.forgetEntry(projectPath, id);
        if (get().projectPath !== projectPath) return;
        set({ entries: get().entries.filter((e) => e.id !== id) });
        await get().actions.refresh();
      },
      previewClaudeImport: async () => {
        const { projectPath } = get();
        if (!projectPath) return null;
        return sharedMemory.previewClaudeImport(projectPath);
      },
      importClaude: async (ids) => {
        const { projectPath } = get();
        if (!projectPath) return 0;
        const written = await sharedMemory.confirmClaudeImport(projectPath, ids);
        await get().actions.refresh();
        return written;
      },
    },
  })),
);
