// A session's pull request, as the sidebar shows it: the badge on a row and
// the line in the hover card.
//
// Kept in this one file on purpose. Today the only source is the repository's
// shared `gh` lookup by branch (`useBranchPullRequest`), which knows one pull
// request per branch; a richer per-session pull-request layer is coming, and
// it should replace this file's data source without touching the row. Both
// exports render nothing until there is data: no `gh`, no GitHub remote or no
// pull request for the branch all look the same — absent.

import type { MouseEvent } from "react";
import { GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  openPullRequest,
  useBranchPullRequest,
  type BranchPullRequest,
} from "@/features/git/lib/git-pr-api";

const PR_STATE: Record<
  BranchPullRequest["state"],
  { icon: typeof GitPullRequest; className: string; label: string }
> = {
  open: { icon: GitPullRequest, className: "text-success", label: "Open" },
  merged: { icon: GitMerge, className: "text-info", label: "Merged" },
  closed: { icon: GitPullRequestClosed, className: "text-error", label: "Closed" },
};

interface Presentation {
  Icon: typeof GitPullRequest;
  toneClassName: string;
  /** "Open pull request #12: Add discounts" */
  label: string;
}

function present(pr: BranchPullRequest): Presentation {
  const state = pr.isDraft && pr.state === "open" ? null : PR_STATE[pr.state];
  return {
    Icon: state?.icon ?? GitPullRequestDraft,
    toneClassName: state?.className ?? "text-muted-foreground",
    label: `${state?.label ?? "Draft"} pull request #${pr.number}: ${pr.title}`,
  };
}

/** The session's pull requests. One per branch for now; a list so the badge
 *  can show "+N" the day a session links several. */
export function useSessionPullRequests(
  cwd: string,
  branch: string | null,
  enabled: boolean,
): BranchPullRequest[] {
  const pr = useBranchPullRequest(cwd, branch, enabled);
  return pr ? [pr] : [];
}

/** The row's badge: the pull request's number in its state's colour, or "+N"
 *  when the session has several. Opens the (first) pull request. */
export function SessionPullRequestBadge({
  cwd,
  branch,
  enabled,
}: {
  cwd: string;
  branch: string | null;
  /** Off until the row has been on screen, so a long list asks `gh` only for
   *  what was seen. */
  enabled: boolean;
}) {
  const prs = useSessionPullRequests(cwd, branch, enabled);
  const first = prs[0];
  if (!first) return null;
  const presentation = present(first);
  const text = prs.length > 1 ? `+${prs.length}` : first.number;
  const label =
    prs.length > 1 ? `${presentation.label}, and ${prs.length - 1} more` : presentation.label;
  return (
    <button
      type="button"
      aria-label={`${label} — open on GitHub`}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event: MouseEvent) => {
        event.preventDefault();
        event.stopPropagation();
        openPullRequest(first.url);
      }}
      className={cn(
        "inline-flex shrink-0 cursor-pointer items-center gap-0.5 rounded-sm text-xs tabular-nums hover:underline",
        presentation.toneClassName,
      )}
    >
      <presentation.Icon aria-hidden className="size-3 shrink-0" />
      <span>{text}</span>
    </button>
  );
}

/** The hover card's pull-request lines. */
export function SessionPullRequestLines({ cwd, branch }: { cwd: string; branch: string | null }) {
  const prs = useSessionPullRequests(cwd, branch, true);
  if (prs.length === 0) return null;
  return (
    <>
      {prs.map((pr) => {
        const presentation = present(pr);
        return (
          <div key={pr.number} className="flex min-w-0 items-center gap-2">
            <presentation.Icon
              aria-hidden
              className={cn("size-3 shrink-0", presentation.toneClassName)}
            />
            <div className="min-w-0 truncate text-secondary-foreground">
              #{pr.number} {pr.title}
            </div>
          </div>
        );
      })}
    </>
  );
}
