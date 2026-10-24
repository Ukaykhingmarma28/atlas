// State for the session overview: the card the title bar's overview button
// shows over a session's top-right.
//
// Its own store, for the same reason `detail-panel-store` is: opening the card
// or collapsing a section must not re-render a single transcript row. Rows
// never subscribe here, and the card never subscribes to the transcript's
// projection; the two surfaces share the chat store's data and nothing else.
//
// What the card is FOR: the questions a long turn raises that the session
// itself answers badly because the answer is scattered through it: how many
// children are running, what this turn has changed, what it remembered.
//
// The card has two forms, like the session context card beside it
// (`session-context-store.ts`), and the store holds both:
//
//  - **Docked.** Where the chat panel keeps room at its top-right
//    (`context-dock.ts`), the card is drawn into that room and the button
//    toggles `open` for the session. It stays until toggled off: across
//    turns, across tab switches.
//  - **Popover.** Anywhere else the card is a popover anchored to the button,
//    open while `popoverFor` names the session. Like any popover it closes
//    on an outside press and on Escape.

import { create } from "zustand";
import { persist } from "zustand/middleware";

import { createSelectors } from "@/lib/create-selectors";

/**
 * The sections the card can show, in the order it shows them.
 *
 * A closed vocabulary, like `RowKind`: a new section is a deliberate addition
 * here, not a branch inside the panel. The order is the reading order: live
 * work first (it changes while you watch), the record of the turn after it.
 */
export const OVERVIEW_SECTIONS = ["subagents", "changes", "memories"] as const;

/** The sections rendered from the list above. */
export type ListedSection = (typeof OVERVIEW_SECTIONS)[number];

/** Every collapsible card. `session` heads the card but is not in the list:
 *  it carries the session's actions, which the generic sections do not, so
 *  the panel renders it by hand. It still collapses like them. */
export type OverviewSection = ListedSection | "session";

/** Titles live with the vocabulary so a section cannot be added without one. */
export const SECTION_TITLE: Record<OverviewSection, string> = {
  // Never the session's own name: the title bar already shows it.
  session: "Session",
  subagents: "Subagents",
  changes: "Changes",
  memories: "Memories",
};

// Not here yet, deliberately: CHECKPOINTS. A chat tab is keyed by its ACP
// session; a checkpoint is keyed by the CAPTURED session the Timeline records,
// and the two are joined through `AnchorEntry` rather than being the same id.
// Until that join is read on this path a checkpoints section would render
// empty for every session, which is worse than not offering it.

interface SessionOverviewState {
  /** The docked card's open flag, keyed by SESSION (`overviewScope`), not by
   *  tab. "New agent" and opening a session from history both reuse the tab,
   *  so a tab-keyed flag followed the user into every session that tab ever
   *  showed. Absent means closed. */
  open: Record<string, true>;
  /** Which session's popover is open, when the panel has no room to dock. */
  popoverFor: string | null;
  /** The last toggle came from the keyboard: the card shows without its
   *  entrance animation. Something opened this often by key should be there
   *  on the keypress, not 150ms after it. */
  instant: boolean;
  /** Collapsed sections, shared across sessions and persisted: which sections
   *  a reader cares about is a preference, not a per-session fact. */
  collapsed: Partial<Record<OverviewSection, true>>;
  actions: {
    /** The title-bar button, docked form. */
    toggle: (scope: string, opts?: { instant?: boolean }) => void;
    /** The title-bar button, popover form. */
    setPopover: (scope: string, open: boolean, opts?: { instant?: boolean }) => void;
    close: (scope: string) => void;
    /** Carry a card opened before the session bound (scope `t:<tab>`) over to
     *  the session it bound to, and clear the tab scope so the tab's NEXT
     *  session does not inherit it. */
    adopt: (from: string, to: string) => void;
    /** The panel gained room to dock: a popover left open there becomes the
     *  docked card, so the card the user opened stays open. */
    handOver: (scope: string) => void;
    toggleSection: (section: OverviewSection) => void;
  };
}

/**
 * The key a session's card is stored under: its ACP session once bound, its
 * tab until then (the same scheme as `pinScope`). Resolved by the panel,
 * which calls `adopt` when the one becomes the other.
 */
export function overviewScope(tabId: string, acpSessionId: string | undefined): string {
  return acpSessionId ? `s:${acpSessionId}` : `t:${tabId}`;
}

export const useSessionOverviewStore = createSelectors(
  create<SessionOverviewState>()(
    persist(
      (set) => ({
        open: {},
        popoverFor: null,
        instant: false,
        collapsed: {},
        actions: {
          toggle: (scope, opts) =>
            set((s) => {
              const open = { ...s.open };
              if (open[scope]) delete open[scope];
              else open[scope] = true;
              return { open, instant: !!opts?.instant };
            }),
          setPopover: (scope, next, opts) =>
            set((s) => {
              if (next) return { popoverFor: scope, instant: !!opts?.instant };
              return s.popoverFor === scope ? { popoverFor: null } : s;
            }),
          close: (scope) =>
            set((s) => {
              if (!s.open[scope] && s.popoverFor !== scope) return s;
              const open = { ...s.open };
              delete open[scope];
              return { open, popoverFor: s.popoverFor === scope ? null : s.popoverFor };
            }),
          adopt: (from, to) =>
            set((s) => {
              if (from === to) return s;
              const patch: Partial<SessionOverviewState> = {};
              if (s.open[from]) {
                const open = { ...s.open, [to]: true as const };
                delete open[from];
                patch.open = open;
              }
              if (s.popoverFor === from) patch.popoverFor = to;
              return Object.keys(patch).length ? patch : s;
            }),
          handOver: (scope) =>
            set((s) =>
              s.popoverFor === scope
                ? { popoverFor: null, open: { ...s.open, [scope]: true }, instant: true }
                : s,
            ),
          toggleSection: (section) =>
            set((s) => {
              const collapsed = { ...s.collapsed };
              if (collapsed[section]) delete collapsed[section];
              else collapsed[section] = true;
              return { collapsed };
            }),
        },
      }),
      {
        // The key predates the rename to "session overview" and is kept, so
        // which sections a reader collapsed survives the upgrade.
        name: "atlas.chat.thread-overview",
        // v1 dropped `width`: the card has the docked room's fixed width, and
        // the old rail's stored width would otherwise ride along unused.
        version: 1,
        migrate: (persisted) => {
          const old = (persisted ?? {}) as { collapsed?: SessionOverviewState["collapsed"] };
          return { collapsed: old.collapsed ?? {} };
        },
        // `open` is deliberately NOT persisted: it is per-session layout for
        // this run only, and a card that reopens itself on launch is a
        // surface the user did not ask for in this session.
        partialize: (s) => ({ collapsed: s.collapsed }),
      },
    ),
  ),
);
