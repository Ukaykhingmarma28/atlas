// The agent actions a pull request offers, each handing work to a session on
// the user's default agent (named on every action):
//
// - "Explain this PR" — a new session in the project, or the session beside
//   the tab when it is in the same project, with the explanation task and the
//   pull request's description and changed files in its composer. Nothing is
//   checked out: the task says to read the diff with `gh pr diff`.
// - "Fix" on a failing check, a review thread or a remark, and "Fix findings"
//   for all of them — a new session on the pull request's head branch: where
//   that branch is already checked out, or in a worktree of its own
//   (`pr_prepare_checkout`). The main checkout is never switched. The task is
//   in the composer, not sent; once the session has done the work, the user
//   pushes it from the session context overlay. Nothing is pushed for them.
// - "Write guide" — the Guide tab's background run (`guide-run-store.ts`);
//   on a pull request from a fork, only after the reader confirms, since the
//   run's agent works in a checkout of the fork author's code.

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { actionAgent, currentSessionTab, openHandoffSession } from "./pr-agent-session";
import { findingKey, type Finding } from "./pull-request-logic";
import {
  buildAskAboutGuideStopHandoff,
  buildExplainHandoff,
  buildFixFindingHandoff,
  buildFixFindingsHandoff,
  hasFindings,
  type Handoff,
} from "./pull-request-handoff";
import { guideQueryKey, usePrGuide } from "./pull-request-guide-queries";
import type { GuideStop, PullRequestGuide } from "./pull-request-guide-types";
import { pullRequestKeys } from "./pull-requests-queries";
import { prDiff, prPrepareCheckout } from "./pull-requests-api";
import type { PrActivity, PrDetail, PrDiffFile, PrDiffResult } from "./pull-requests-types";
import {
  guideRunKey,
  useGuideRunStore,
  writeGuide,
  type GuideRun,
} from "../stores/guide-run-store";

export interface PullRequestGuideState {
  guide: PullRequestGuide | null;
  loading: boolean;
  run: GuideRun | null;
  running: boolean;
  /** The guide was written for an older head. */
  stale: boolean;
  /** Whether a guide can be written here (an open or closed pull request
   *  with a known head). */
  canWrite: boolean;
  /** Starts a run, or for a pull request from a fork asks first
   *  (`forkConfirm`). */
  write: () => void;
  /** Set while "Write guide" on a fork's pull request waits for the reader's
   *  yes: its checkout is the fork author's code. */
  forkConfirm: { confirm: () => void; cancel: () => void } | null;
}

export interface PullRequestAgentActions {
  /** The agent every action uses: the project's default. */
  agentLabel: string;
  /** `null` while agent actions are unavailable; the Summary hides "Fix". */
  fixFinding: ((finding: Finding) => void) | null;
  /** "Fix findings": `null` when there is nothing to fix. */
  fixFindings: (() => void) | null;
  explain: (where: "new" | "current") => void;
  /** A question about one guide stop, in a session (the current one when it
   *  is in the project, as "Explain"). */
  askAboutStop: (stop: GuideStop, index: number, question: string) => void;
  /** The session beside the tab can take "Explain" instead of a new one. */
  canExplainInCurrent: () => boolean;
  /** The action being handed off: a `findingKey`, "findings" or "explain". */
  pending: string | null;
  /** The Fix button's label. */
  fixLabel: string;
  guide: PullRequestGuideState;
}

function errorMessage(err: unknown): string {
  if (typeof err === "object" && err !== null && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}

export function usePullRequestAgentActions(target: {
  repoPath: string;
  number: number;
  detail: PrDetail | null;
  activity: PrActivity | null;
}): PullRequestAgentActions {
  const { repoPath, number, detail, activity } = target;
  const client = useQueryClient();
  const [pending, setPending] = useState<string | null>(null);
  // "Write guide" on a pull request from a fork waits for a yes first.
  const [confirmingFork, setConfirmingFork] = useState(false);
  const agent = actionAgent(repoPath);

  const guideQuery = usePrGuide(repoPath, detail?.repository ?? null, number);
  const run = useGuideRunStore((s) => s.runs[guideRunKey(repoPath, number)] ?? null);
  const guide = guideQuery.data ?? null;

  /** The first page of changed files, for the task's context. Best-effort. */
  const changedFiles = async (): Promise<PrDiffFile[]> => {
    try {
      const page = await client.fetchQuery<PrDiffResult>({
        queryKey: pullRequestKeys.diff(repoPath, number, null, null),
        queryFn: () => prDiff(repoPath, number, null, null),
        staleTime: 60_000,
      });
      return page.files;
    } catch {
      return [];
    }
  };

  const fixWith = async (kind: string, build: (files: PrDiffFile[]) => Handoff) => {
    if (!detail || pending !== null) return;
    setPending(kind);
    const toastId = toast.loading("Preparing the pull request checkout…");
    try {
      const [checkout, files] = await Promise.all([
        prPrepareCheckout(repoPath, detail),
        changedFiles(),
      ]);
      await openHandoffSession({
        projectPath: repoPath,
        cwd: checkout.cwd,
        agent: agent.agent,
        handoff: build(files),
      });
      const where = checkout.worktreePath
        ? `${checkout.reused ? "Its existing worktree" : "A new worktree"} on ${checkout.branch}`
        : `The project, already on ${checkout.branch}`;
      toast.success(
        checkout.isOnPullRequestHead ? "Checkout ready" : "Checked out, not at the latest push",
        {
          id: toastId,
          description: checkout.isOnPullRequestHead
            ? `${where}. The task is in the composer for ${agent.label}: read it over, then send.`
            : `${where} holds commits of its own or could not move to the pull request's head. Check it before sending the task.`,
        },
      );
    } catch (err) {
      toast.error("Couldn't prepare the pull request checkout", {
        id: toastId,
        description: errorMessage(err),
      });
    } finally {
      setPending(null);
    }
  };

  const canFix = detail?.state === "open";
  const fixFinding = canFix
    ? (finding: Finding) => {
        void fixWith(findingKey(finding), (files) =>
          buildFixFindingHandoff(detail, finding, files, detail.changedFiles),
        );
      }
    : null;

  const fixFindings =
    canFix && hasFindings(activity, detail.checks)
      ? () => {
          void fixWith("findings", () =>
            buildFixFindingsHandoff(detail, {
              reviewThreads: activity?.reviewThreads ?? [],
              comments: activity?.comments ?? [],
              checks: detail.checks,
              commentsTruncated: activity?.commentsTruncated ?? false,
            }),
          );
        }
      : null;

  const explain = (where: "new" | "current") => {
    if (!detail || pending !== null) return;
    setPending("explain");
    void (async () => {
      try {
        const files = await changedFiles();
        const into = where === "current" ? currentSessionTab(repoPath) : null;
        await openHandoffSession({
          projectPath: repoPath,
          cwd: repoPath,
          agent: agent.agent,
          handoff: buildExplainHandoff(detail, files),
          into,
        });
        toast.success(into ? "Added to this session" : `Asked in a new ${agent.label} session`, {
          description: "The question is in the composer: read it over, then send.",
        });
      } catch (err) {
        toast.error("Couldn't open a session", { description: errorMessage(err) });
      } finally {
        setPending(null);
      }
    })();
  };

  const askAboutStop = (stop: GuideStop, index: number, question: string) => {
    if (!detail || pending !== null) return;
    const into = currentSessionTab(repoPath);
    void openHandoffSession({
      projectPath: repoPath,
      cwd: repoPath,
      agent: agent.agent,
      handoff: buildAskAboutGuideStopHandoff(
        detail,
        {
          index,
          title: stop.title,
          summary: stop.summary,
          attention: stop.attention?.note ?? null,
          excerpts: stop.excerpts,
        },
        question,
      ),
      into,
    })
      .then(() =>
        toast.success(into ? "Added to this session" : `Asked in a new ${agent.label} session`, {
          description: "The question is in the composer: read it over, then send.",
        }),
      )
      .catch((err: unknown) =>
        toast.error("Couldn't open a session", { description: errorMessage(err) }),
      );
  };

  const headSha = detail?.headSha ?? null;
  const running = run?.status === "running";
  const fromFork = detail?.isCrossRepository === true;
  const startGuide = () => {
    if (!detail || running) return;
    setConfirmingFork(false);
    void writeGuide({
      repoPath,
      detail,
      activity,
      agent: agent.agent,
      agentLabel: agent.label,
      onSaved: () => {
        void client.invalidateQueries({ queryKey: guideQueryKey(repoPath, number) });
        toast.success(`The review guide for #${number} is ready`);
      },
    });
  };
  const guideState: PullRequestGuideState = {
    guide,
    loading: guideQuery.isPending && !!detail?.repository,
    run,
    running,
    stale: guide !== null && headSha !== null && guide.headSha !== headSha,
    canWrite: !!detail && headSha !== null,
    // A fork's head is code its author controls, agent configuration
    // included (`AGENTS.md`, hooks, `.mcp.json`), and the guide's agent runs
    // in a checkout of it: the reader says yes to that first.
    write: () => {
      if (!detail || running) return;
      if (fromFork) setConfirmingFork(true);
      else startGuide();
    },
    forkConfirm:
      confirmingFork && fromFork && !running
        ? {
            confirm: startGuide,
            cancel: () => setConfirmingFork(false),
          }
        : null,
  };

  return {
    agentLabel: agent.label,
    fixFinding,
    fixFindings,
    explain,
    askAboutStop,
    canExplainInCurrent: () => currentSessionTab(repoPath) !== null,
    pending,
    fixLabel: "Fix",
    guide: guideState,
  };
}
