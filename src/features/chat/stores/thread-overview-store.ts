// State for the thread overview — the rail docked to the right of a chat.
//
// Its own store, for the same reason `detail-panel-store` is: opening,
// resizing or collapsing a section must not re-render a single transcript row.
// Rows never subscribe here, and the rail never subscribes to the transcript's
// projection — the two surfaces share the chat store's data and nothing else.
//
// What the rail is FOR: the questions a long turn raises that the thread
// itself answers badly because the answer is scattered through it — how many
// children are running, what this turn has changed, what it remembered, where
// the checkpoints are. Claude Desktop's right rail ("Background tasks · 3
// running") is the reference.

import { create } from "zustand";
import { persist } from "zustand/middleware";

import { createSelectors } from "@/lib/create-selectors";

/**
 * The sections the rail can show, in the order it shows them.
 *
 * A closed vocabulary, like `RowKind`: a new section is a deliberate addition
 * here, not a branch inside the panel. The order is the reading order — live
 * work first (it changes while you watch), the record of the turn after it,
 * actions last.
 */
export const OVERVIEW_SECTIONS = ["subagents", "changes", "memories"] as const;

/** The sections rendered from the list above. */
export type ListedSection = (typeof OVERVIEW_SECTIONS)[number];

/** Every collapsible card. `session` heads the rail but is not in the list:
 *  it takes the thread's title and actions, which the generic sections do
 *  not, so the panel renders it by hand. It still collapses like them. */
export type OverviewSection = ListedSection | "session";

/** Titles live with the vocabulary so a section cannot be added without one. */
export const SECTION_TITLE: Record<OverviewSection, string> = {
  // The fallback; the card shows the thread's own title when it has one.
  session: "Session",
  subagents: "Subagents",
  changes: "Changes",
  memories: "Memories",
};

// Not here yet, deliberately: CHECKPOINTS. A chat tab is keyed by its ACP
// session; a checkpoint is keyed by the CAPTURED session the Timeline records,
// and the two are joined through `AnchorEntry` rather than being the same id.
// Until that join is read on this path a checkpoints section would render
// empty for every chat, which is worse than not offering it.

interface ThreadOverviewState {
  /** Open, keyed by THREAD (`overviewScope`), not by tab. "New agent" and
   *  opening a thread from history both reuse the tab, so a tab-keyed flag
   *  followed the user into every thread that tab ever showed. Keyed by the
   *  thread, each one remembers its own rail across tab switches, and a fresh
   *  thread starts without one. Absent means closed. */
  open: Record<string, true>;
  /** Shared across tabs: a column width is a property of the window, and a
   *  rail that changed width per tab would jump on every tab switch. */
  width: number;
  /** Collapsed sections, shared across tabs and persisted — which sections a
   *  reader cares about is a preference, not a per-chat fact. */
  collapsed: Partial<Record<OverviewSection, true>>;
  actions: {
    toggle: (scope: string) => void;
    open_: (scope: string) => void;
    close: (scope: string) => void;
    /** Carry a rail opened before the thread bound (scope `t:<tab>`) over to
     *  the session it bound to, and clear the tab scope so the tab's NEXT
     *  thread does not inherit it. */
    adopt: (from: string, to: string) => void;
    setWidth: (w: number) => void;
    toggleSection: (section: OverviewSection) => void;
    /** Drop a scope's rail state. */
    forget: (scope: string) => void;
  };
}

export const OVERVIEW_MIN_WIDTH = 240;
export const OVERVIEW_MAX_WIDTH = 480;
const DEFAULT_WIDTH = 300;

/**
 * The key a chat's rail is stored under: its ACP session once bound, its tab
 * until then — the same scheme as `pinScope`. Resolved by the panel, which
 * calls `adopt` when the one becomes the other.
 */
export function overviewScope(tabId: string, acpSessionId: string | undefined): string {
  return acpSessionId ? `s:${acpSessionId}` : `t:${tabId}`;
}

const clampWidth = (w: number) =>
  Math.min(OVERVIEW_MAX_WIDTH, Math.max(OVERVIEW_MIN_WIDTH, Math.round(w)));

export const useThreadOverviewStore = createSelectors(
  create<ThreadOverviewState>()(
    persist(
      (set) => ({
        open: {},
        width: DEFAULT_WIDTH,
        collapsed: {},
        actions: {
          toggle: (scope) =>
            set((s) => {
              const open = { ...s.open };
              if (open[scope]) delete open[scope];
              else open[scope] = true;
              return { open };
            }),
          open_: (scope) => set((s) => ({ open: { ...s.open, [scope]: true } })),
          close: (scope) =>
            set((s) => {
              const open = { ...s.open };
              delete open[scope];
              return { open };
            }),
          adopt: (from, to) =>
            set((s) => {
              if (from === to || !s.open[from]) return s;
              const open = { ...s.open, [to]: true as const };
              delete open[from];
              return { open };
            }),
          setWidth: (w) => set({ width: clampWidth(w) }),
          toggleSection: (section) =>
            set((s) => {
              const collapsed = { ...s.collapsed };
              if (collapsed[section]) delete collapsed[section];
              else collapsed[section] = true;
              return { collapsed };
            }),
          forget: (scope) =>
            set((s) => {
              if (!s.open[scope]) return s;
              const open = { ...s.open };
              delete open[scope];
              return { open };
            }),
        },
      }),
      {
        name: "atlas.chat.thread-overview",
        // `open` is deliberately NOT persisted: it is per-thread layout for
        // this run only, and a rail that reopens itself on launch is a
        // surface the user did not ask for in this session. Width and collapse state are preferences and do
        // survive.
        partialize: (s) => ({ width: s.width, collapsed: s.collapsed }),
      },
    ),
  ),
);
