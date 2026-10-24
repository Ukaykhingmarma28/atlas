// State for the diff panel — what it shows and how — kept apart from the
// git store so folding a file or flipping the layout re-renders the panel and
// nothing else.
//
// Two lifetimes:
//  - Preferences (layout, whitespace, the file tree) and each panel's
//    chosen scope and base branch persist: they are how the reader likes to
//    review, and a relaunch should not reset them.
//  - Which files are folded lives for the run only. It is keyed by the scope
//    being reviewed, so it survives switching tabs, scopes and panels, but a
//    fold from yesterday's diff has no business closing today's file.
//  - Which files were marked viewed persists, per review scope, with the
//    signature of the diff the reader saw: a file that changes afterwards
//    reads as changed, not as still viewed.

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { createSelectors } from "@/lib/create-selectors";

/** What a diff panel reviews. `session` is the working tree narrowed to the
 *  files one agent session touched, and `turn` one turn's own edits; both are
 *  offered only where there is a session. */
export type DiffScope = "session" | "turn" | "working-tree" | "branch-range";

/** The turn choice that follows the session's newest turn with changes. */
export const LATEST_TURN = "latest";

export type DiffLayout = "unified" | "split";

/** A file marked viewed: the signature of the diff it showed then, and the
 *  whitespace mode it was read in (another mode diffs differently, so its
 *  signature says nothing about whether the file moved). `sig` is `null` when
 *  the file was marked before its diff had loaded. */
export interface ViewedMark {
  sig: number | null;
  ws: boolean;
}

interface DiffPanelState {
  /** Per panel (its tab id). Absent: the panel's own default. */
  scope: Record<string, DiffScope>;
  /** Per panel: the turn the `turn` scope shows, its stable key
   *  (`stableTurnKey`, which survives a relaunch) or {@link LATEST_TURN}.
   *  Absent: the latest. */
  turn: Record<string, string>;
  /** Per repository: the base branch the branch range compares against.
   *  Absent or `null`: the remote default, as the backend picks it. */
  baseRef: Record<string, string | null>;
  layout: DiffLayout;
  /** `null`: follow the `diffIgnoreWhitespace` setting. */
  ignoreWhitespace: boolean | null;
  fileTreeOpen: boolean;
  /** Folded files per review scope key (`collapseScopeKey`), as a set of
   *  file keys. Absent: nothing touched yet, the default applies. */
  collapsed: Record<string, Record<string, true>>;
  /** Viewed files per review scope key, by path. */
  viewed: Record<string, Record<string, ViewedMark>>;
  actions: {
    setScope: (panel: string, scope: DiffScope) => void;
    /** Show one turn (or {@link LATEST_TURN}): the `turn` scope, on it. */
    setTurn: (panel: string, turn: string) => void;
    setBaseRef: (repo: string, baseRef: string | null) => void;
    setLayout: (layout: DiffLayout) => void;
    setIgnoreWhitespace: (ignore: boolean) => void;
    setFileTreeOpen: (open: boolean) => void;
    /** Replace a scope's folded set; `defaults` stands in when it has none. */
    updateCollapsed: (
      scopeKey: string,
      defaults: ReadonlySet<string>,
      update: (current: ReadonlySet<string>) => ReadonlySet<string>,
    ) => void;
    /** Mark (or, with `null`, unmark) one file of a scope viewed. */
    setViewed: (scopeKey: string, path: string, mark: ViewedMark | null) => void;
  };
}

const EMPTY: Record<string, true> = {};

/** Panels whose chosen scope is remembered. A tab id outlives its tab in the
 *  persisted map, so the oldest choices are dropped past this. */
export const MAX_REMEMBERED_SCOPES = 32;

/** `record` with `key` set last (insertion order is recency), trimmed to the
 *  {@link MAX_REMEMBERED_SCOPES} most recent. */
export function withRecent<T>(record: Record<string, T>, key: string, value: T): Record<string, T> {
  const entries = Object.entries(record).filter(([k]) => k !== key);
  entries.push([key, value]);
  return Object.fromEntries(entries.slice(-MAX_REMEMBERED_SCOPES));
}

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
        turn: {},
        baseRef: {},
        layout: "unified",
        ignoreWhitespace: null,
        fileTreeOpen: true,
        collapsed: {},
        viewed: {},
        actions: {
          setScope: (panel, scope) => set((s) => ({ scope: withRecent(s.scope, panel, scope) })),
          setTurn: (panel, turn) =>
            set((s) => ({
              scope: withRecent(s.scope, panel, "turn"),
              turn: withRecent(s.turn, panel, turn),
            })),
          setBaseRef: (repo, baseRef) =>
            set((s) => ({ baseRef: { ...s.baseRef, [repo]: baseRef?.trim() || null } })),
          setLayout: (layout) => set({ layout }),
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
          setViewed: (scopeKey, path, mark) =>
            set((s) => {
              const current = s.viewed[scopeKey] ?? {};
              if (!mark && !(path in current)) return s;
              const next = { ...current };
              if (mark) next[path] = mark;
              else delete next[path];
              return { viewed: withRecent(s.viewed, scopeKey, next) };
            }),
        },
      }),
      {
        name: "atlas.git.diff-panel",
        partialize: (s) => ({
          scope: s.scope,
          turn: s.turn,
          baseRef: s.baseRef,
          layout: s.layout,
          ignoreWhitespace: s.ignoreWhitespace,
          fileTreeOpen: s.fileTreeOpen,
          viewed: s.viewed,
        }),
      },
    ),
  ),
);
