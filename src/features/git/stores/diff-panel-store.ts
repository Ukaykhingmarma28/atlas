// State for the diff panel — what it shows and how — kept apart from the
// git store so folding a file or flipping the layout re-renders the panel and
// nothing else.
//
// Two lifetimes:
//  - Preferences (layout, wrap, whitespace, the file tree) and each panel's
//    chosen scope and base branch persist: they are how the reader likes to
//    review, and a relaunch should not reset them.
//  - Which files are folded lives for the run only. It is keyed by the scope
//    being reviewed, so it survives switching tabs, scopes and panels, but a
//    fold from yesterday's diff has no business closing today's file.

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { createSelectors } from "@/lib/create-selectors";

/** What a diff panel reviews. `session` is the working tree narrowed to the
 *  files one agent session touched, offered only where there is a session. */
export type DiffScope = "session" | "working-tree" | "branch-range";

export type DiffLayout = "unified" | "split";

interface DiffPanelState {
  /** Per panel (its tab id). Absent: the panel's own default. */
  scope: Record<string, DiffScope>;
  /** Per repository: the base branch the branch range compares against.
   *  Absent or `null`: the remote default, as the backend picks it. */
  baseRef: Record<string, string | null>;
  layout: DiffLayout;
  wordWrap: boolean;
  /** `null`: follow the `diffIgnoreWhitespace` setting. */
  ignoreWhitespace: boolean | null;
  fileTreeOpen: boolean;
  /** Folded files per review scope key (`collapseScopeKey`), as a set of
   *  file keys. Absent: nothing touched yet, the default applies. */
  collapsed: Record<string, Record<string, true>>;
  actions: {
    setScope: (panel: string, scope: DiffScope) => void;
    setBaseRef: (repo: string, baseRef: string | null) => void;
    setLayout: (layout: DiffLayout) => void;
    setWordWrap: (wrap: boolean) => void;
    setIgnoreWhitespace: (ignore: boolean) => void;
    setFileTreeOpen: (open: boolean) => void;
    /** Replace a scope's folded set; `defaults` stands in when it has none. */
    updateCollapsed: (
      scopeKey: string,
      defaults: ReadonlySet<string>,
      update: (current: ReadonlySet<string>) => ReadonlySet<string>,
    ) => void;
  };
}

const EMPTY: Record<string, true> = {};

export function collapsedSetOf(
  record: Record<string, true> | undefined,
  defaults: ReadonlySet<string>,
): ReadonlySet<string> {
  return record ? new Set(Object.keys(record)) : defaults;
}

export const useDiffPanelStore = createSelectors(
  create<DiffPanelState>()(
    persist(
      (set) => ({
        scope: {},
        baseRef: {},
        layout: "unified",
        wordWrap: false,
        ignoreWhitespace: null,
        fileTreeOpen: true,
        collapsed: {},
        actions: {
          setScope: (panel, scope) => set((s) => ({ scope: { ...s.scope, [panel]: scope } })),
          setBaseRef: (repo, baseRef) =>
            set((s) => ({ baseRef: { ...s.baseRef, [repo]: baseRef?.trim() || null } })),
          setLayout: (layout) => set({ layout }),
          setWordWrap: (wordWrap) => set({ wordWrap }),
          setIgnoreWhitespace: (ignoreWhitespace) => set({ ignoreWhitespace }),
          setFileTreeOpen: (fileTreeOpen) => set({ fileTreeOpen }),
          updateCollapsed: (scopeKey, defaults, update) =>
            set((s) => {
              const current = collapsedSetOf(s.collapsed[scopeKey], defaults);
              const next = update(current);
              if (next === current) return s;
              const record: Record<string, true> = next.size === 0 ? EMPTY : {};
              for (const key of next) record[key] = true;
              return { collapsed: { ...s.collapsed, [scopeKey]: record } };
            }),
        },
      }),
      {
        name: "atlas.git.diff-panel",
        partialize: (s) => ({
          scope: s.scope,
          baseRef: s.baseRef,
          layout: s.layout,
          wordWrap: s.wordWrap,
          ignoreWhitespace: s.ignoreWhitespace,
          fileTreeOpen: s.fileTreeOpen,
        }),
      },
    ),
  ),
);
