// Branch, pull request, the one git action worth a click, and what changed —
// the Version Control group.
//
// Reads the git store, which mirrors the ACTIVE project's repository. The
// section renders only when that repository is this session's project, so a
// background project's chat never shows another repo's branch.

import { useEffect, useMemo } from "react";
import {
  Check,
  CloudDownload,
  CloudUpload,
  FileDiff,
  GitBranch,
  GitCommitHorizontal,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  RefreshCw,
  type LucideIcon,
} from "lucide-react";

import { openSessionChanges } from "@/features/git/lib/open-session-changes";
import {
  openPullRequest,
  useBranchPullRequest,
  type BranchPullRequest,
} from "@/features/git/lib/git-pr-api";
import { useGitStore } from "@/features/git/stores/git-store";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator } from "@/ui/dropdown-menu";

import {
  checkoutBranch,
  fetchRemotes,
  publishBranch,
  pullBranch,
  pushBranch,
  revealSourceControl,
} from "../lib/git-actions";
import { resolveQuickAction, type QuickAction } from "../lib/quick-action";
import { useSessionChanges } from "../lib/use-session-changes";
import {
  ContextRow,
  ContextSection,
  ContextSelectRow,
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
  return (
    <ContextSection title="Version control" showHeading={false}>
      <BranchRow />
      <PullRequestRow projectPath={projectPath} />
      <QuickActionRow />
      <ChangesRow tabId={tabId} projectPath={projectPath} />
    </ContextSection>
  );
}

function BranchRow() {
  const branch = useGitStore.use.branch();
  const branches = useGitStore.use.branchesFull();
  const local = useMemo(() => branches.filter((b) => !b.isRemote), [branches]);

  return (
    <ContextSelectRow
      menuLabel="Switch branch"
      menu={
        <>
          <DropdownMenuLabel>Branches</DropdownMenuLabel>
          {local.length === 0 ? (
            <DropdownMenuItem disabled>No local branches</DropdownMenuItem>
          ) : (
            local.map((b) => (
              <DropdownMenuItem
                key={b.name}
                onClick={b.isCurrent ? undefined : () => void checkoutBranch(b.name)}
              >
                {b.isCurrent ? <Check /> : <GitBranch />}
                <span className="min-w-0 flex-1 truncate">{b.name}</span>
              </DropdownMenuItem>
            ))
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={revealSourceControl}>
            <GitCommitHorizontal />
            Open Source Control
          </DropdownMenuItem>
        </>
      }
    >
      <RowIcon icon={GitBranch} />
      <RowLabel>{branch || "No branch"}</RowLabel>
    </ContextSelectRow>
  );
}

const PR_ICON: Record<BranchPullRequest["state"], LucideIcon> = {
  open: GitPullRequest,
  merged: GitMerge,
  closed: GitPullRequestClosed,
};

/** The branch's pull request, from `gh` (`git_repo_pull_requests`). T3 also
 *  shows the checks' state and every PR the thread has touched ("Show 4
 *  more"); Atlas's read carries one PR per branch and no checks. */
function PullRequestRow({ projectPath }: { projectPath: string }) {
  const branch = useGitStore.use.branch();
  const pr = useBranchPullRequest(projectPath, branch || null, true);
  if (!pr) return null;
  const Icon = pr.isDraft && pr.state === "open" ? GitPullRequestDraft : PR_ICON[pr.state];
  return (
    <ContextRow onClick={() => openPullRequest(pr.url)} title={`${pr.title} — ${pr.url}`}>
      <RowIcon
        icon={Icon}
        className={
          pr.state === "merged"
            ? "text-primary"
            : pr.state === "open" && !pr.isDraft
              ? "text-success"
              : undefined
        }
      />
      <RowLabel>{pr.title}</RowLabel>
      <RowMeta>#{pr.number}</RowMeta>
    </ContextRow>
  );
}

const QUICK_ICON: Record<QuickAction["kind"], LucideIcon> = {
  push: CloudUpload,
  publish: CloudUpload,
  pull: CloudDownload,
  "open-changes": GitCommitHorizontal,
  hint: CloudUpload,
};

function runQuickAction(action: QuickAction): void {
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
    case "open-changes":
      revealSourceControl();
      return;
    case "hint":
      return;
  }
}

function QuickActionRow() {
  const isRepo = useGitStore.use.isRepo();
  const branch = useGitStore.use.branch();
  const branches = useGitStore.use.branchesFull();
  const changedFiles = useGitStore((s) => s.files.length);
  const ahead = useGitStore.use.ahead();
  const behind = useGitStore.use.behind();
  const busy = useGitStore((s) => !!s.activeOp?.running);
  const current = branches.find((b) => b.isCurrent && !b.isRemote);

  const action = resolveQuickAction({
    isRepo,
    branch,
    detached: !current,
    changedFiles,
    upstream: current?.upstream ?? null,
    ahead,
    behind,
    busy,
  });
  if (!action) return null;

  const hasUpstream = !!current?.upstream;
  return (
    <ContextSplitRow
      onClick={() => runQuickAction(action)}
      disabled={action.kind === "hint"}
      title={action.kind === "hint" ? action.hint : undefined}
      menuLabel="More git actions"
      menu={
        <>
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
