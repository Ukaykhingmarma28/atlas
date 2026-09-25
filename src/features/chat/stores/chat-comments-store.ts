/**
 * Cloud comments on a live chat, as the transcript rows read them.
 *
 * The data itself comes from `useSessionComments` — the same hook the Timeline
 * uses, with its watch subscription, realtime frames and post/resolve/remove.
 * `ChatCommentsController` runs that hook once per chat pane and pushes the
 * result here. This store exists for one reason: transcript rows must not
 * subscribe to the chat store (house rule 3 in `transcript-rows.tsx`), and a
 * prop threaded through the memoized row list would re-render every row on
 * every comment frame. A narrow selector here returns one bucket by reference,
 * so a frame re-renders the row it is about and nothing else.
 *
 * Keys are the CHAT's ids — a message id or a tool call id — translated from
 * the captured row ids through `AnchorMap`. A row asks "my comments?" with the
 * id it already has.
 */

import { create } from "zustand";

import { visibleCount, type Comment } from "@/features/artifacts/lib/comments-api";
import type { CommentActions } from "@/features/artifacts/components/comment-thread";
import type { RowComments } from "@/features/artifacts/components/session-detail";
import type { OrgDirectory } from "@/features/organisations/lib/use-org-directory";
import { createSelectors } from "@/lib/create-selectors";

import {
  EMPTY_ANCHOR_MAP,
  type AnchorEntry,
  type AnchorHit,
  type AnchorMap,
} from "../lib/comment-anchors";

export interface CommentTargetIds {
  /** The server Project id. */
  remoteProjectId: string;
  /** The captured Session row id — also its id on the server. */
  sessionId: string;
}

export interface TabComments {
  target: CommentTargetIds | null;
  /** The captured rows the target was last resolved with. */
  entries: AnchorEntry[];
  anchors: AnchorMap;
  /** Captured row id → thread. What the panel lists. */
  byAnchor: Record<string, Comment[]>;
  /** Chat key → thread. What a row reads. */
  byChatKey: Record<string, Comment[]>;
  session: Comment[];
  /** Threads, not comments — the Timeline dock's rule. */
  threadCount: number;
  actions: CommentActions | null;
  directory: OrgDirectory | null;
}

const EMPTY_TAB: TabComments = {
  target: null,
  entries: [],
  anchors: EMPTY_ANCHOR_MAP,
  byAnchor: {},
  byChatKey: {},
  session: [],
  threadCount: 0,
  actions: null,
  directory: null,
};

interface ChatCommentsState {
  byTab: Record<string, TabComments>;
  actions: {
    setTarget: (tabId: string, target: CommentTargetIds | null, entries: AnchorEntry[]) => void;
    setAnchors: (tabId: string, anchors: AnchorMap) => void;
    setComments: (tabId: string, comments: RowComments | null) => void;
    clear: (tabId: string) => void;
  };
}

/** Re-key the server's buckets by chat id. Bucket arrays keep their identity. */
function translate(
  byAnchor: Record<string, Comment[]>,
  anchors: AnchorMap,
): Record<string, Comment[]> {
  const out: Record<string, Comment[]> = {};
  for (const rowId in byAnchor) {
    const key = anchors.chatKeyByRowId.get(rowId);
    if (key) out[key] = byAnchor[rowId];
  }
  return out;
}

function threadCountOf(byAnchor: Record<string, Comment[]>, session: Comment[]): number {
  return Object.keys(byAnchor).length + (session.length > 0 ? 1 : 0);
}

export const useChatCommentsStore = createSelectors(
  create<ChatCommentsState>()((set) => ({
    byTab: {},
    actions: {
      setTarget: (tabId, target, entries) =>
        set((s) => {
          const tab = s.byTab[tabId] ?? EMPTY_TAB;
          return { byTab: { ...s.byTab, [tabId]: { ...tab, target, entries } } };
        }),
      setAnchors: (tabId, anchors) =>
        set((s) => {
          const tab = s.byTab[tabId] ?? EMPTY_TAB;
          return {
            byTab: {
              ...s.byTab,
              [tabId]: { ...tab, anchors, byChatKey: translate(tab.byAnchor, anchors) },
            },
          };
        }),
      setComments: (tabId, comments) =>
        set((s) => {
          const tab = s.byTab[tabId] ?? EMPTY_TAB;
          if (!comments) {
            return {
              byTab: {
                ...s.byTab,
                [tabId]: {
                  ...tab,
                  byAnchor: {},
                  byChatKey: {},
                  session: [],
                  threadCount: 0,
                  actions: null,
                  directory: null,
                },
              },
            };
          }
          return {
            byTab: {
              ...s.byTab,
              [tabId]: {
                ...tab,
                byAnchor: comments.byAnchor,
                byChatKey: translate(comments.byAnchor, tab.anchors),
                session: comments.session,
                threadCount: threadCountOf(comments.byAnchor, comments.session),
                actions: comments.actions,
                directory: comments.directory,
              },
            },
          };
        }),
      clear: (tabId) =>
        set((s) => {
          if (!(tabId in s.byTab)) return s;
          const byTab = { ...s.byTab };
          delete byTab[tabId];
          return { byTab };
        }),
    },
  })),
);

// ── Row-side selectors ───────────────────────────────────────────────────────
//
// Each returns a primitive or a reference the store already holds, so a
// subscriber re-renders only when ITS answer changes.

/** The captured row this chat key is, or `undefined` when the tab has no
 *  cloud target or the row was never captured. `undefined` = render nothing. */
export function useAnchorHit(tabId: string, chatKey: string): AnchorHit | undefined {
  return useChatCommentsStore((s) => s.byTab[tabId]?.anchors.rowIdByChatKey.get(chatKey));
}

/** The thread on this chat key, by reference. */
export function useCommentBucket(tabId: string, chatKey: string): Comment[] | undefined {
  return useChatCommentsStore((s) => s.byTab[tabId]?.byChatKey[chatKey]);
}

/** Visible comments across the thinking and tool rows of one assistant turn. */
export function useTurnCommentCount(tabId: string, turnId: string): number {
  return useChatCommentsStore((s) => {
    const tab = s.byTab[tabId];
    if (!tab) return 0;
    const rows = tab.anchors.workByTurn.get(turnId);
    if (!rows) return 0;
    let n = 0;
    for (const rowId of rows) n += visibleCount(tab.byAnchor[rowId]);
    return n;
  });
}

/** Thread count for the header badge; `null` when comments do not apply. */
export function useCommentThreadCount(tabId: string): number | null {
  return useChatCommentsStore((s) => {
    const tab = s.byTab[tabId];
    return tab?.target && tab.actions ? tab.threadCount : null;
  });
}

export function useCommentActions(tabId: string): CommentActions | null {
  return useChatCommentsStore((s) => s.byTab[tabId]?.actions ?? null);
}

export function useCommentDirectory(tabId: string): OrgDirectory | null {
  return useChatCommentsStore((s) => s.byTab[tabId]?.directory ?? null);
}

export function tabCommentsFor(state: ChatCommentsState, tabId: string): TabComments {
  return state.byTab[tabId] ?? EMPTY_TAB;
}
