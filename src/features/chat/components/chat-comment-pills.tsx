/**
 * The comment affordances inside a turn's fold, when its session is shared.
 * (Prompts and responses carry theirs in their action bars — see
 * `user-row-actions.tsx` and `prose-row-actions.tsx`.)
 *
 * Every component here reads `chat-comments-store` through a narrow selector
 * and renders NOTHING when the tab has no cloud target or the row was never
 * captured — so an unshared chat pays no DOM for any of this. The thread
 * popover, faces and composer are the Timeline's `CommentButton`, unchanged.
 *
 * Nothing here transitions. The transcript's hover reveals snap (see
 * `user-row-actions.tsx`); `transition-none` overrides the button's own.
 */

import { memo, useMemo } from "react";

import { AccountAvatar } from "@/features/auth/components/account-avatar";
import { CommentButton, facesOf } from "@/features/artifacts/components/comment-thread";
import { visibleCount, type Comment } from "@/features/artifacts/lib/comments-api";
import { cn } from "@/lib/utils";

import {
  tabCommentsFor,
  useAnchorHit,
  useChatCommentsStore,
  useCommentActions,
  useCommentBucket,
  useCommentDirectory,
  useTurnCommentCount,
} from "../stores/chat-comments-store";

/** Does this thinking or tool row carry a discussion? A boolean, so the row
 *  only re-renders when the answer flips. */
export function useRowHasComments(tabId: string, chatKey: string): boolean {
  return useChatCommentsStore((s) => visibleCount(s.byTab[tabId]?.byChatKey[chatKey]) > 0);
}

/** The pill on a thinking or tool row that already has a thread. Rendered
 *  only then — inside a fold, an empty "Comment" glyph per line is noise. */
export const RowCommentPill = memo(function RowCommentPill({
  tabId,
  chatKey,
}: {
  tabId: string;
  chatKey: string;
}) {
  const hit = useAnchorHit(tabId, chatKey);
  const bucket = useCommentBucket(tabId, chatKey);
  const actions = useCommentActions(tabId);
  const directory = useCommentDirectory(tabId);
  if (!hit || !actions || !directory || visibleCount(bucket) === 0) return null;
  return (
    <CommentButton
      className="ml-auto transition-none"
      anchorKind={hit.anchorKind}
      anchorId={hit.rowId}
      comments={bucket}
      actions={actions}
      directory={directory}
    />
  );
});

/**
 * The "Worked" header's summary of every thread inside the fold: faces and a
 * count over the turn's thinking and tool rows. Clicking opens the fold, where
 * each row carries its own pill. Renders nothing at zero.
 */
export const TurnCommentPill = memo(function TurnCommentPill({
  tabId,
  turnId,
  onOpen,
}: {
  tabId: string;
  turnId: string;
  onOpen: () => void;
}) {
  const count = useTurnCommentCount(tabId, turnId);
  const directory = useCommentDirectory(tabId);
  const faces = useMemo(() => {
    if (count === 0 || !directory) return [];
    const tab = tabCommentsFor(useChatCommentsStore.getState(), tabId);
    const all: Comment[] = [];
    for (const rowId of tab.anchors.workByTurn.get(turnId) ?? []) {
      const bucket = tab.byAnchor[rowId];
      if (bucket) all.push(...bucket);
    }
    return facesOf(all, directory);
  }, [count, directory, tabId, turnId]);
  if (count === 0) return null;
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`${count} ${count === 1 ? "comment" : "comments"} on this work`}
      className={cn(
        "ml-auto flex h-5 shrink-0 cursor-pointer items-center gap-1 rounded-full border border-border bg-card pl-0.5 pr-1.5",
        "text-[var(--secondary-foreground)] hover:bg-[var(--atlas-element-hover)] hover:text-[var(--foreground)]",
      )}
    >
      {faces.length > 0 && (
        <span className="flex shrink-0 items-center -space-x-1.5">
          {faces.map((user) => (
            <span key={user.id} className="rounded-full ring-1 ring-[var(--card)]">
              <AccountAvatar user={user} size={14} />
            </span>
          ))}
        </span>
      )}
      <span className="text-2xs tabular-nums">{count > 9 ? "9+" : count}</span>
    </button>
  );
});
