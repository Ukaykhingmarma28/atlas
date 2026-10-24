// One row of the pull-request list: the state glyph (with a conflict mark),
// the number and title, the checks and review signals, and under them the
// author, labels, comments and when it last moved. Clicking opens the pull
// request in its own tab.

import { memo, type ReactNode } from "react";
import {
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleX,
  MessageSquare,
  Search,
  type LucideIcon,
} from "lucide-react";

import { timeAgo } from "@/lib/time-ago";
import { cn } from "@/lib/utils";

import type { PrListEntry, PrReviewDecision } from "../lib/pull-requests-types";
import {
  ActorAvatar,
  actorTitle,
  CHECKS_STATE_PRESENTATION,
  LabelChip,
  resolveStatePresentation,
} from "./pull-request-presentation";

/** The row's slot height, which the list virtualizes on. */
export const PULL_REQUEST_ROW_HEIGHT = 52;

const CHECKS_LABEL = {
  passing: "Checks passing",
  failing: "Checks failing",
  pending: "Checks running",
} as const;

const REVIEW: Record<PrReviewDecision, { Icon: LucideIcon; tone: string; label: string }> = {
  approved: { Icon: CircleCheck, tone: "text-success", label: "Approved" },
  "changes-requested": { Icon: CircleX, tone: "text-error", label: "Changes requested" },
  "review-required": {
    Icon: CircleDashed,
    tone: "text-muted-foreground",
    label: "Review required",
  },
};

function Signal({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span title={label} aria-label={label} role="img" className="inline-flex shrink-0">
      {children}
    </span>
  );
}

function PullRequestListRowImpl({
  entry,
  matchedElsewhere,
  onOpen,
}: {
  entry: PrListEntry;
  /** A search hit whose match is somewhere the row does not show. */
  matchedElsewhere: boolean;
  onOpen: (entry: PrListEntry) => void;
}) {
  const state = resolveStatePresentation(entry);
  const checks =
    entry.state === "open" && entry.checksState
      ? CHECKS_STATE_PRESENTATION[entry.checksState]
      : null;
  const review =
    entry.state === "open" && entry.reviewDecision ? REVIEW[entry.reviewDecision] : null;
  const conflicting = entry.state === "open" && entry.mergeability === "conflicting";
  const label = `${state.label} pull request #${entry.number}: ${entry.title}`;
  return (
    <button
      type="button"
      onClick={() => onOpen(entry)}
      aria-label={label}
      title={entry.url}
      className={cn(
        "group/pr-row flex h-full w-full min-w-0 cursor-pointer items-start gap-2 rounded px-2 py-1.5 text-left",
        "hover:bg-element-hover focus-visible:bg-element-hover focus-visible:outline-none",
      )}
    >
      <span className="relative mt-0.5 inline-flex shrink-0">
        <state.Icon aria-hidden className={cn("size-3.5", state.toneClassName)} />
        {conflicting ? (
          <span className="absolute -right-1 -bottom-1 inline-flex rounded-full bg-background">
            <Signal label="Has conflicts">
              <CircleAlert aria-hidden className="size-2.5 text-warning" />
            </Signal>
          </span>
        ) : null}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
            #{entry.number}
          </span>
          <span className="min-w-0 truncate text-xs text-foreground">{entry.title}</span>
          {checks && entry.checksState ? (
            <Signal label={CHECKS_LABEL[entry.checksState]}>
              <checks.Icon aria-hidden className={cn("size-3", checks.toneClassName)} />
            </Signal>
          ) : null}
          {review ? (
            <Signal label={review.label}>
              <review.Icon aria-hidden className={cn("size-3", review.tone)} />
            </Signal>
          ) : null}
        </span>
        <span className="mt-0.5 flex min-w-0 items-center gap-1.5 overflow-hidden text-2xs text-muted-foreground">
          {matchedElsewhere ? (
            <span
              title="Matched in the description"
              className="flex shrink-0 items-center gap-1 rounded-full border border-border px-1"
            >
              <Search aria-hidden className="size-2.5" />
              <span className="sr-only">Matched in the description</span>
            </span>
          ) : null}
          <span title={actorTitle(entry.author)} className="flex min-w-0 items-center gap-1">
            <ActorAvatar actor={entry.author} className="size-3.5" />
            <span className="truncate">{entry.author?.login ?? "ghost"}</span>
          </span>
          {entry.labels.slice(0, 2).map((labelEntry) => (
            <span key={labelEntry.name} className="hidden min-w-0 shrink @sm/pr-list:inline-flex">
              <LabelChip label={labelEntry} />
            </span>
          ))}
          {entry.labels.length > 2 ? (
            <span className="hidden shrink-0 @sm/pr-list:inline">+{entry.labels.length - 2}</span>
          ) : null}
          <span className="ml-auto flex shrink-0 items-center gap-2 tabular-nums">
            {entry.commentCount > 0 ? (
              <span
                className="flex items-center gap-0.5"
                title={`${entry.commentCount} comment${entry.commentCount === 1 ? "" : "s"}`}
              >
                <MessageSquare aria-hidden className="size-2.5" />
                {entry.commentCount}
              </span>
            ) : null}
            <span title={new Date(entry.updatedAt).toLocaleString()}>
              {timeAgo(entry.updatedAt)}
            </span>
          </span>
        </span>
      </span>
    </button>
  );
}

export const PullRequestListRow = memo(PullRequestListRowImpl);
