/**
 * Comments on a session that is not in the cloud — the reader's own notes on
 * a transcript, kept on this machine.
 *
 * The same `Comment` shape the server hands back, so every surface that draws
 * a thread (the inline threads under a row, the pills, the badge, the comments
 * panel, the `@comment` picker) reads one type and never asks where a comment
 * lives. `sessionId` is the scope key (`pinScope`); `anchorId` is a durable
 * row key (`local-comment-anchors.ts`); the author is the signed-in account,
 * or `LOCAL_AUTHOR` when there is none.
 *
 * # Why the renderer owns this
 *
 * The same trade the pins make (`chat-pins-store.ts`): a local comment is
 * the reader's annotation, read by no other surface and by no agent, so it
 * is `persist` to localStorage rather than a store file and a command. The
 * moment the session is shared, `ChatCommentsController` posts every local
 * thread to the server and forgets it here — from then on the team's copy is
 * the one that counts.
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";

import type { AnchorKind, Comment } from "@/features/artifacts/lib/comments-api";
import { createSelectors } from "@/lib/create-selectors";

/** The author id of a comment made with no account signed in. */
export const LOCAL_AUTHOR = "local";

function mint(): string {
  return `lc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

interface LocalCommentsState {
  /** scope key → every comment, oldest first. Deleted ones keep their row
   *  with a null body, so replies keep their places, as on the server. */
  byScope: Record<string, Comment[]>;
  actions: {
    post: (
      scope: string,
      authorId: string,
      anchorKind: AnchorKind,
      anchorId: string,
      body: string,
      parentId: string | null,
    ) => Comment;
    edit: (scope: string, commentId: string, body: string) => void;
    resolve: (scope: string, commentId: string, resolved: boolean) => void;
    remove: (scope: string, commentId: string) => void;
    /** Drop comments that have been posted elsewhere (migrated to the cloud). */
    forget: (scope: string, commentIds: readonly string[]) => void;
  };
}

function patch(
  s: LocalCommentsState,
  scope: string,
  commentId: string,
  change: (c: Comment) => Comment,
): Partial<LocalCommentsState> {
  const list = s.byScope[scope];
  if (!list?.some((c) => c.id === commentId)) return {};
  return {
    byScope: {
      ...s.byScope,
      [scope]: list.map((c) => (c.id === commentId ? change(c) : c)),
    },
  };
}

export const useLocalCommentsStore = createSelectors(
  create<LocalCommentsState>()(
    persist(
      (set) => ({
        byScope: {},
        actions: {
          post: (scope, authorId, anchorKind, anchorId, body, parentId) => {
            const comment: Comment = {
              id: mint(),
              sessionId: scope,
              anchorKind,
              anchorId,
              parentId,
              authorId,
              guestName: null,
              body,
              mentions: [],
              createdAt: new Date().toISOString(),
              editedAt: null,
              deletedAt: null,
              resolvedAt: null,
              resolvedBy: null,
            };
            set((s) => ({
              byScope: { ...s.byScope, [scope]: [...(s.byScope[scope] ?? []), comment] },
            }));
            return comment;
          },
          edit: (scope, commentId, body) =>
            set((s) =>
              patch(s, scope, commentId, (c) => ({
                ...c,
                body,
                editedAt: new Date().toISOString(),
              })),
            ),
          resolve: (scope, commentId, resolved) =>
            set((s) =>
              patch(s, scope, commentId, (c) => ({
                ...c,
                resolvedAt: resolved ? new Date().toISOString() : null,
                resolvedBy: resolved ? c.authorId : null,
              })),
            ),
          remove: (scope, commentId) =>
            set((s) =>
              patch(s, scope, commentId, (c) => ({
                ...c,
                body: null,
                deletedAt: new Date().toISOString(),
              })),
            ),
          forget: (scope, commentIds) =>
            set((s) => {
              const list = s.byScope[scope];
              if (!list) return {};
              const drop = new Set(commentIds);
              const kept = list.filter((c) => !drop.has(c.id));
              const byScope = { ...s.byScope };
              if (kept.length) byScope[scope] = kept;
              else delete byScope[scope];
              return { byScope };
            }),
        },
      }),
      {
        name: "atlas-local-comments",
        version: 1,
        partialize: (s) => ({ byScope: s.byScope }),
      },
    ),
  ),
);

/** Comments for one scope, or a stable empty array. */
const EMPTY: Comment[] = [];
export function localCommentsFor(state: LocalCommentsState, scope: string): Comment[] {
  return state.byScope[scope] ?? EMPTY;
}

/** The server's shape for a scope's comments: row id → its thread. */
export function bucketLocalComments(list: readonly Comment[]): Record<string, Comment[]> {
  const byAnchor: Record<string, Comment[]> = {};
  for (const c of list) {
    if (c.anchorKind === "session") continue;
    (byAnchor[c.anchorId] ??= []).push(c);
  }
  return byAnchor;
}
