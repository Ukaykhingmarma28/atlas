// One pull request as a surface tab (`pull-request:<checkout>:<number>`):
// the header — crumbs, the primary action and ⋯ menu, the title and branch
// rows that fold into one line once scrolled — the Summary / Timeline / Code
// tabs, and the floating composer.
//
// Everything reads through the `pr_*` commands in the tab's checkout, so the
// tab works for any pull request `gh` can see from there. What may be done
// is asked of the detail's capabilities and permissions, never assumed.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { cn } from "@/lib/utils";
import { Segmented } from "@/ui/segmented";

import { pullRequestTabTitle } from "../lib/open-pull-request-tab";
import { classifyPrError } from "../lib/pr-errors";
import {
  allowedMergeMethods as allowedMethodsOf,
  canDeleteBranch,
  canPerform,
  checksStateOf,
  MERGE_METHOD_LABELS,
  resolveBaseFreshness,
  resolveMergeMethod,
  resolvePrimaryControl,
} from "../lib/pull-request-logic";
import { repositoryUrlOf } from "../lib/pull-request-markdown";
import { lastMergeMethod, rememberMergeMethod } from "../lib/pull-request-prefs";
import { pullRequestKeys, usePrActivity, usePrDetail } from "../lib/pull-requests-queries";
import type { PrAction, PrMergeMethod } from "../lib/pull-requests-types";
import { usePullRequestActions } from "../lib/use-pull-request-actions";
import { usePullRequestAgentActions } from "../lib/use-pull-request-agent-actions";
import { watchPullRequestTabDrafts } from "../lib/pull-request-tab-drafts";
import {
  patchPullRequestTabDraft,
  readPullRequestTabDraft,
} from "../stores/pull-request-tab-draft-store";
import {
  PullRequestActionsMenu,
  PullRequestChecksStatus,
  PullRequestPrimaryAction,
} from "./pull-request-actions";
import { PullRequestComposer } from "./pull-request-composer";
import { PullRequestScopeContext, type PullRequestScope } from "./pull-request-context";
import {
  PullRequestCondensedRow,
  PullRequestCrumbs,
  PullRequestHeaderBody,
} from "./pull-request-header";
import { resolveStatePresentation } from "./pull-request-presentation";
import { PullRequestDetailGhost, PullRequestUnavailableState } from "./pull-request-states";
import { PullRequestGuideTab } from "./pull-request-guide-tab";
import { PullRequestSummaryTab } from "./pull-request-summary-tab";
import { PullRequestCodeTab } from "./pull-request-code-tab";
import { PullRequestTimelineTab } from "./pull-request-timeline-tab";

type InnerTab = "summary" | "guide" | "timeline" | "code";

const INNER_TABS = [
  { value: "summary", label: "Summary" },
  { value: "guide", label: "Guide" },
  { value: "timeline", label: "Timeline" },
  { value: "code", label: "Code" },
] as const;

/** Scrolled this far past the fold, the header condenses; back near the top it opens. */
const CONDENSE_SLACK_PX = 32;
const EXPAND_AT_PX = 4;

export function PullRequestPanel({
  tabId,
  repoPath,
  number,
}: {
  tabId: string;
  repoPath: string;
  number: number;
}) {
  const client = useQueryClient();
  const detailQuery = usePrDetail(repoPath, number);
  const activityQuery = usePrActivity(repoPath, number);
  const detail = detailQuery.data ?? null;
  const activity = activityQuery.data ?? null;
  const { pendingAction, perform, commentThen } = usePullRequestActions(repoPath, number);
  const agent = usePullRequestAgentActions({ repoPath, number, detail, activity });
  const scopeKey = `${repoPath}:${number}`;

  // The tab strip names the pull request once its title is known.
  const setTabTitle = useLayoutStore.use.actions().setTabTitle;
  useEffect(() => {
    if (detail) setTabTitle(tabId, pullRequestTabTitle(number, detail.title));
  }, [detail?.title, number, tabId, setTabTitle, detail]);

  const [tab, setTab] = useState<InnerTab>("summary");
  // The Code tab's commit: `null` for all of them. Set from outside by the
  // Timeline's "view this commit". Kept per tab, so a tab switch keeps it.
  useEffect(() => watchPullRequestTabDrafts(), []);
  const [codeCommit, setCodeCommitState] = useState<string | null>(
    () => readPullRequestTabDraft(tabId).commit ?? null,
  );
  const setCodeCommit = useCallback(
    (oid: string | null) => {
      setCodeCommitState(oid);
      patchPullRequestTabDraft(tabId, { commit: oid });
    },
    [tabId],
  );

  // ── the fold ──────────────────────────────────────────────────────────
  const [condensed, setCondensed] = useState(false);
  const viewCommit = (oid: string) => {
    setCodeCommit(oid);
    setTab("code");
    setCondensed(false);
  };
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const foldRef = useRef<HTMLDivElement | null>(null);
  const condensedRowRef = useRef<HTMLDivElement | null>(null);
  // Saved before the fold collapses: the browser may clamp scrollTop as the
  // viewport grows, so applying a delta afterwards would compensate twice.
  const compensation = useRef<{ scroller: HTMLDivElement; target: number } | null>(null);
  useLayoutEffect(() => {
    const pending = compensation.current;
    compensation.current = null;
    if (!pending || !condensed || scrollerRef.current !== pending.scroller) return;
    pending.scroller.scrollTop = Math.max(0, pending.target);
  }, [condensed]);
  const [setScroller] = useState(() => (node: HTMLDivElement | null) => {
    scrollerRef.current = node;
  });
  const onScrollCapture = (event: React.UIEvent) => {
    const scroller = scrollerRef.current;
    if (!scroller || event.target !== scroller) return;
    const top = scroller.scrollTop;
    const foldHeight = foldRef.current?.scrollHeight ?? 0;
    if (condensed) {
      if (top < EXPAND_AT_PX && foldHeight > 0) setCondensed(false);
    } else if (foldHeight > 0 && top > foldHeight + CONDENSE_SLACK_PX) {
      const chromeDelta = foldHeight - (condensedRowRef.current?.scrollHeight ?? 0);
      compensation.current = { scroller, target: top - chromeDelta };
      setCondensed(true);
    }
  };

  // ── merge method ──────────────────────────────────────────────────────
  const [picked, setPicked] = useState<PrMergeMethod | null>(null);
  // An armed auto-merge names the method it will use; follow it.
  const armedMethod = detail?.autoMergeMethod ?? null;
  const [seenArmed, setSeenArmed] = useState<PrMergeMethod | null>(null);
  if (armedMethod !== seenArmed) {
    setSeenArmed(armedMethod);
    if (armedMethod) setPicked(armedMethod);
  }
  const allowedMethods = allowedMethodsOf(detail);
  const mergeMethod = resolveMergeMethod(allowedMethods, picked, lastMergeMethod());
  const selectMergeMethod = (method: PrMergeMethod) => {
    setPicked(method);
    rememberMergeMethod(method);
  };

  const refresh = () => {
    void client.invalidateQueries({ queryKey: pullRequestKeys.pull(repoPath, number) });
  };
  const refreshing = detailQuery.isFetching || activityQuery.isFetching;

  // One scope object while what it names holds still: every markdown block
  // and review card below reads it, so a new one each render would re-render
  // them all. `fixFinding` is a new closure each render; the scope holds a
  // stable stand-in that calls the latest.
  const repositoryUrl = detail ? repositoryUrlOf(detail.url) : null;
  const fixFindingRef = useRef(agent.fixFinding);
  fixFindingRef.current = agent.fixFinding;
  const canFix = agent.fixFinding !== null;
  const scope = useMemo<PullRequestScope>(
    () => ({
      repoPath,
      number,
      repositoryUrl,
      agent: {
        fixFinding: canFix ? (finding) => fixFindingRef.current?.(finding) : null,
        pending: agent.pending,
      },
    }),
    [repoPath, number, repositoryUrl, canFix, agent.pending],
  );

  if (!detail) {
    if (detailQuery.error) {
      return (
        <PullRequestUnavailableState
          error={classifyPrError(detailQuery.error)}
          number={number}
          url={null}
          retrying={detailQuery.isFetching}
          onRetry={() => void detailQuery.refetch()}
        />
      );
    }
    return <PullRequestDetailGhost number={number} />;
  }

  const can = (action: PrAction) => canPerform(detail, action);
  const checksState = detail.checksState ?? checksStateOf(detail.checks);
  const statePresentation = resolveStatePresentation(detail);
  const conflicting = detail.state === "open" && detail.mergeability === "conflicting";
  const autoMergeArmed = detail.state === "open" && detail.autoMergeEnabled === true;
  const armedAutoMergeLabel = detail.autoMergeMethod
    ? `Auto-merge (${MERGE_METHOD_LABELS[detail.autoMergeMethod].toLowerCase()})`
    : "Auto-merge";
  const primary = resolvePrimaryControl({
    state: detail.state,
    isDraft: detail.isDraft,
    mergeability: detail.mergeability,
    checksState,
    autoMergeEnabled: detail.autoMergeEnabled,
    hasMergeMethod: allowedMethods.length > 0,
    canMerge: can("merge"),
    canMarkReady: can("ready"),
    canEnableAutoMerge: can("enable-auto-merge"),
  });
  const mergeable = detail.state === "open" && !detail.isDraft && !conflicting;
  const showsDraftToggle =
    detail.state === "open" &&
    can(detail.isDraft ? "ready" : "draft") &&
    !(detail.isDraft && primary === "ready");
  const showsAutoMerge =
    mergeable &&
    !autoMergeArmed &&
    primary !== "enable-auto-merge" &&
    can("enable-auto-merge") &&
    allowedMethods.length > 0;
  const showsMergeNow =
    mergeable &&
    (primary === "enable-auto-merge" || primary === "auto-merge-armed") &&
    can("merge") &&
    allowedMethods.length > 0;
  const showsMergeMethods = mergeable && can("merge") && allowedMethods.length > 1;
  const freshness = resolveBaseFreshness(detail);
  const onUpdate = (method: "merge" | "rebase") => void perform("update-branch", undefined, method);
  const activityPending = activityQuery.isPending;
  const activityError = activity
    ? null
    : activityQuery.error
      ? classifyPrError(activityQuery.error)
      : null;

  return (
    <PullRequestScopeContext.Provider value={scope}>
      <div className="relative flex h-full min-h-0 w-full flex-col bg-background">
        <div className="grid min-w-0 shrink-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-x-2 border-b border-border">
          <PullRequestCrumbs
            detail={detail}
            toneClassName={statePresentation.toneClassName}
            condensed={condensed}
            repositoryUrl={scope.repositoryUrl}
          />
          <div className="mr-3 flex h-7 shrink-0 items-center justify-end gap-1">
            <PullRequestPrimaryAction
              scopeKey={scopeKey}
              primary={primary}
              autoMergeArmed={autoMergeArmed}
              armedAutoMergeLabel={armedAutoMergeLabel}
              mergeMethod={mergeMethod}
              statePresentation={statePresentation}
              pendingAction={pendingAction}
              perform={perform}
            />
            <PullRequestActionsMenu
              scopeKey={scopeKey}
              detail={detail}
              refreshing={refreshing}
              onRefresh={refresh}
              can={can}
              autoMergeArmed={autoMergeArmed}
              showsDraftToggle={showsDraftToggle}
              showsMergeNow={showsMergeNow}
              showsAutoMerge={showsAutoMerge}
              showsMergeMethods={showsMergeMethods}
              allowedMergeMethods={allowedMethods}
              mergeMethod={mergeMethod}
              onSelectMergeMethod={selectMergeMethod}
              showsDeleteBranch={canDeleteBranch(detail)}
              pendingAction={pendingAction}
              perform={perform}
              agent={agent}
              onWriteGuide={() => {
                agent.guide.write();
                setTab("guide");
              }}
            />
          </div>

          <div
            className={cn(
              "col-span-2 grid",
              condensed
                ? "grid-rows-[1fr]"
                : "grid-rows-[0fr] transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none",
            )}
          >
            <div
              ref={condensedRowRef}
              inert={!condensed}
              className={cn(
                "min-h-0 overflow-hidden transition-[opacity,transform] duration-150 ease-out motion-reduce:transform-none motion-reduce:transition-none",
                condensed
                  ? "translate-y-0 opacity-100 delay-50"
                  : "translate-y-1 opacity-0 duration-100",
              )}
            >
              <PullRequestCondensedRow
                detail={detail}
                freshness={freshness}
                pending={pendingAction !== null}
                onUpdate={onUpdate}
              />
            </div>
          </div>

          <div
            className={cn(
              "col-span-2 grid",
              condensed
                ? "grid-rows-[0fr]"
                : "grid-rows-[1fr] transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none",
            )}
          >
            <div
              ref={foldRef}
              inert={condensed}
              className={cn(
                "min-h-0 overflow-hidden transition-[opacity,transform] duration-150 ease-out motion-reduce:transform-none motion-reduce:transition-none",
                condensed
                  ? "-translate-y-1 opacity-0 duration-100"
                  : "translate-y-0 opacity-100 delay-50",
              )}
            >
              <PullRequestHeaderBody
                repoPath={repoPath}
                detail={detail}
                freshness={freshness}
                pending={pendingAction !== null}
                onUpdate={onUpdate}
              />
            </div>
          </div>

          <nav
            aria-label="Pull request tabs"
            className="col-span-2 flex min-w-0 items-center gap-2 border-t border-border px-4 py-2"
          >
            <Segmented
              aria-label="Pull request view"
              size="sm"
              value={tab}
              onValueChange={(next) => {
                setTab(next);
                setCondensed(false);
              }}
              options={INNER_TABS.filter((t) => t.value !== "code" || detail.capabilities.diff)}
            />
            {tab === "summary" ? (
              <PullRequestChecksStatus
                checks={detail.checks}
                checksState={checksState}
                truncated={detail.checksTruncated}
                onFix={
                  agent.fixFinding ? (check) => agent.fixFinding?.({ kind: "check", check }) : null
                }
                fixing={agent.pending !== null}
              />
            ) : null}
          </nav>
        </div>

        <div className="relative min-h-0 flex-1 overflow-hidden" onScrollCapture={onScrollCapture}>
          {tab === "summary" ? (
            <PullRequestSummaryTab
              scrollerRef={setScroller}
              repoPath={repoPath}
              detail={detail}
              activity={activity}
              activityPending={activityPending}
              activityError={activityError}
              onRetryActivity={() => void activityQuery.refetch()}
              agent={agent}
            />
          ) : tab === "guide" ? (
            <PullRequestGuideTab
              scrollerRef={setScroller}
              repoPath={repoPath}
              number={number}
              agent={agent}
              active
            />
          ) : tab === "timeline" ? (
            <PullRequestTimelineTab
              scrollerRef={setScroller}
              repoPath={repoPath}
              detail={detail}
              activity={activity}
              onViewCommit={detail.capabilities.diff ? viewCommit : undefined}
            />
          ) : (
            <PullRequestCodeTab
              tabId={tabId}
              scrollerRef={setScroller}
              repoPath={repoPath}
              detail={detail}
              activity={activity}
              commit={codeCommit}
              onCommitChange={setCodeCommit}
            />
          )}
        </div>

        <div className="absolute right-4 bottom-3 z-20">
          <PullRequestComposer
            tabId={tabId}
            repoPath={repoPath}
            detail={detail}
            pendingAction={pendingAction}
            onCommentAction={commentThen}
          />
        </div>
      </div>
    </PullRequestScopeContext.Provider>
  );
}

export default PullRequestPanel;
