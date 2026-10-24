// The floating composer at the tab's bottom right: a comment (optionally
// closing or reopening with it), or a review with a verdict. Drafts live
// here, not in the popover, so closing it keeps what was typed.

import { useRef, useState } from "react";
import { toast } from "sonner";
import {
  Check,
  GitPullRequestClosed,
  MessageSquare,
  RotateCcw,
  Send,
  X,
  XCircle,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import { IconButton } from "@/ui/icon-button";
import { Popover, PopoverClose, PopoverContent, PopoverTitle, PopoverTrigger } from "@/ui/popover";
import { Segmented } from "@/ui/segmented";

import { classifyPrError } from "../lib/pr-errors";
import { canPerform } from "../lib/pull-request-logic";
import { usePrCommentMutation, usePrSubmitReviewMutation } from "../lib/pull-requests-queries";
import type { PrDetail, PrReviewVerdict } from "../lib/pull-requests-types";
import { useInlineConfirm } from "../lib/use-inline-confirm";
import { readableFailure } from "../lib/use-pull-request-actions";
import { TEXTAREA_CLASS } from "./pull-request-markdown";

const VERDICTS: readonly {
  value: PrReviewVerdict;
  label: string;
  sent: string;
  icon: React.ReactNode;
}[] = [
  {
    value: "comment",
    label: "Comment",
    sent: "Review submitted",
    icon: <MessageSquare className="size-3" />,
  },
  {
    value: "approve",
    label: "Approve",
    sent: "Pull request approved",
    icon: <Check className="size-3" />,
  },
  {
    value: "request-changes",
    label: "Request changes",
    sent: "Changes requested",
    icon: <XCircle className="size-3" />,
  },
];

function isSubmitChord(event: React.KeyboardEvent): boolean {
  return (
    !event.nativeEvent.isComposing &&
    event.key === "Enter" &&
    (event.metaKey || event.ctrlKey) &&
    !event.shiftKey &&
    !event.altKey
  );
}

export function PullRequestComposer({
  repoPath,
  detail,
  pendingAction,
  onCommentAction,
}: {
  repoPath: string;
  detail: PrDetail;
  pendingAction: string | null;
  onCommentAction: (
    body: string,
    action: "close" | "reopen",
  ) => Promise<{ commentPosted: boolean }>;
}) {
  const [open, setOpen] = useState(false);
  const [requestedMode, setRequestedMode] = useState<"comment" | "review">("comment");
  const [comment, setComment] = useState("");
  const [summary, setSummary] = useState("");
  const [requestedVerdict, setRequestedVerdict] = useState<PrReviewVerdict>("comment");
  const [submitting, setSubmitting] = useState<"comment" | "close" | "reopen" | null>(null);
  const commentRef = useRef<HTMLTextAreaElement>(null);
  const reviewRef = useRef<HTMLTextAreaElement>(null);
  const postComment = usePrCommentMutation(repoPath, detail.number);
  const submitReview = usePrSubmitReviewMutation(repoPath, detail.number);
  const confirm = useInlineConfirm(`${repoPath}:${detail.number}:composer`);

  const canComment = detail.capabilities.comment && detail.viewerPermissions.comment;
  const verdicts = VERDICTS.filter(
    (v) =>
      detail.capabilities.review.verdicts.includes(v.value) &&
      detail.viewerPermissions.verdicts.includes(v.value),
  );
  if (!canComment && verdicts.length === 0) return null;
  const mode = canComment ? (verdicts.length === 0 ? "comment" : requestedMode) : "review";
  const verdict = verdicts.find((v) => v.value === requestedVerdict) ?? verdicts[0];

  const followUp =
    detail.state === "open" && canPerform(detail, "close")
      ? ("close" as const)
      : detail.state === "closed" && canPerform(detail, "reopen")
        ? ("reopen" as const)
        : null;
  const busy = submitting !== null || pendingAction !== null;
  const commentEmpty = comment.trim().length === 0;

  const sendComment = async (action: "comment" | "close" | "reopen") => {
    const body = comment.trim();
    if (body.length === 0 || busy) return;
    setSubmitting(action);
    try {
      if (action !== "comment") {
        const result = await onCommentAction(body, action);
        if (result.commentPosted) {
          setComment("");
          setOpen(false);
        }
        return;
      }
      await postComment.mutateAsync(body);
      setComment("");
      setOpen(false);
      toast.success("Comment posted");
    } catch (raw) {
      toast.error("Could not post the comment", {
        description: readableFailure(classifyPrError(raw), "GitHub refused the comment."),
      });
    } finally {
      setSubmitting(null);
    }
  };

  const reviewReady = (v: PrReviewVerdict) => v === "approve" || summary.trim().length > 0;
  const sendReview = () => {
    if (!verdict || !reviewReady(verdict.value) || submitReview.isPending) return;
    const body = summary;
    submitReview.mutate(
      { verdict: verdict.value, body, comments: [] },
      {
        onSuccess: () => {
          // A summary revised while this one was in flight is kept for next time.
          setSummary((current) => (current === body ? "" : current));
          setOpen(false);
          toast.success(verdict.sent);
        },
        onError: (raw) =>
          toast.error("The review could not be submitted", {
            description: readableFailure(classifyPrError(raw), "GitHub refused the review."),
          }),
      },
    );
  };

  const started = summary.trim().length > 0;

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) setRequestedMode(started && verdicts.length > 0 ? "review" : "comment");
        setOpen(next);
      }}
    >
      <span className="flex rounded-full bg-background shadow-md">
        <PopoverTrigger
          render={
            <IconButton
              icon={MessageSquare}
              label={
                mode === "review" && !canComment ? "Review pull request" : "Comment on pull request"
              }
              variant="outline"
              size="lg"
              shape="round"
            />
          }
        />
      </span>
      <PopoverContent
        side="top"
        align="end"
        sideOffset={8}
        className="w-96 max-w-[calc(100vw-2rem)]"
        initialFocus={mode === "review" ? reviewRef : commentRef}
        aria-label="Pull request composer"
      >
        <div className="mb-2.5 flex items-center justify-between gap-2">
          {canComment && verdicts.length > 0 ? (
            <Segmented
              aria-label="Composer mode"
              size="sm"
              value={mode}
              onValueChange={setRequestedMode}
              options={[
                { value: "comment", label: "Comment" },
                { value: "review", label: "Review" },
              ]}
            />
          ) : (
            <PopoverTitle>{mode === "review" ? "Review pull request" : "Comment"}</PopoverTitle>
          )}
          <PopoverClose render={<IconButton icon={X} label="Close composer" size="xs" />} />
        </div>

        <div hidden={mode !== "comment"} className="space-y-2">
          <textarea
            ref={commentRef}
            // Locked while posting: success clears the box, which would throw
            // away anything typed in the meantime.
            disabled={busy}
            value={comment}
            rows={4}
            placeholder="Leave a comment"
            aria-label="Comment on this pull request"
            className={TEXTAREA_CLASS}
            onChange={(event) => setComment(event.target.value)}
            onKeyDown={(event) => {
              if (!isSubmitChord(event)) return;
              event.preventDefault();
              event.stopPropagation();
              if (!event.repeat) void sendComment("comment");
            }}
          />
          <div className="flex flex-wrap justify-end gap-2">
            {followUp === "close" ? (
              <Button
                size="xs"
                variant="outline"
                disabled={commentEmpty || busy}
                {...confirm.props("close", () => void sendComment("close"))}
              >
                <GitPullRequestClosed aria-hidden className="size-3.5 text-error" />
                <span className="inline-grid">
                  <span aria-hidden className="invisible col-start-1 row-start-1">
                    Close with comment
                  </span>
                  <span className="col-start-1 row-start-1">
                    {submitting === "close"
                      ? "Closing…"
                      : confirm.isArmed("close")
                        ? "Confirm close?"
                        : "Close with comment"}
                  </span>
                </span>
              </Button>
            ) : followUp === "reopen" ? (
              <Button
                size="xs"
                variant="outline"
                disabled={commentEmpty || busy}
                onClick={() => void sendComment("reopen")}
              >
                <RotateCcw aria-hidden className="size-3.5" />
                {submitting === "reopen" ? "Reopening…" : "Reopen with comment"}
              </Button>
            ) : null}
            <Button
              size="xs"
              disabled={commentEmpty || busy}
              onClick={() => void sendComment("comment")}
            >
              <Send aria-hidden className="size-3.5" />
              {submitting === "comment" ? "Posting…" : "Comment"}
            </Button>
          </div>
        </div>

        {verdicts.length > 0 ? (
          <div hidden={mode !== "review"} className="space-y-2">
            <textarea
              ref={reviewRef}
              disabled={submitReview.isPending}
              value={summary}
              rows={4}
              placeholder={
                verdict && verdict.value === "approve"
                  ? "Summarize your review (optional)"
                  : "Summarize your review"
              }
              aria-label="Review summary"
              className={TEXTAREA_CLASS}
              onChange={(event) => setSummary(event.target.value)}
              onKeyDown={(event) => {
                if (!isSubmitChord(event)) return;
                event.preventDefault();
                event.stopPropagation();
                if (!event.repeat) sendReview();
              }}
            />
            <div className="flex flex-wrap items-center justify-end gap-2">
              {verdicts.length > 1 ? (
                <div className="mr-auto">
                  <Segmented
                    aria-label="Review verdict"
                    size="sm"
                    value={verdict?.value ?? "comment"}
                    disabled={submitReview.isPending}
                    onValueChange={setRequestedVerdict}
                    options={verdicts.map((v) => ({
                      value: v.value,
                      label: v.label,
                      icon: v.icon,
                    }))}
                  />
                </div>
              ) : null}
              <Button
                size="xs"
                variant={verdict?.value === "request-changes" ? "destructive" : "default"}
                disabled={submitReview.isPending || !verdict || !reviewReady(verdict.value)}
                onClick={sendReview}
              >
                {submitReview.isPending ? "Submitting…" : "Submit review"}
              </Button>
            </div>
          </div>
        ) : null}
        <p className={cn("mt-2 text-2xs text-muted-foreground")}>⌘↵ to send</p>
      </PopoverContent>
    </Popover>
  );
}
