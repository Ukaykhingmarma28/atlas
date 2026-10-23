// Which turns' changed-files cards the reader has expanded every folder of.
//
// Persisted, like the diff panel's preferences: a card the reader opened up
// stays open across a relaunch. Kept out of the chat store so a toggle
// re-renders the one card that reads its turn and nothing else; the
// transcript's rows never subscribe to the chat store.

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { createSelectors } from "@/lib/create-selectors";

/** Turns remembered. Insertion order is recency; the oldest go past this. */
export const MAX_REMEMBERED_TURNS = 200;

interface ChangedFilesState {
  /** Turn id → every folder expanded. Absent: the default, folded. */
  expanded: Record<string, true>;
  actions: {
    setExpanded: (turnId: string, expanded: boolean) => void;
  };
}

export const useChangedFilesStore = createSelectors(
  create<ChangedFilesState>()(
    persist(
      (set) => ({
        expanded: {},
        actions: {
          setExpanded: (turnId, expanded) =>
            set((s) => {
              const entries = Object.entries(s.expanded).filter(([id]) => id !== turnId);
              if (expanded) entries.push([turnId, true]);
              return { expanded: Object.fromEntries(entries.slice(-MAX_REMEMBERED_TURNS)) };
            }),
        },
      }),
      {
        name: "atlas.chat.changed-files",
        partialize: (s) => ({ expanded: s.expanded }),
      },
    ),
  ),
);
