/**
 * The inline comment thread — a Figma-style popover hung off a timeline node.
 *
 * Inline rather than a side panel, because a comment is *about one row* and a
 * panel makes you hold the anchor in your head while you read it. The thread
 * opens beside the thing it is discussing and closes again.
 *
 * ## Shape
 *
 * A root, its replies, and a composer. Replies are exactly one level deep —
 * that is the server's rule, not a simplification: it refuses to re-parent a
 * reply, so a nested tree could never be sent.
 *
 * ## What is deliberately absent
 *
 * **Offline drafting.** Comments are network-only; there is no local table and
 * nothing queues. The composer disables itself and says so rather than
 * accepting text it would silently lose.
 *
 * **Reactions.** The server has no reactions model on this surface — no table,
 * no route — so there is nothing to render.
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Popover } from "@base-ui/react/popover";
import { Check, Loader2, MessageSquare, Trash2 } from "lucide-react";

import { CommsAvatar } from "@/features/comms/components/comms-avatar";
import { useCommsStore } from "@/features/comms/stores/comms-store";
import type { OrgMemberProfile } from "@/features/comms/types";
import { cn } from "@/lib/utils";

import { COMMENT_BODY_MAX, visibleCount, type AnchorKind, type Comment } from "../lib/comments-api";

/** Everything the thread needs to talk to the server, supplied by the panel. */
export interface CommentActions {
  post: (
    anchorKind: AnchorKind,
    anchorId: string,
    body: string,
    parentId: string | null,
  ) => Promise<void>;
  resolve: (commentId: string, resolved: boolean) => Promise<void>;
  remove: (commentId: string) => Promise<void>;
}

/**
 * The button that opens a thread, and the thread itself.
 *
 * Hidden until hover when the anchor has nothing on it, and **permanently
 * visible with a count** once it does: a conversation you cannot see without
 * hovering every row is a conversation nobody reads.
 */
export const CommentButton = memo(function CommentButton({
  anchorKind,
  anchorId,
  comments,
  actions,
  currentUserId,
  className,
  label = "Comment",
}: {
  anchorKind: AnchorKind;
  anchorId: string;
  comments: Comment[] | undefined;
  actions: CommentActions;
  /** Whose comments carry edit/delete affordances. */
  currentUserId: string | null;
  className?: string;
  label?: string;
}) {
  const count = visibleCount(comments);
  return (
    <Popover.Root>
      <Popover.Trigger
        aria-label={count > 0 ? `${label} (${count})` : label}
        className={cn(
          "flex h-5 shrink-0 cursor-pointer items-center gap-1 rounded px-1 text-[var(--atlas-text-disabled)] transition-all duration-150 hover:bg-[var(--atlas-element-hover)] hover:text-[var(--foreground)] focus-visible:opacity-100",
          count > 0
            ? "text-[var(--secondary-foreground)] opacity-100"
            : cn("opacity-0", className ?? "group-hover/row:opacity-100"),
        )}
      >
        <MessageSquare size={11} strokeWidth={1.7} />
        {count > 0 && <span className="text-2xs tabular-nums">{count}</span>}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner className="isolate z-popover" side="bottom" align="end" sideOffset={6}>
          <Popover.Popup
            className={cn(
              "w-[340px] origin-[var(--transform-origin)] rounded-lg border border-border bg-popover shadow-md outline-none",
              "data-closed:animate-scale-out data-open:animate-scale-in",
              // `body` sets `user-select: none`; a thread you cannot select
              // text in is a thread you cannot quote.
              "select-text",
            )}
          >
            <Thread
              anchorKind={anchorKind}
              anchorId={anchorId}
              comments={comments ?? []}
              actions={actions}
              currentUserId={currentUserId}
            />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
});

function Thread({
  anchorKind,
  anchorId,
  comments,
  actions,
  currentUserId,
}: {
  anchorKind: AnchorKind;
  anchorId: string;
  comments: Comment[];
  actions: CommentActions;
  currentUserId: string | null;
}) {
  const members = useCommsStore.use.members();
  const byId = useMemo(() => new Map(members.map((m) => [m.id, m] as const)), [members]);

  // Roots in server order, each with its replies. One level deep, so this is a
  // partition rather than a tree walk.
  const threads = useMemo(() => {
    const replies = new Map<string, Comment[]>();
    for (const c of comments) {
      if (!c.parentId) continue;
      const bucket = replies.get(c.parentId);
      if (bucket) bucket.push(c);
      else replies.set(c.parentId, [c]);
    }
    return comments
      .filter((c) => !c.parentId)
      .map((root) => ({ root, replies: replies.get(root.id) ?? [] }));
  }, [comments]);

  // An open thread should scroll to the newest, which is where the conversation
  // actually is — not to the top, which is where it started.
  const endRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "nearest" });
  }, [comments.length]);

  return (
    <div className="flex max-h-[380px] flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-2.5 py-2">
        {threads.length === 0 ? (
          <p className="py-1 text-xs text-[var(--muted-foreground)]">
            No comments on this {anchorKind === "session" ? "Session" : "step"} yet.
          </p>
        ) : (
          <div className="space-y-2.5">
            {threads.map(({ root, replies }) => (
              <div key={root.id} className="space-y-1.5">
                <CommentRow
                  comment={root}
                  member={byId.get(root.authorId) ?? null}
                  currentUserId={currentUserId}
                  actions={actions}
                  isRoot
                />
                {replies.length > 0 && (
                  <div className="space-y-1.5 border-l border-border pl-2.5">
                    {replies.map((reply) => (
                      <CommentRow
                        key={reply.id}
                        comment={reply}
                        member={byId.get(reply.authorId) ?? null}
                        currentUserId={currentUserId}
                        actions={actions}
                        isRoot={false}
                      />
                    ))}
                  </div>
                )}
                <Composer
                  placeholder="Reply…"
                  onSend={(body) => actions.post(anchorKind, anchorId, body, root.id)}
                />
              </div>
            ))}
          </div>
        )}
        <div ref={endRef} />
      </div>

      {/* Starting a new thread, as opposed to replying to one. Kept pinned
       *  below the scroller so it does not move as the thread grows. */}
      <div className="border-t border-border px-2.5 py-2">
        <Composer
          placeholder={
            threads.length === 0
              ? "Say something — @-mention with <@their-id>"
              : "Start a new thread…"
          }
          onSend={(body) => actions.post(anchorKind, anchorId, body, null)}
          autoFocus={threads.length === 0}
        />
      </div>
    </div>
  );
}

const CommentRow = memo(function CommentRow({
  comment,
  member,
  currentUserId,
  actions,
  isRoot,
}: {
  comment: Comment;
  member: OrgMemberProfile | null;
  currentUserId: string | null;
  actions: CommentActions;
  isRoot: boolean;
}) {
  const [busy, setBusy] = useState(false);
  // A guest is never rendered as a member, even if an id happens to collide.
  const name = comment.guestName ?? member?.name ?? comment.authorId;
  const mine = currentUserId !== null && comment.authorId === currentUserId;
  const resolved = comment.resolvedAt !== null;

  if (comment.deletedAt) {
    // The row survives so replies keep their places, and saying so is more
    // honest than a gap where a comment used to be.
    return <p className="text-2xs italic text-[var(--atlas-text-disabled)]">Comment deleted</p>;
  }

  const run = (action: () => Promise<void>) => {
    setBusy(true);
    void action().finally(() => setBusy(false));
  };

  return (
    <div className={cn("group/comment", resolved && "opacity-55")}>
      <div className="flex items-center gap-1.5">
        <CommsAvatar member={comment.guestName ? null : member} size={14} />
        <span className="min-w-0 truncate text-2xs font-medium text-[var(--secondary-foreground)]">
          {name}
        </span>
        {comment.guestName && (
          <span className="shrink-0 text-3xs text-[var(--atlas-text-disabled)]">guest</span>
        )}
        <span className="shrink-0 font-mono text-3xs text-[var(--atlas-text-disabled)]">
          {time(comment.createdAt)}
        </span>
        {comment.editedAt && (
          <span className="shrink-0 text-3xs text-[var(--atlas-text-disabled)]">edited</span>
        )}
        <span className="flex-1" />
        {busy && <Loader2 size={10} className="animate-spin text-[var(--muted-foreground)]" />}
        {/* Resolving is a root-only action, and the server refuses it on a
         *  reply — so the affordance is not offered on one. Anyone who can
         *  read may resolve; only the author may delete. */}
        {isRoot && !busy && (
          <button
            type="button"
            onClick={() => run(() => actions.resolve(comment.id, !resolved))}
            className="flex cursor-pointer items-center gap-0.5 rounded px-1 text-3xs text-[var(--muted-foreground)] opacity-0 transition-colors hover:text-[var(--foreground)] group-hover/comment:opacity-100"
          >
            <Check size={9} />
            {resolved ? "Reopen" : "Resolve"}
          </button>
        )}
        {mine && !busy && (
          <button
            type="button"
            aria-label="Delete comment"
            onClick={() => run(() => actions.remove(comment.id))}
            className="flex cursor-pointer items-center rounded px-1 text-[var(--muted-foreground)] opacity-0 transition-colors hover:text-[var(--atlas-status-error-foreground)] group-hover/comment:opacity-100"
          >
            <Trash2 size={9} />
          </button>
        )}
      </div>
      <p className="mt-0.5 whitespace-pre-wrap break-words pl-[22px] text-xs leading-snug text-[var(--foreground)]">
        <Body text={comment.body ?? ""} />
      </p>
    </div>
  );
});

/**
 * A comment body with its mentions drawn as pills.
 *
 * `<@user-id>` is the same syntax team chat uses and the same one the server
 * parses out of the stored body, so the three agree by construction. This is a
 * split rather than a markdown pass on purpose: a comment is a sentence, and
 * running the full pipeline over every one of them in a popover would cost more
 * than it renders.
 */
const MENTION = /<@([A-Za-z0-9_.:-]{1,128})>/g;

function Body({ text }: { text: string }) {
  const members = useCommsStore.use.members();
  const parts = useMemo(() => {
    const out: Array<{ text: string; mention: boolean }> = [];
    let last = 0;
    for (const match of text.matchAll(MENTION)) {
      const at = match.index ?? 0;
      if (at > last) out.push({ text: text.slice(last, at), mention: false });
      out.push({ text: match[1], mention: true });
      last = at + match[0].length;
    }
    if (last < text.length) out.push({ text: text.slice(last), mention: false });
    return out;
  }, [text]);

  return (
    <>
      {parts.map((part, i) =>
        part.mention ? (
          <span
            // eslint-disable-next-line react/no-array-index-key
            key={i}
            className="rounded bg-[var(--atlas-element-emphasis)] px-1 text-[var(--foreground)]"
          >
            @{members.find((m) => m.id === part.text)?.name ?? part.text}
          </span>
        ) : (
          // eslint-disable-next-line react/no-array-index-key
          <span key={i}>{part.text}</span>
        ),
      )}
    </>
  );
}

function Composer({
  placeholder,
  onSend,
  autoFocus,
}: {
  placeholder: string;
  onSend: (body: string) => Promise<void>;
  autoFocus?: boolean;
}) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = useCallback(() => {
    const body = value.trim();
    if (!body || busy) return;
    setBusy(true);
    setError(null);
    onSend(body)
      .then(() => setValue(""))
      // The text stays in the box on failure. There is no offline queue, so
      // clearing it would destroy what the developer wrote.
      .catch((e: unknown) => setError(String(e)))
      .finally(() => setBusy(false));
  }, [value, busy, onSend]);

  const over = value.length > COMMENT_BODY_MAX;

  return (
    <div>
      <textarea
        value={value}
        autoFocus={autoFocus}
        placeholder={placeholder}
        rows={1}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          // Enter sends, Shift+Enter breaks the line — the chat composer's
          // rule, because this reads as chat.
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            send();
          }
        }}
        className="w-full resize-none rounded-lg border border-border bg-panel-input px-2 py-1.5 text-xs text-[var(--foreground)] placeholder:text-[var(--muted-foreground)] outline-none transition-colors focus:border-border-strong"
      />
      {over && (
        <p className="mt-1 text-3xs text-[var(--atlas-status-error-foreground)]">
          {value.length.toLocaleString()} / {COMMENT_BODY_MAX.toLocaleString()} characters
        </p>
      )}
      {error && (
        <p className="mt-1 text-3xs text-[var(--atlas-status-error-foreground)]">{error}</p>
      )}
    </div>
  );
}

/** `HH:MM:SS`, matching the timestamps the rest of the Session detail uses. */
function time(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString();
}
