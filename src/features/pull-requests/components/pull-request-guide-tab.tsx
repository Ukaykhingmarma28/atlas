// The Guide tab: an agent-written tour of the pull request in numbered stops,
// read in order with J and K.
//
// No guide yet → what a guide is, and "Write guide" naming the agent that
// will. Writing → the run's progress, and any permission its background
// session asks for, answered here (no tab shows that session). Written → the
// tour; a banner says when it was written before the latest push, or when a
// rewrite is running or failed. The guide is kept per head commit
// (`guide-run-store.ts`), so it survives a restart and costs nothing to read.

import { useEffect, useRef, useState } from "react";
import type { FileDiffMetadata } from "@pierre/diffs";
import { Loader2, ShieldQuestion, Sparkles, TriangleAlert } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import { agents } from "@/features/chat/lib/agents-api";
import { useChatStore } from "@/features/chat/stores/chat-store";
import { agentMeta } from "@/features/agents/lib/agent-meta";
import { openReviewFile } from "@/features/git/lib/open-review-file";
import { getRenderablePatch, resolveFileDiffPath } from "@/features/git/lib/diff-rendering";

import { stepTourPosition, stopFilePaths } from "../lib/pull-request-guide-tour";
import type { PullRequestGuide } from "../lib/pull-request-guide-types";
import { usePrDiff } from "../lib/pull-requests-queries";
import type { PrDiffResult } from "../lib/pull-requests-types";
import type { PullRequestAgentActions } from "../lib/use-pull-request-agent-actions";
import type { GuideRun } from "../stores/guide-run-store";
import { GuideRail, GuideStop } from "./pull-request-guide-stop";

const NO_FILES: ReadonlyMap<string, FileDiffMetadata> = new Map();

/** The pull request's diff, a page at a time, until every path the stop
 *  shows is loaded. */
function useGuideDiffFiles(
  repoPath: string,
  number: number,
  headSha: string,
  wantedPaths: readonly string[],
) {
  const key = `${repoPath}:${number}:${headSha}`;
  const [loaded, setLoaded] = useState<{
    key: string;
    cursor: string | null;
    done: boolean;
    files: ReadonlyMap<string, FileDiffMetadata>;
    folded: PrDiffResult | null;
  }>({ key, cursor: null, done: false, files: NO_FILES, folded: null });
  const current =
    loaded.key === key ? loaded : { key, cursor: null, done: false, files: NO_FILES, folded: null };
  const missing = wantedPaths.some((path) => !current.files.has(path));
  const loading = missing && !current.done;
  const query = usePrDiff(loading ? repoPath : null, number, current.cursor);

  // Each page is folded in once, during the render that first sees it.
  const data = query.data ?? null;
  if (data !== null && !current.done && current.folded !== data) {
    const parsed = getRenderablePatch(
      data.patch,
      `pull-request-guide:${key}:${current.cursor ?? "first"}`,
    );
    const files = new Map(current.files);
    if (parsed?.kind === "files") {
      for (const file of parsed.files) files.set(resolveFileDiffPath(file), file);
    }
    setLoaded({
      key,
      cursor: data.nextCursor,
      done: data.nextCursor === null,
      files,
      folded: data,
    });
  }

  return {
    files: current.files,
    loading: loading && !query.error,
    error: loading && query.error ? (query.error.message ?? "The diff could not be read.") : null,
  };
}

/** A permission the run's session is waiting on, answered inline. */
function RunPermission({ run }: { run: Extract<GuideRun, { status: "running" }> }) {
  const sessionId = run.session?.session_id ?? null;
  const request = useChatStore((s) => (sessionId ? s.pendingPermissions[sessionId]?.[0] : null));
  if (!request || !run.session) return null;
  const key = run.session;
  const answer = (optionId: string | null) =>
    void agents
      .respondPermission(
        key.agent_id,
        key.session_id,
        request.requestId,
        optionId === null ? { kind: "cancelled" } : { kind: "selected", option_id: optionId },
      )
      .then(() => useChatStore.getState().actions.popPermission(key.session_id, request.requestId))
      .catch(() => undefined);
  return (
    <div className="flex w-full max-w-md flex-col gap-2 rounded-lg border border-warning bg-warning-muted px-3 py-2.5 text-left">
      <p className="flex items-center gap-2 text-sm font-medium text-foreground">
        <ShieldQuestion aria-hidden className="size-4 shrink-0 text-warning" />
        {run.agentLabel} asks to run something
      </p>
      <p className="truncate font-mono text-xs text-secondary-foreground">
        {request.toolCall.title ?? "A tool call"}
      </p>
      <div className="flex flex-wrap gap-1.5">
        {request.options.map((option) => (
          <Button
            key={option.optionId}
            size="xs"
            variant={option.kind.startsWith("allow") ? "default" : "outline"}
            onClick={() => answer(option.optionId)}
          >
            {option.name}
          </Button>
        ))}
        <Button size="xs" variant="ghost" onClick={() => answer(null)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

const PHASE_LABELS = {
  checkout: "Checking out the pull request's head…",
  reading: "Reading the change…",
  saving: "Saving the guide…",
} as const;

function GuideTour({
  repoPath,
  number,
  guide,
  banner,
  active,
  onAsk,
  scrollerRef,
}: {
  scrollerRef?: (node: HTMLDivElement | null) => void;
  repoPath: string;
  number: number;
  guide: PullRequestGuide;
  banner: React.ReactNode;
  active: boolean;
  onAsk: ((index: number, question: string) => void) | null;
}) {
  const [position, setPosition] = useState(0);
  const [seen, setSeen] = useState<ReadonlySet<number>>(() => new Set());
  const stopCount = guide.stops.length;
  const at = Math.max(Math.min(position, stopCount - 1), 0);
  const stop = guide.stops[at] ?? null;
  const diff = useGuideDiffFiles(repoPath, number, guide.headSha, stop ? stopFilePaths(stop) : []);
  const scrollRef = useRef<HTMLDivElement>(null);

  const goTo = (next: number) => {
    if (next > at) setSeen((current) => new Set(current).add(at));
    setPosition(next);
    scrollRef.current?.scrollTo({ top: 0 });
  };
  const step = (delta: 1 | -1) => goTo(stepTourPosition(at, delta, stopCount));
  const stepRef = useRef(step);
  stepRef.current = step;

  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      if (event.key !== "j" && event.key !== "k") return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, [contenteditable='true'], .cm-editor")) return;
      event.preventDefault();
      stepRef.current(event.key === "j" ? 1 : -1);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [active]);

  const openFile = (path: string) => void openReviewFile(`${repoPath}/${path}`);

  return (
    <div
      ref={(node) => {
        scrollRef.current = node;
        scrollerRef?.(node);
      }}
      className="@container/guide h-full overflow-y-auto"
    >
      <div className="mx-auto grid max-w-6xl gap-6 px-4 py-4 pb-20 @min-[48rem]/guide:grid-cols-[14rem_minmax(0,1fr)]">
        <aside className="sticky top-4 self-start @max-[48rem]/guide:hidden">
          <GuideRail stops={guide.stops} position={at} seen={seen} onSelect={goTo} />
        </aside>
        <main className="flex min-w-0 flex-col gap-4">
          {banner}
          {diff.error !== null ? (
            <p className="text-xs text-muted-foreground">
              The diff could not be loaded, so excerpts are missing: {diff.error}
            </p>
          ) : null}
          {stop === null ? (
            <p className="text-sm text-muted-foreground">This change has no files to tour.</p>
          ) : (
            <GuideStop
              key={at}
              stop={stop}
              index={at}
              stopCount={stopCount}
              nextTitle={guide.stops[at + 1]?.title ?? null}
              files={diff.files}
              diffLoading={diff.loading}
              onStep={step}
              onAsk={onAsk === null ? null : (question) => onAsk(at, question)}
              onFinish={() => setSeen((current) => new Set(current).add(at))}
              onOpenFile={openFile}
            />
          )}
          <p className="text-2xs text-muted-foreground">
            Written by {agentMeta(guide.agent).label}
            {guide.generatedAt ? ` · ${new Date(guide.generatedAt).toLocaleString()}` : ""} · for{" "}
            <span className="font-mono">{guide.headSha.slice(0, 7)}</span>
          </p>
        </main>
      </div>
    </div>
  );
}

export function PullRequestGuideTab({
  repoPath,
  number,
  agent,
  active,
  scrollerRef,
}: {
  repoPath: string;
  number: number;
  agent: PullRequestAgentActions;
  active: boolean;
  scrollerRef?: (node: HTMLDivElement | null) => void;
}) {
  const { guide, loading, run, running, stale, canWrite, write } = agent.guide;
  const failure = run?.status === "failed" ? run.detail : null;
  const writeButton = (label: string, size: "sm" | "xs") =>
    canWrite ? (
      <Button size={size} variant="outline" disabled={running} onClick={write}>
        {running ? (
          <Loader2 aria-hidden className="size-3.5 animate-spin" />
        ) : (
          <Sparkles aria-hidden className="size-3.5" />
        )}
        {running ? "Reading the change…" : label}
      </Button>
    ) : null;

  if (guide === null) {
    if (loading) {
      return (
        <div className="flex h-full items-center justify-center">
          <Loader2 aria-hidden className="size-4 animate-spin text-muted-foreground" />
        </div>
      );
    }
    return (
      <div
        ref={scrollerRef}
        className="flex h-full flex-col items-center justify-center gap-3 overflow-y-auto px-6 py-10 text-center"
      >
        <Sparkles aria-hidden className="size-6 text-muted-foreground" />
        <p className="text-sm font-medium text-foreground">
          {running ? "Writing a review guide" : "No review guide yet"}
        </p>
        <p className="max-w-md text-xs text-muted-foreground">
          {failure ??
            (run?.status === "running"
              ? `${run.agentLabel} is reading the change in a checkout of its own. ${PHASE_LABELS[run.phase]} A large change takes a few minutes; you can leave, and you will be told when it is ready.`
              : `A guide is a tour of the change: stops through the code in reading order, with the calls only a maintainer can make. ${agent.agentLabel} writes it, reading a checkout of the pull request's head.`)}
        </p>
        {run?.status === "running" ? <RunPermission run={run} /> : null}
        {writeButton(failure === null ? `Write guide with ${agent.agentLabel}` : "Try again", "sm")}
      </div>
    );
  }

  const banner =
    stale || failure !== null || running ? (
      <div
        role="status"
        className={cn(
          "flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-xs",
          running ? "border-info bg-info-muted" : "border-warning bg-warning-muted",
        )}
      >
        {running ? (
          <Loader2 aria-hidden className="size-3.5 shrink-0 animate-spin text-info" />
        ) : (
          <TriangleAlert aria-hidden className="size-3.5 shrink-0 text-warning" />
        )}
        <span className="min-w-0 flex-1 text-foreground">
          {running
            ? "Rewriting this guide. You will be told when the new one is ready."
            : (failure ?? "Written before the latest push.")}
        </span>
        {!running ? writeButton("Rewrite", "xs") : null}
        {run?.status === "running" ? <RunPermission run={run} /> : null}
      </div>
    ) : null;

  return (
    <GuideTour
      repoPath={repoPath}
      number={number}
      guide={guide}
      banner={banner}
      active={active}
      scrollerRef={scrollerRef}
      onAsk={(index, question) => {
        const stop = guide.stops[index];
        if (stop) agent.askAboutStop(stop, index, question);
      }}
    />
  );
}
