// Branch, pull requests, the one git action worth a click, and what changed —
// the Version Control group.
//
// Reads the git store, which mirrors the ACTIVE project's repository. The
// section renders only when that repository is this session's project, so a
// background project's chat never shows another repo's branch.

import { useEffect, useState } from "react";
import {
  CircleCheck,
  CircleDashed,
  CircleX,
  CloudDownload,
  CloudUpload,
  FileDiff,
  GitCommitHorizontal,
  GitMerge,
  GitPullRequest,
  GitPullRequestArrow,
  GitPullRequestClosed,
  GitPullRequestDraft,
  Plus,
  RefreshCw,
  type LucideIcon,
} from "lucide-react";

import { openSessionChanges } from "@/features/git/lib/open-session-changes";
import { openPullRequest } from "@/features/git/lib/git-pr-api";
import { useGitStore } from "@/features/git/stores/git-store";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import type { PrChecksState, PrListEntry } from "@/features/pull-requests/lib/pull-requests-types";
import { DropdownMenuItem, DropdownMenuSeparator } from "@/ui/dropdown-menu";

import { startCreatePr, useCreatePrDraft } from "../lib/create-pr";
import {
  fetchRemotes,
  publishBranch,
  pullBranch,
  pushBranch,
  revealSourceControl,
} from "../lib/git-actions";
import { resolveQuickAction, type QuickAction } from "../lib/quick-action";
import { useSessionPullRequests, type SessionPullRequests } from "../lib/session-pull-requests";
import { useSessionChanges } from "../lib/use-session-changes";
import { BranchPicker } from "./branch-picker";
import {
  ContextRow,
  ContextSection,
  ContextSplitRow,
  RowIcon,
  RowLabel,
  RowMeta,
} from "./context-rows";

export function VersionControlSection({
  tabId,
  projectPath,
}: {
  tabId: string | null;
  projectPath: string;
}) {
  const repoPath = useGitStore.use.repoPath();
  const isRepo = useGitStore.use.isRepo();
  const ours = repoPath === projectPath && isRepo;

  // Fresh numbers on open: the store is patched by the watcher, but ahead /
  // behind against the upstream only move on a snapshot.
  useEffect(() => {
    if (ours) void useGitStore.getState().actions.refresh(projectPath);
  }, [ours, projectPath]);

  if (!ours) return null;
  return <VersionControlRows tabId={tabId} projectPath={projectPath} />;
}

function VersionControlRows({ tabId, projectPath }: { tabId: string | null; projectPath: string }) {
  const branch = useGitStore.use.branch();
  const prs = useSessionPullRequests(projectPath, branch || null);
  return (
    <ContextSection title="Version control" showHeading={false}>
      <BranchPicker />
      <PullRequestRows prs={prs} />
      <QuickActionRow projectPath={projectPath} prs={prs} />
      <ChangesRow tabId={tabId} projectPath={projectPath} />
    </ContextSection>
  );
}

function prIcon(pr: PrListEntry): { icon: LucideIcon; className?: string } {
  if (pr.state === "merged") return { icon: GitMerge, className: "text-primary" };
  if (pr.state === "closed") return { icon: GitPullRequestClosed };
  if (pr.isDraft) return { icon: GitPullRequestDraft };
  return { icon: GitPullRequest, className: "text-success" };
}

const CHECKS: Record<PrChecksState, { icon: LucideIcon; className: string; label: string }> = {
  passing: { icon: CircleCheck, className: "text-success", label: "Checks passing" },
  failing: { icon: CircleX, className: "text-error", label: "Checks failing" },
  pending: { icon: CircleDashed, className: "text-warning", label: "Checks running" },
};

/**
 * The branch's pull requests (`useSessionPullRequests`): the one that matters
 * now, then the rest behind "Show N more". Each opens on the host.
 */
function PullRequestRows({ prs }: { prs: SessionPullRequests }) {
  const [expanded, setExpanded] = useState(false);
  if (!prs.current) return null;
  return (
    <>
      <PullRequestRow pr={prs.current} />
      {expanded && prs.rest.map((pr) => <PullRequestRow key={pr.number} pr={pr} />)}
      {!expanded && prs.rest.length > 0 && (
        <ContextRow onClick={() => setExpanded(true)} className="text-muted-foreground">
          <Plus size={14} className="shrink-0" aria-hidden />
          <RowLabel>Show {prs.rest.length} more</RowLabel>
        </ContextRow>
      )}
    </>
  );
}

function PullRequestRow({ pr }: { pr: PrListEntry }) {
  const { icon, className } = prIcon(pr);
  const checks = pr.state === "open" && pr.checksState ? CHECKS[pr.checksState] : null;
  return (
    <ContextRow onClick={() => openPullRequest(pr.url)} title={`${pr.title} — ${pr.url}`}>
      <RowIcon icon={icon} className={className} />
      <RowLabel>{pr.title}</RowLabel>
      {checks && (
        <span title={checks.label} className="inline-flex shrink-0">
          <checks.icon size={12} className={checks.className} aria-label={checks.label} />
        </span>
      )}
      <RowMeta>#{pr.number}</RowMeta>
    </ContextRow>
  );
}

const QUICK_ICON: Record<QuickAction["kind"], LucideIcon> = {
  push: CloudUpload,
  publish: CloudUpload,
  pull: CloudDownload,
  "create-pr": GitPullRequestArrow,
  "open-changes": GitCommitHorizontal,
  hint: CloudUpload,
};

function runQuickAction(action: QuickAction, projectPath: string): void {
  switch (action.kind) {
    case "push":
      void pushBranch();
      return;
    case "publish":
      void publishBranch();
      return;
    case "pull":
      void pullBranch();
      return;
    case "create-pr":
      void startCreatePr(projectPath, false);
      return;
    case "open-changes":
      revealSourceControl();
      return;
    case "hint":
      return;
  }
}

function QuickActionRow({ projectPath, prs }: { projectPath: string; prs: SessionPullRequests }) {
  const isRepo = useGitStore.use.isRepo();
  const branch = useGitStore.use.branch();
  const branches = useGitStore.use.branchesFull();
  const changedFiles = useGitStore((s) => s.files.length);
  const ahead = useGitStore.use.ahead();
  const behind = useGitStore.use.behind();
  const busy = useGitStore((s) => !!s.activeOp?.running);
  const current = branches.find((b) => b.isCurrent && !b.isRemote);
  const draft = useCreatePrDraft(projectPath, branch || null).data;

  const action = resolveQuickAction({
    isRepo,
    branch,
    detached: !current,
    changedFiles,
    upstream: current?.upstream ?? null,
    ahead,
    behind,
    busy,
    // Until both reads answer, nothing offers a PR: a "Create PR" that turns
    // into "Push" a moment later is a button that moved under the pointer.
    hasOpenPr: prs.loading || prs.hasOpen,
    isDefaultBranch: draft ? draft.baseBranch === branch : true,
  });
  if (!action) return null;

  const hasUpstream = !!current?.upstream;
  const offersPr = action.kind === "create-pr";
  return (
    <ContextSplitRow
      onClick={() => runQuickAction(action, projectPath)}
      disabled={action.kind === "hint"}
      title={action.kind === "hint" ? action.hint : undefined}
      menuLabel="More git actions"
      menu={
        <>
          {offersPr && (
            <>
              <DropdownMenuItem onClick={() => void startCreatePr(projectPath, true)}>
                <GitPullRequestDraft />
                {hasUpstream && ahead === 0 ? "Create draft PR" : "Push & create draft PR"}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          )}
          <DropdownMenuItem onClick={() => void pullBranch()} disabled={!hasUpstream || busy}>
            <CloudDownload />
            Pull
            {behind > 0 && <span className="ml-auto tabular-nums">{behind}</span>}
          </DropdownMenuItem>
          {hasUpstream ? (
            <DropdownMenuItem onClick={() => void pushBranch()} disabled={busy || ahead === 0}>
              <CloudUpload />
              Push
              {ahead > 0 && <span className="ml-auto tabular-nums">{ahead}</span>}
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem onClick={() => void publishBranch()} disabled={busy || !current}>
              <CloudUpload />
              Publish branch
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onClick={() => void fetchRemotes()} disabled={busy}>
            <RefreshCw />
            Fetch
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={revealSourceControl}>
            <GitCommitHorizontal />
            Open Source Control
          </DropdownMenuItem>
        </>
      }
    >
      <RowIcon icon={QUICK_ICON[action.kind]} />
      <RowLabel>{action.label}</RowLabel>
      {action.kind === "push" && <RowMeta>{ahead} ↑</RowMeta>}
      {action.kind === "pull" && <RowMeta>{behind} ↓</RowMeta>}
    </ContextSplitRow>
  );
}

/**
 * The session's changes when this is a chat (what the agent did), else the
 * working tree's (what Source Control would commit). The first opens the
 * session's changes tab, the second Source Control.
 */
function ChangesRow({ tabId, projectPath }: { tabId: string | null; projectPath: string }) {
  const session = useSessionChanges(tabId, projectPath);
  const workingTree = useGitStore((s) => s.files.length);

  if (session.rows.length > 0 && session.sessionId) {
    const sessionId = session.sessionId;
    const first = session.rows[0].path;
    return (
      <ContextRow
        title="This session's changes"
        onClick={() =>
          openSessionChanges({
            projectPath,
            sessionId,
            file: first,
            title: tabId
              ? useLayoutStore.getState().tabs.find((t) => t.id === tabId)?.title
              : undefined,
          })
        }
      >
        <RowIcon icon={FileDiff} />
        <RowLabel>Changes</RowLabel>
        {session.added !== null && session.removed !== null ? (
          <RowMeta className="font-mono">
            <span className="text-success">+{session.added}</span>{" "}
            <span className="text-error">−{session.removed}</span>
          </RowMeta>
        ) : (
          <RowMeta>
            {session.rows.length} {session.rows.length === 1 ? "file" : "files"}
          </RowMeta>
        )}
      </ContextRow>
    );
  }

  if (workingTree === 0) return null;
  return (
    <ContextRow title="Uncommitted changes in the working tree" onClick={revealSourceControl}>
      <RowIcon icon={FileDiff} />
      <RowLabel>Changes</RowLabel>
      <RowMeta>
        {workingTree} {workingTree === 1 ? "file" : "files"}
      </RowMeta>
    </ContextRow>
  );
}
