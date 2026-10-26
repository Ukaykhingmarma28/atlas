/**
 * A row's comment threads, in the transcript itself.
 *
 * Under a prompt or a response, each thread is a block: the passage it is
 * about (quoted, and painted in the prose above through
 * `comment-highlights.ts`), the comment, its replies, and Reply / Resolve.
 * A comment being started — from a click on the prose, the selection pill's
 * Comment, or the footer's — is a composer in the same place, so writing one
 * and reading one are the same gesture. Threads are part of the transcript,
 * not a popover hung off it.
 *
 * Reads `chat-comments-store` through narrow selectors only, so a row with
 * no thread and no composer costs its selectors and renders nothing. A
 * session that is not shared has no anchors, so nothing here draws for it.
 */

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Check, CornerDownRight, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { CommenterAvatar, commenterName } from "@/components/commenter-avatar";
import { CommentBody, type CommentActions } from "@/features/artifacts/components/comment-thread";
import { COMMENT_BODY_MAX, type Comment } from "@/features/artifacts/lib/comments-api";
import {
  selectionCommentBody,
  splitSelectionComment,
} from "@/features/artifacts/lib/selection-comment";
import type { OrgDirectory } from "@/features/organisations/lib/use-org-directory";
import { timeAgo } from "@/lib/time-ago";
import { cn } from "@/lib/utils";

import {
  clearHighlightRanges,
  COMMENT_HIGHLIGHT,
  DRAFT_HIGHLIGHT,
  findPassageRange,
  highlightsSupported,
  indexText,
  setHighlightRanges,
} from "../lib/comment-highlights";
import {
  useAnchorHit,
  useChatCommentsStore,
  useCommentActions,
  useCommentBucket,
  useCommentDirectory,
  useComposeRequest,
  useThreadOpenSignal,
} from "../stores/chat-comments-store";

/** A thread as drawn: its root and the replies under it. */
interface Thread {
  root: Comment;
  replies: Comment[];
  /** The passage the root is about, when it is about one. */
  passage: string | null;
  /** The root's own words, without the quoted passage. */
  text: string;
}

function threadsOf(comments: readonly Comment[]): Thread[] {
  const out: Thread[] = [];
  for (const c of comments) {
    if (c.parentId !== null || c.deletedAt !== null) continue;
    const split = c.body ? splitSelectionComment(c.body) : null;
    out.push({
      root: c,
      replies: comments.filter((r) => r.parentId === c.id && r.deletedAt === null),
      passage: split?.selection ?? null,
      text: split?.body ?? c.body ?? "",
    });
  }
  return out;
}

/** Paint the threads' passages in the row's prose, and the one being written
 *  about one step stronger. Re-run when the prose DOM changes under it (the
 *  markdown cache lands a parse later than the row mounts). */
function useCommentHighlights(
  proseRef: React.RefObject<HTMLElement | null>,
  passages: readonly string[],
  draft: string | null,
) {
  const owner = useRef({});
  const key = passages.join("\u0000");
  useLayoutEffect(() => {
    const root = proseRef.current;
    if (!root || !highlightsSupported()) return;
    const me = owner.current;
    const apply = () => {
      const index = indexText(root);
      const ranges: Range[] = [];
      for (const p of passages) {
        const r = findPassageRange(root, p, index);
        if (r) ranges.push(r);
      }
      setHighlightRanges(COMMENT_HIGHLIGHT, me, ranges);
      const d = draft ? findPassageRange(root, draft, index) : null;
      setHighlightRanges(DRAFT_HIGHLIGHT, me, d ? [d] : []);
    };
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(root, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      clearHighlightRanges(COMMENT_HIGHLIGHT, me);
      clearHighlightRanges(DRAFT_HIGHLIGHT, me);
    };
    // `key` stands in for `passages`, which is rebuilt per render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [proseRef, key, draft]);
}

export const InlineCommentThreads = memo(function InlineCommentThreads({
  tabId,
  chatKey,
  proseRef,
  className,
}: {
  tabId: string;
  /** The row's chat key: its message id. */
  chatKey: string;
  /** The row's rendered prose, for the passage highlights. */
  proseRef: React.RefObject<HTMLElement | null>;
  className?: string;
}) {
  const hit = useAnchorHit(tabId, chatKey);
  const bucket = useCommentBucket(tabId, chatKey);
  const actions = useCommentActions(tabId);
  const directory = useCommentDirectory(tabId);
  const compose = useComposeRequest(tabId, chatKey);
  const openSignal = useThreadOpenSignal(tabId, hit?.rowId);
  const threads = useMemo(() => threadsOf(bucket ?? []), [bucket]);
  const passages = useMemo(
    () => threads.filter((t) => t.passage !== null).map((t) => t.passage as string),
    [threads],
  );
  const composing = !!compose && !!hit && !!actions;
  useCommentHighlights(proseRef, passages, composing ? compose.selection : null);

  // A jump from the comments panel: bring the threads into view.
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (openSignal === undefined) return;
    rootRef.current?.scrollIntoView({ block: "nearest" });
  }, [openSignal]);

  const endCompose = useCallback(
    () => useChatCommentsStore.getState().actions.endCompose(tabId, chatKey),
    [tabId, chatKey],
  );

  if (!hit || !actions || !directory || (threads.length === 0 && !composing)) return null;
  return (
    <div
      ref={rootRef}
      data-comment-threads
      className={cn("mt-2 flex w-full flex-col gap-2", className)}
    >
      {threads.map((thread) => (
        <ThreadBlock
          key={thread.root.id}
          thread={thread}
          actions={actions}
          directory={directory}
          anchorKind={hit.anchorKind}
          anchorId={hit.rowId}
        />
      ))}
      {composing && (
        <ThreadComposer
          key={compose.n}
          selection={compose.selection}
          directory={directory}
          placeholder={compose.selection ? "Comment on this passage…" : "Comment…"}
          onSubmit={async (text) => {
            const body = compose.selection ? selectionCommentBody(compose.selection, text) : text;
            await actions.post(hit.anchorKind, hit.rowId, body, null);
            endCompose();
          }}
          onCancel={endCompose}
        />
      )}
    </div>
  );
});

function ThreadBlock({
  thread,
  actions,
  directory,
  anchorKind,
  anchorId,
}: {
  thread: Thread;
  actions: CommentActions;
  directory: OrgDirectory;
  anchorKind: Comment["anchorKind"];
  anchorId: string;
}) {
  const { root, replies, passage, text } = thread;
  const resolved = root.resolvedAt !== null;
  const [expanded, setExpanded] = useState(false);
  const [replying, setReplying] = useState(false);
  const count = 1 + replies.length;

  if (resolved && !expanded) {
    return (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        className="flex h-6 w-fit cursor-pointer items-center gap-1.5 rounded-full border border-border bg-card px-2 text-2xs text-muted-foreground transition-colors hover:text-foreground"
      >
        <Check size={12} />
        Resolved · {count === 1 ? "1 comment" : `${count} comments`}
      </button>
    );
  }

  return (
    <section
      aria-label="Comment thread"
      className={cn(
        // The design system's ringed block with a rail on its left in the
        // theme's ink, the same ink that paints the passage above it.
        "rounded-lg border border-border border-l-2 border-l-[var(--primary)] bg-card px-3 py-2",
        resolved && "opacity-60",
      )}
    >
      {passage && (
        <blockquote
          aria-label="Commented passage"
          className="mb-1.5 line-clamp-3 whitespace-pre-wrap break-words text-xs leading-snug text-muted-foreground"
        >
          {passage}
        </blockquote>
      )}
      <CommentLine comment={root} text={text} directory={directory} actions={actions} />
      {replies.map((reply) => (
        <div key={reply.id} className="mt-2 pl-6">
          <CommentLine
            comment={reply}
            text={reply.body ?? ""}
            directory={directory}
            actions={actions}
          />
        </div>
      ))}
      <div className="mt-1.5 flex items-center gap-1 pl-6">
        {!replying && (
          <ThreadAction onClick={() => setReplying(true)}>
            <CornerDownRight size={11} />
            Reply
          </ThreadAction>
        )}
        <ThreadAction
          onClick={() =>
            actions
              .resolve(root.id, !resolved)
              .then(() => setExpanded(false))
              .catch(() => toast.error("Could not update the thread"))
          }
        >
          <Check size={11} />
          {resolved ? "Reopen" : "Resolve"}
        </ThreadAction>
      </div>
      {replying && (
        <div className="mt-1.5 pl-6">
          <ThreadComposer
            selection={null}
            directory={directory}
            placeholder="Reply…"
            onSubmit={async (reply) => {
              await actions.post(anchorKind, anchorId, reply, root.id);
              setReplying(false);
            }}
            onCancel={() => setReplying(false)}
          />
        </div>
      )}
    </section>
  );
}

function CommentLine({
  comment,
  text,
  directory,
  actions,
}: {
  comment: Comment;
  text: string;
  directory: OrgDirectory;
  actions: CommentActions;
}) {
  const own = comment.authorId === directory.currentUserId;
  return (
    <div className="group/comment flex items-start gap-1.5">
      <CommenterAvatar commenter={comment} directory={directory} size={18} className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-1.5">
          <span className="truncate text-xs font-medium text-foreground">
            {commenterName(comment, directory)}
          </span>
          <span className="shrink-0 text-2xs text-muted-foreground">
            {timeAgo(comment.createdAt)}
            {comment.editedAt && " · edited"}
          </span>
          {own && (
            <button
              type="button"
              aria-label="Delete comment"
              onClick={() =>
                actions.remove(comment.id).catch(() => toast.error("Could not delete the comment"))
              }
              className="ml-auto flex size-5 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground opacity-0 transition-colors hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover/comment:opacity-100"
            >
              <Trash2 size={11} />
            </button>
          )}
        </div>
        <CommentBody text={text} directory={directory} />
      </div>
    </div>
  );
}

function ThreadAction({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex h-5 cursor-pointer items-center gap-1 rounded-full px-1.5 text-2xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
    >
      {children}
    </button>
  );
}

/** The inline composer: a field that grows with its text, Enter to send,
 *  Shift+Enter for a newline, Escape to put it away. */
function ThreadComposer({
  selection,
  directory,
  placeholder,
  onSubmit,
  onCancel,
}: {
  selection: string | null;
  directory: OrgDirectory;
  placeholder: string;
  onSubmit: (text: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    fieldRef.current?.focus();
  }, []);
  const trimmed = text.trim();
  const length = selection ? selectionCommentBody(selection, trimmed).length : trimmed.length;
  const over = length > COMMENT_BODY_MAX;
  const canSend = trimmed.length > 0 && !over && !busy;
  const me = directory.currentUserId
    ? { authorId: directory.currentUserId, guestName: null }
    : { authorId: "", guestName: "You" };

  const send = () => {
    if (!canSend) return;
    setBusy(true);
    onSubmit(trimmed).catch((err) => {
      toast.error(`Could not post the comment: ${err instanceof Error ? err.message : err}`);
      setBusy(false);
    });
  };

  return (
    <form
      data-comment-composer
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
      className="rounded-lg border border-border border-l-2 border-l-[var(--primary)] bg-card px-3 py-2"
    >
      {selection && (
        <blockquote
          aria-label="Selected passage"
          className="mb-1.5 line-clamp-3 whitespace-pre-wrap break-words text-xs leading-snug text-muted-foreground"
        >
          {selection}
        </blockquote>
      )}
      <div className="flex items-start gap-1.5">
        <CommenterAvatar commenter={me} directory={directory} size={18} className="mt-0.5" />
        <textarea
          ref={fieldRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            } else if (e.key === "Escape") {
              e.preventDefault();
              onCancel();
            }
          }}
          rows={1}
          placeholder={placeholder}
          aria-label={placeholder}
          disabled={busy}
          className="field-sizing-content min-h-6 w-full resize-none bg-transparent py-0.5 text-xs leading-snug text-foreground outline-none placeholder:text-muted-foreground"
        />
      </div>
      <div className="mt-1.5 flex items-center justify-end gap-1 pl-6">
        {over && (
          <span className="mr-auto text-2xs text-destructive">
            {length - COMMENT_BODY_MAX} over the limit
          </span>
        )}
        <ThreadAction onClick={onCancel}>Cancel</ThreadAction>
        <button
          type="submit"
          disabled={!canSend}
          className="flex h-5 cursor-pointer items-center rounded-full bg-primary px-2 text-2xs font-medium text-primary-foreground transition-opacity disabled:cursor-default disabled:opacity-40"
        >
          {selection === null && placeholder === "Reply…" ? "Reply" : "Comment"}
        </button>
      </div>
    </form>
  );
}
