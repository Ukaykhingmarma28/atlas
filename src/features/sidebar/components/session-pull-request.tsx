// A session's linked pull requests, as the sidebar shows them: the badge on a
// row and the lines in the hover card.
//
// The data is the session row's own `pullRequests` (opened from the session,
// found on its branch, linked by the user or by the agent), kept current by
// the sidebar's sweep. Nothing here reads the host. Both exports render
// nothing for a session with none.

import type { MouseEvent } from "react";

import type { PullRequestLink } from "@/features/chat/lib/history-api";
import { openLinkedPullRequest } from "@/features/pull-requests/lib/open-linked-pull-request";
import {
  CHECKS_STATE_PRESENTATION,
  STATE_PRESENTATION,
} from "@/features/pull-requests/components/pull-request-presentation";
import {
  LINK_SOURCE_LABEL,
  linkState,
  orderLinks,
  pullRequestBadge,
} from "@/features/pull-requests/lib/session-pull-request-links";
import { cn } from "@/lib/utils";

const CHECKS_LABEL = {
  passing: "Checks passing",
  failing: "Checks failing",
  pending: "Checks running",
} as const;

/** "Open pull request #12: Add discounts" */
function linkLabel(link: PullRequestLink): string {
  const state = STATE_PRESENTATION[linkState(link)];
  const title = link.snapshot?.title;
  return `${state.label} pull request #${link.number}${title ? `: ${title}` : ""}`;
}

/** A link from another repository opens on the host, not as `cwd + number`. */
function open(cwd: string, link: PullRequestLink): void {
  void openLinkedPullRequest(cwd, { ...link, title: link.snapshot?.title });
}

/** The row's badge: the current pull request's state glyph and number, then
 *  "+N" for the others. Opens the current one. */
export function SessionPullRequestBadge({
  cwd,
  pullRequests,
}: {
  cwd: string;
  pullRequests: readonly PullRequestLink[];
}) {
  const badge = pullRequestBadge(pullRequests);
  if (!badge) return null;
  const state = STATE_PRESENTATION[linkState(badge.link)];
  const label =
    badge.others > 0 ? `${linkLabel(badge.link)}, and ${badge.others} more` : linkLabel(badge.link);
  return (
    <button
      type="button"
      aria-label={`${label} — open`}
      title={label}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event: MouseEvent) => {
        event.preventDefault();
        event.stopPropagation();
        open(cwd, badge.link);
      }}
      className="inline-flex shrink-0 cursor-pointer items-center gap-0.5 rounded-sm text-xs tabular-nums hover:underline"
    >
      <state.Icon aria-hidden className={cn("size-3 shrink-0", state.toneClassName)} />
      <span className={state.toneClassName}>#{badge.link.number}</span>
      {badge.others > 0 && <span className="text-muted-foreground">+{badge.others}</span>}
    </button>
  );
}

/** The hover card's lines: every linked pull request with its state and
 *  checks, the current one first. Each opens its pull request's tab. */
export function SessionPullRequestLines({
  cwd,
  pullRequests,
}: {
  cwd: string;
  pullRequests: readonly PullRequestLink[];
}) {
  if (pullRequests.length === 0) return null;
  return (
    <>
      {orderLinks(pullRequests).map((link) => {
        const state = STATE_PRESENTATION[linkState(link)];
        const checksState = link.snapshot?.state === "open" ? link.snapshot.checksState : null;
        const checks = checksState ? CHECKS_STATE_PRESENTATION[checksState] : null;
        return (
          <button
            key={`${link.repository}#${link.number}`}
            type="button"
            aria-label={`${linkLabel(link)} — open`}
            title={`${link.url}\n${LINK_SOURCE_LABEL[link.source]}`}
            onClick={() => open(cwd, link)}
            className="flex min-w-0 cursor-pointer items-center gap-2 rounded-sm text-left hover:text-foreground"
          >
            <state.Icon aria-hidden className={cn("size-3 shrink-0", state.toneClassName)} />
            <span className="min-w-0 flex-1 truncate text-secondary-foreground hover:text-foreground">
              #{link.number} {link.snapshot?.title ?? link.repository}
            </span>
            {checks && checksState && (
              <checks.Icon
                aria-label={CHECKS_LABEL[checksState]}
                className={cn("size-3 shrink-0", checks.toneClassName)}
              />
            )}
          </button>
        );
      })}
    </>
  );
}
