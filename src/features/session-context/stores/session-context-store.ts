// Open state for the session context overlay.
//
// The open flag lives in a store rather than in the trigger, so the overlay
// can be opened from outside the header: the command palette, a keybinding or another feature can open the overlay — and
// open it straight onto a view — with `openSessionContext("capture")`.
//
// Like T3 it is keyed by thread — here, by the tab the trigger sits in. A split
// layout mounts one header (and one trigger) per column, and an unkeyed flag
// would open every one of them at once.

import { create } from "zustand";
import { immer } from "zustand/middleware/immer";

import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { createSelectors } from "@/lib/create-selectors";

/** What the overlay shows. `main` is the grouped rows; the others are drill-in
 *  views that replace them (with a back button), the way the capture popover
 *  steps through its own disclosure views. */
export type SessionContextView = "main" | "capture" | "usage";

/** The key a trigger without a tab (a non-chat header) owns. */
export const NO_TAB_KEY = "__no-tab__";

interface SessionContextState {
  /** Which trigger's overlay is open — its tab id, or `NO_TAB_KEY`. */
  openFor: string | null;
  view: SessionContextView;
  actions: {
    setOpen: (key: string, open: boolean) => void;
    show: (view: SessionContextView) => void;
    back: () => void;
  };
}

export const useSessionContextStore = createSelectors(
  create<SessionContextState>()(
    immer((set) => ({
      openFor: null,
      view: "main",
      actions: {
        setOpen: (key, open) =>
          set((s) => {
            if (open) {
              if (s.openFor !== key) s.view = "main";
              s.openFor = key;
            } else if (s.openFor === key) {
              s.openFor = null;
              // A reopen starts at the top, not in whatever view it closed on.
              s.view = "main";
            }
          }),
        show: (view) =>
          set((s) => {
            s.view = view;
          }),
        back: () =>
          set((s) => {
            s.view = "main";
          }),
      },
    })),
  ),
);

/** The key the main column's trigger owns: its active tab when that is a
 *  chat, else none. The trigger is mounted in the main column only, keyed the
 *  same way (`center-panel.tsx`). */
function mainColumnKey(): string | null {
  const { tabs, groupOrder, activeByGroup } = useLayoutStore.getState();
  const id = activeByGroup[groupOrder[0]];
  return tabs.find((t) => t.id === id)?.type === "chat" ? (id ?? null) : null;
}

/** Open the overlay from anywhere, optionally straight onto a view. Opens the
 *  trigger in `tabId`'s header — by default the main column's. Needs that
 *  `SessionContextButton` to be mounted to anchor to. */
export function openSessionContext(
  view: SessionContextView = "main",
  tabId: string | null = mainColumnKey(),
): void {
  useSessionContextStore.setState((s) => {
    s.openFor = tabId ?? NO_TAB_KEY;
    s.view = view;
  });
}
