// Open state for the session context overlay.
//
// The open flag lives in a store rather than in the trigger, so the overlay
// can be opened from outside the header: the command palette, a keybinding or
// another feature can open it — and open it straight onto a view — with
// `openSessionContext("capture")`.
//
// The overlay has two forms, and the store holds both:
//
//  - **Docked.** A chat panel wide enough to keep the card beside its
//    transcript reports itself `dockable`; its card is then an inline panel
//    in the space the panel always reserves for it, and the header button
//    toggles `dockOpen` for that tab. Showing or hiding it never resizes or
//    moves the transcript (`context-dock.ts`).
//  - **Popover.** Anywhere else (a narrow panel, a non-session tab) it is a
//    popover anchored to the button, open while `openFor` names its key.
//
// Both are keyed by the tab the trigger sits in. A split layout mounts one
// header (and one trigger) per column, and an unkeyed flag would open every
// one of them at once.
//
// The two dialogs the overlay opens (a project script's editor, Create PR)
// are here too, not in the rows that open them: a popover closes when focus
// moves into a dialog, and a dialog mounted inside it would close with it.

import { create } from "zustand";
import { immer } from "zustand/middleware/immer";

import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { createSelectors } from "@/lib/create-selectors";
import type { PrCreateDraft } from "@/features/pull-requests/lib/pull-requests-types";

import type { ProjectScript } from "../lib/session-context-api";

/** What the overlay shows. `main` is the grouped rows; the others are drill-in
 *  views that replace them (with a back button), the way the capture popover
 *  steps through its own disclosure views. */
export type SessionContextView = "main" | "capture" | "usage";

/** The key a trigger without a tab (a non-session header) owns. */
export const NO_TAB_KEY = "__no-tab__";

/** The project script editor: a new script (`script: null`) or an existing one. */
export interface ScriptEditorRequest {
  projectPath: string;
  script: ProjectScript | null;
}

/** The Create PR dialog, opened once the branch is on the remote. */
export interface CreatePrRequest {
  projectPath: string;
  draft: boolean;
  prefill: PrCreateDraft;
  /** The session it is opened from, which the pull request is linked to. */
  sessionId: string | null;
}

interface SessionContextState {
  /** Which trigger's popover is open — its tab id, or `NO_TAB_KEY`. */
  openFor: string | null;
  /** Tabs whose chat panel can dock the card beside the transcript. */
  dockable: Record<string, boolean>;
  /** Tabs whose docked card is showing. Kept per tab across switches, the
   *  way a panel stays open. */
  dockOpen: Record<string, boolean>;
  view: SessionContextView;
  scriptEditor: ScriptEditorRequest | null;
  createPr: CreatePrRequest | null;
  actions: {
    setOpen: (key: string, open: boolean) => void;
    /** The header button: toggles the docked card where there is one, else
     *  the popover. */
    toggle: (key: string) => void;
    setDockable: (tabId: string, dockable: boolean) => void;
    show: (view: SessionContextView) => void;
    back: () => void;
    editScript: (request: ScriptEditorRequest | null) => void;
    requestCreatePr: (request: CreatePrRequest | null) => void;
  };
}

export const useSessionContextStore = createSelectors(
  create<SessionContextState>()(
    immer((set) => ({
      openFor: null,
      dockable: {},
      dockOpen: {},
      view: "main",
      scriptEditor: null,
      createPr: null,
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
        toggle: (key) =>
          set((s) => {
            if (s.dockable[key]) {
              const next = !s.dockOpen[key];
              s.dockOpen[key] = next;
              if (next) s.view = "main";
              return;
            }
            if (s.openFor === key) {
              s.openFor = null;
              s.view = "main";
            } else {
              s.openFor = key;
              s.view = "main";
            }
          }),
        setDockable: (tabId, dockable) =>
          set((s) => {
            if (!!s.dockable[tabId] === dockable) return;
            if (dockable) s.dockable[tabId] = true;
            else delete s.dockable[tabId];
            // A popover left open when the panel widens hands over to the
            // docked card, and a docked card that loses its room to the
            // popover, so the overlay the user opened stays open.
            if (dockable && s.openFor === tabId) {
              s.openFor = null;
              s.dockOpen[tabId] = true;
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
        editScript: (request) =>
          set((s) => {
            s.scriptEditor = request;
          }),
        requestCreatePr: (request) =>
          set((s) => {
            s.createPr = request;
          }),
      },
    })),
  ),
);

/** Whether `key`'s overlay is showing, in either form. */
export function selectOverlayOpen(s: SessionContextState, key: string): boolean {
  return s.dockable[key] ? !!s.dockOpen[key] : s.openFor === key;
}

/** The key the main column's trigger owns: its active tab when that is a
 *  session, else none. The trigger is mounted in the main column only, keyed
 *  the same way (`center-panel.tsx`). */
function mainColumnKey(): string | null {
  const { tabs, groupOrder, activeByGroup } = useLayoutStore.getState();
  const id = activeByGroup[groupOrder[0]];
  return tabs.find((t) => t.id === id)?.type === "chat" ? (id ?? null) : null;
}

/** Open the overlay from anywhere, optionally straight onto a view. Opens the
 *  trigger in `tabId`'s header — by default the main column's: its docked
 *  card when that panel has room, else the popover, which needs that
 *  `SessionContextButton` to be mounted to anchor to. */
export function openSessionContext(
  view: SessionContextView = "main",
  tabId: string | null = mainColumnKey(),
): void {
  const key = tabId ?? NO_TAB_KEY;
  useSessionContextStore.setState((s) => {
    if (s.dockable[key]) s.dockOpen[key] = true;
    else s.openFor = key;
    s.view = view;
  });
}
