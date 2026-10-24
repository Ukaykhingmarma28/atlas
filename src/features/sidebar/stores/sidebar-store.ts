// The sidebar's own view state: which project the list is scoped to, whether
// the Settled shelf is open, the session being renamed, and the search.
//
// The scope and the shelf survive a restart (per viewer, in local storage);
// the rest is the moment's. None of it is session data — the sessions are
// Rust's, read through `use-sidebar-sessions.ts` — so nothing here can go
// stale against the store.

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { createSelectors } from "@/lib/create-selectors";

interface SidebarState {
  /** The project the list is filtered to (an Atlas project id), or `null`
   *  for every project in the organisation. */
  scopeProjectId: string | null;
  settledExpanded: boolean;
  /** The row with its title in an input, if any. */
  renamingThreadId: string | null;
  /** The header search, across every session. */
  search: string;
  /** The Settled shelf's own search. */
  settledSearch: string;
  /** Bumped to ask the header search to take focus (the chat header's title);
   *  the sidebar focuses it when the number moves. */
  searchFocusRequest: number;
  actions: {
    setScopeProjectId: (id: string | null) => void;
    /** Scope to `id`, or back to every project when it is already the scope. */
    toggleScopeProjectId: (id: string) => void;
    setSettledExpanded: (expanded: boolean) => void;
    beginRename: (threadId: string) => void;
    endRename: () => void;
    setSearch: (search: string) => void;
    setSettledSearch: (search: string) => void;
    requestSearchFocus: () => void;
  };
}

export const useSidebarStore = createSelectors(
  create<SidebarState>()(
    persist(
      (set) => ({
        scopeProjectId: null,
        settledExpanded: false,
        renamingThreadId: null,
        search: "",
        settledSearch: "",
        searchFocusRequest: 0,
        actions: {
          setScopeProjectId: (scopeProjectId) => set({ scopeProjectId }),
          toggleScopeProjectId: (id) =>
            set((s) => ({ scopeProjectId: s.scopeProjectId === id ? null : id })),
          setSettledExpanded: (settledExpanded) => set({ settledExpanded }),
          beginRename: (renamingThreadId) => set({ renamingThreadId }),
          endRename: () => set({ renamingThreadId: null }),
          setSearch: (search) => set({ search }),
          setSettledSearch: (settledSearch) => set({ settledSearch }),
          requestSearchFocus: () => set((s) => ({ searchFocusRequest: s.searchFocusRequest + 1 })),
        },
      }),
      {
        name: "atlas-sidebar",
        version: 1,
        partialize: (s) => ({
          scopeProjectId: s.scopeProjectId,
          settledExpanded: s.settledExpanded,
        }),
      },
    ),
  ),
);
