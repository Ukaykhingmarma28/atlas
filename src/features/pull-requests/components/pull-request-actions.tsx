// The header's controls: the one prominent action (Merge, Ready for review,
// auto-merge, or the state once it is done), the ⋯ menu with everything
// else, and the checks popover in the tab bar. A merge, auto-merge, close or
// branch delete needs a second press on the same control.

import { useState } from "react";
import { toast } from "sonner";
import {
  ArrowUpRight,
  Check,
  Copy,
  GitMerge,
  GitPullRequestArrow,
  GitPullRequestClosed,
  GitPullRequestDraft,
  Link,
  MoreHorizontal,
  RefreshCw,
  RotateCcw,
  Trash2,
} from "lucide-react";

import { openPullRequest } from "@/features/git/lib/git-pr-api";
import { copyText } from "@/lib/clipboard";
import { cn } from "@/lib/utils";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { IconButton } from "@/ui/icon-button";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";

import {
  checkStatusLabel,
  CHECKS_STATE_LABELS,
  groupChecks,
  MERGE_METHOD_LABELS,
  summarizeChecks,
  type PrimaryControl,
} from "../lib/pull-request-logic";
import type {
  PrAction,
  PrCheck,
  PrChecksState,
  PrDetail,
  PrMergeMethod,
} from "../lib/pull-requests-types";
import { useInlineConfirm } from "../lib/use-inline-confirm";
import type { PerformPullRequestAction } from "../lib/use-pull-request-actions";
import { StatePill } from "./pull-request-header";
import {
  CheckStatusIcon,
  CHECKS_STATE_PRESENTATION,
  type StatePresentation,
} from "./pull-request-presentation";
import { ChecksButton } from "./pull-request-triggers";

async function copyWithToast(value: string, label: string) {
  if (await copyText(value)) toast.success(`${label} copied`);
  else toast.error(`Could not copy the ${label.toLowerCase()}`);
}

// ── the primary control ─────────────────────────────────────────────────

function ArmedAutoMerge({ label }: { label: string }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex shrink-0" />}>
        <Badge variant="info">
          <GitMerge aria-hidden className="size-3.5" />
          {label}
        </Badge>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {label}: GitHub merges this on its own once its requirements are met
      </TooltipContent>
    </Tooltip>
  );
}

/** A label that keeps the width of its longest wording, so the confirming
 *  press lands on the same button. */
function SteadyLabel({ widest, shown }: { widest: readonly string[]; shown: string }) {
  return (
    <span className="inline-grid">
      {widest.map((text) => (
        <span key={text} aria-hidden className="invisible col-start-1 row-start-1">
          {text}
        </span>
      ))}
      <span className="col-start-1 row-start-1">{shown}</span>
    </span>
  );
}

export function PullRequestPrimaryAction({
  scopeKey,
  primary,
  autoMergeArmed,
  armedAutoMergeLabel,
  mergeMethod,
  statePresentation,
  pendingAction,
  perform,
}: {
  scopeKey: string;
  primary: PrimaryControl;
  autoMergeArmed: boolean;
  armedAutoMergeLabel: string;
  mergeMethod: PrMergeMethod;
  statePresentation: StatePresentation;
  pendingAction: PrAction | null;
  perform: PerformPullRequestAction;
}) {
  const confirm = useInlineConfirm(scopeKey);
  const busy = pendingAction !== null;
  const mergeLabel = MERGE_METHOD_LABELS[mergeMethod];
  const autoMergeLabel = `Auto-merge (${mergeLabel.toLowerCase()})`;

  if (primary === "resolve") {
    return (
      <Tooltip>
        <TooltipTrigger render={<span className="inline-flex shrink-0" />}>
          <Badge variant="destructive">
            <GitPullRequestClosed aria-hidden className="size-3.5" />
            Conflicts
          </Badge>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          This branch conflicts with its base; resolve them in a checkout and push.
        </TooltipContent>
      </Tooltip>
    );
  }
  if (primary === "ready") {
    return (
      <Button size="xs" disabled={busy} onClick={() => void perform("ready")}>
        <GitPullRequestArrow aria-hidden className="size-3.5" />
        {pendingAction === "ready" ? "Marking ready…" : "Ready for review"}
      </Button>
    );
  }
  if (primary === "enable-auto-merge" || primary === "merge") {
    const action = primary;
    const armed = confirm.isArmed(action);
    const idle = action === "merge" ? mergeLabel : autoMergeLabel;
    const confirmText = action === "merge" ? "Confirm merge?" : "Confirm auto-merge?";
    const pendingText = action === "merge" ? "Merging…" : "Turning on…";
    const shown = pendingAction === action ? pendingText : armed ? confirmText : idle;
    return (
      <>
        {autoMergeArmed ? <ArmedAutoMerge label={armedAutoMergeLabel} /> : null}
        <Button
          size="xs"
          disabled={busy}
          aria-label={shown}
          {...confirm.props(action, () => void perform(action, mergeMethod))}
        >
          {armed ? (
            <Check aria-hidden className="size-3.5" />
          ) : (
            <GitMerge aria-hidden className="size-3.5" />
          )}
          <SteadyLabel widest={[idle, confirmText]} shown={shown} />
        </Button>
      </>
    );
  }
  if (primary === "auto-merge-armed") return <ArmedAutoMerge label={armedAutoMergeLabel} />;
  if (primary === "merged" || primary === "closed") {
    return <StatePill presentation={statePresentation} />;
  }
  return autoMergeArmed ? <ArmedAutoMerge label={armedAutoMergeLabel} /> : null;
}

// ── the ⋯ menu ──────────────────────────────────────────────────────────

export function PullRequestActionsMenu({
  scopeKey,
  detail,
  refreshing,
  onRefresh,
  can,
  autoMergeArmed,
  showsDraftToggle,
  showsMergeNow,
  showsAutoMerge,
  showsMergeMethods,
  allowedMergeMethods,
  mergeMethod,
  onSelectMergeMethod,
  showsDeleteBranch,
  pendingAction,
  perform,
}: {
  scopeKey: string;
  detail: Pick<PrDetail, "url" | "number" | "state" | "isDraft" | "headBranch">;
  refreshing: boolean;
  onRefresh: () => void;
  can: (action: PrAction) => boolean;
  autoMergeArmed: boolean;
  showsDraftToggle: boolean;
  showsMergeNow: boolean;
  showsAutoMerge: boolean;
  showsMergeMethods: boolean;
  allowedMergeMethods: readonly PrMergeMethod[];
  mergeMethod: PrMergeMethod;
  onSelectMergeMethod: (method: PrMergeMethod) => void;
  showsDeleteBranch: boolean;
  pendingAction: PrAction | null;
  perform: PerformPullRequestAction;
}) {
  const confirm = useInlineConfirm(`${scopeKey}:menu`);
  const busy = pendingAction !== null;
  const stateGroup =
    detail.state === "open" &&
    (showsDraftToggle || showsMergeNow || showsAutoMerge || autoMergeArmed || showsMergeMethods);

  /** A menu item that needs a second press: the first arms it and keeps the
   *  menu open, the second runs it and closes. */
  const confirmed = (action: string, run: () => void) => ({
    closeOnClick: confirm.isArmed(action),
    ...confirm.props(action, run),
  });

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger
          render={
            <DropdownMenuTrigger
              render={
                <IconButton
                  icon={refreshing ? RefreshCw : MoreHorizontal}
                  label={refreshing ? "Refreshing pull request" : "More pull request actions"}
                  size="sm"
                />
              }
            />
          }
        />
        <TooltipContent side="bottom">More pull request actions</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" side="bottom" className="min-w-52">
        <DropdownMenuItem disabled={refreshing} onClick={onRefresh}>
          <RefreshCw className={cn(refreshing && "animate-spin")} />
          Refresh
        </DropdownMenuItem>
        {stateGroup ? <DropdownMenuSeparator /> : null}
        {detail.state === "open" ? (
          <>
            {showsDraftToggle ? (
              <DropdownMenuItem
                disabled={busy}
                onClick={() => void perform(detail.isDraft ? "ready" : "draft")}
              >
                {detail.isDraft ? <GitPullRequestArrow /> : <GitPullRequestDraft />}
                {detail.isDraft ? "Ready for review" : "Convert to draft"}
              </DropdownMenuItem>
            ) : null}
            {showsMergeNow ? (
              <DropdownMenuItem
                disabled={busy}
                {...confirmed("merge", () => void perform("merge", mergeMethod))}
              >
                {confirm.isArmed("merge") ? <Check /> : <GitMerge />}
                {confirm.isArmed("merge") ? "Confirm merge?" : "Merge now"}
              </DropdownMenuItem>
            ) : null}
            {autoMergeArmed && can("disable-auto-merge") ? (
              <DropdownMenuItem disabled={busy} onClick={() => void perform("disable-auto-merge")}>
                <GitMerge />
                Turn off auto-merge
              </DropdownMenuItem>
            ) : showsAutoMerge ? (
              <DropdownMenuItem
                disabled={busy}
                {...confirmed(
                  "enable-auto-merge",
                  () => void perform("enable-auto-merge", mergeMethod),
                )}
              >
                {confirm.isArmed("enable-auto-merge") ? <Check /> : <GitMerge />}
                {confirm.isArmed("enable-auto-merge")
                  ? "Confirm auto-merge?"
                  : "Turn on auto-merge"}
              </DropdownMenuItem>
            ) : null}
            {showsMergeMethods ? (
              <>
                {showsDraftToggle || showsMergeNow || showsAutoMerge || autoMergeArmed ? (
                  <DropdownMenuSeparator />
                ) : null}
                <DropdownMenuRadioGroup
                  value={mergeMethod}
                  onValueChange={(method) => onSelectMergeMethod(method as PrMergeMethod)}
                >
                  {allowedMergeMethods.map((method) => (
                    <DropdownMenuRadioItem key={method} value={method} disabled={busy}>
                      {MERGE_METHOD_LABELS[method]}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </>
            ) : null}
          </>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => openPullRequest(detail.url)}>
          <ArrowUpRight />
          Open on GitHub
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => void copyWithToast(detail.url, "Link")}>
          <Link />
          Copy link
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => void copyWithToast(`#${detail.number}`, "Number")}>
          <Copy />
          Copy PR number
        </DropdownMenuItem>
        {detail.state === "open" && can("close") ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              disabled={busy}
              {...confirmed("close", () => void perform("close"))}
            >
              <GitPullRequestClosed />
              {confirm.isArmed("close") ? "Confirm close?" : "Close pull request"}
            </DropdownMenuItem>
          </>
        ) : detail.state === "closed" && can("reopen") ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled={busy} onClick={() => void perform("reopen")}>
              <RotateCcw />
              Reopen pull request
            </DropdownMenuItem>
          </>
        ) : null}
        {showsDeleteBranch ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              disabled={busy}
              {...confirmed("delete-branch", () => void perform("delete-branch"))}
            >
              <Trash2 className="mt-0.5 self-start" />
              <span className="flex min-w-0 flex-col">
                <span>
                  {pendingAction === "delete-branch"
                    ? "Deleting branch…"
                    : confirm.isArmed("delete-branch")
                      ? "Confirm delete?"
                      : "Delete branch"}
                </span>
                <span className="truncate font-mono text-2xs text-muted-foreground">
                  {detail.headBranch}
                </span>
              </span>
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ── checks ──────────────────────────────────────────────────────────────

function ChecksList({ checks }: { checks: readonly PrCheck[] }) {
  const [showAll, setShowAll] = useState(false);
  const { attention, running, completed } = groupChecks(checks);
  const canCollapse = attention.length + running.length > 0 && completed.length > 0;
  const visible = [...attention, ...running, ...(showAll || !canCollapse ? completed : [])];
  if (checks.length === 0) {
    return <p className="text-xs text-muted-foreground">No checks reported.</p>;
  }
  return (
    <>
      <ul className="-me-1 max-h-64 space-y-1 overflow-y-auto pe-1">
        {visible.map((check, index) => (
          <li
            key={`${index}:${check.name}`}
            className="grid grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-2 text-xs"
          >
            <CheckStatusIcon status={check.status} />
            <span className="min-w-0 truncate" title={check.description ?? check.name}>
              {check.name}
            </span>
            <span className="whitespace-nowrap text-muted-foreground">
              {checkStatusLabel(check)}
            </span>
            {check.url ? (
              <button
                type="button"
                className="text-primary hover:underline"
                onClick={() => openPullRequest(check.url!)}
              >
                Details
              </button>
            ) : (
              <span />
            )}
          </li>
        ))}
      </ul>
      {canCollapse ? (
        <Button
          variant="ghost"
          size="xs"
          aria-expanded={showAll}
          onClick={() => setShowAll(!showAll)}
        >
          {showAll ? "Show less" : `Show all ${checks.length}`}
        </Button>
      ) : null}
    </>
  );
}

/** The tab bar's checks line: the rollup's glyph opens the list. */
export function PullRequestChecksStatus({
  checks,
  checksState,
  truncated,
}: {
  checks: readonly PrCheck[];
  checksState: PrChecksState | null;
  truncated: boolean;
}) {
  const summary = summarizeChecks(checks);
  if (checksState === null) {
    return <span className="ml-auto truncate text-xs text-muted-foreground">{summary}</span>;
  }
  const presentation = CHECKS_STATE_PRESENTATION[checksState];
  return (
    <Popover>
      <PopoverTrigger render={<ChecksButton aria-label={`Checks: ${summary}`} />}>
        <presentation.Icon
          aria-hidden
          className={cn("size-3.5 shrink-0", presentation.toneClassName)}
        />
        <span className="truncate">{summary}</span>
      </PopoverTrigger>
      <PopoverContent align="end" side="bottom" className="w-96">
        <p className="mb-1 text-sm font-medium">{CHECKS_STATE_LABELS[checksState]}</p>
        <p className="mb-2 text-xs text-muted-foreground">
          {summary}
          {truncated ? " · more checks ran than GitHub lists here" : ""}
        </p>
        <ChecksList checks={checks} />
      </PopoverContent>
    </Popover>
  );
}
