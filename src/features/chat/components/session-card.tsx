// One thread in the chat history sidebar, as a card: the title and its live
// status, then the branch it ran on, the pull request for that branch, and the
// agent that ran it.
//
// The project is named only when it says something. The sidebar is scoped to
// the open project, so on most cards the name would repeat the same word in
// every row; a card from another project or worktree (`showProject`) gets the
// project line on top — it resumes somewhere else, and that is what the line
// warns of. A list mixing projects is grouped under headings by the sidebar
// instead.
//
// Every field is one Atlas actually has. The branch is the one the thread
// recorded (`ThreadRow.branch` — never the folder's branch now, which may have
// moved on); the pull request comes from the repository's one shared `gh`
// lookup and is simply absent when there is none, no `gh`, or no GitHub
// remote. The working timer counts from the turn start the chat store stamps.
//
// The sidebar mounts every card at once, so each one is cheap: memoised on
// primitive props, one shared one-second ticker for all running timers, and
// no PR lookup until the card has been on screen.
//
// Structure: the card's open target is a real <button> stretched over the
// card; the PR link and the settle/delete actions are its siblings,
// painted above it, so no control is nested inside another. The same actions
// are on the card's context menu.
//
// A settled card (on the sidebar's Settled shelf) is dimmed and says
// "Settled" where an active one says "Done"; its settle action becomes
// "Un-settle".

import { memo, useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import {
  CircleCheck,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  Undo2,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { timeAgo } from "@/lib/time-ago";
import { Hint } from "@/ui/tooltip";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from "@/ui/context-menu";
import { useActionShortcut } from "@/features/keybindings/lib/use-action-shortcut";
import {
  AgentMonogram,
  ClaudeIcon,
  CodexIcon,
  CursorIcon,
  ExternalAgentIcon,
  KiloIcon,
  OpenCodeIcon,
} from "@/components/agent-icons";
import { AtlasIcon } from "@/components/atlas-icon";
import { agentMeta } from "@/features/agents/lib/agent-meta";
import {
  openPullRequest,
  useBranchPullRequest,
  type BranchPullRequest,
} from "@/features/git/lib/git-pr-api";
import { useChatStore } from "../stores/chat-store";
import { AGENT_TYPE_BY_SIDEBAR, type SidebarAgent } from "../lib/sidebar-agents";

/** Two-letter monogram for a project name: "northwind-shop" → "NS", "atlas" → "AT". */
export function projectMonogram(name: string): string {
  const words = name
    .trim()
    .split(/[\s\-_./]+/)
    .filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (words[0]![0]! + words[1]![0]!).toUpperCase();
}

/** "45s", "7m", "1h 5m" — how long the current turn has run. */
export function formatWorkingDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 === 0 ? `${h}h` : `${h}h ${m % 60}m`;
}

// ── One ticker for every running card ──────────────────────────────────────
//
// A module-level clock: one interval however many timers are on screen,
// running only while something listens and paused while the window is hidden
// (a hidden timer has nobody to show the second to; it catches up on return).

const tickListeners = new Set<() => void>();
let tickNow = Date.now();
let tickTimer: ReturnType<typeof setInterval> | null = null;

function tick() {
  tickNow = Date.now();
  for (const listener of tickListeners) listener();
}

function startTicking() {
  if (tickTimer !== null || document.hidden) return;
  tickTimer = setInterval(tick, 1000);
}

function stopTicking() {
  if (tickTimer === null) return;
  clearInterval(tickTimer);
  tickTimer = null;
}

function onVisibilityChange() {
  if (document.hidden) {
    stopTicking();
  } else {
    tick();
    startTicking();
  }
}

function subscribeTicker(listener: () => void): () => void {
  tickListeners.add(listener);
  if (tickListeners.size === 1) {
    tickNow = Date.now();
    document.addEventListener("visibilitychange", onVisibilityChange);
    startTicking();
  }
  return () => {
    tickListeners.delete(listener);
    if (tickListeners.size === 0) {
      stopTicking();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    }
  };
}

const getTickNow = () => tickNow;

/** Whether the shared ticker's interval is running — for tests. */
export function isTickerRunning(): boolean {
  return tickTimer !== null;
}

// ── Seen once, via one shared IntersectionObserver ─────────────────────────

const onSeen = new WeakMap<Element, () => void>();
let seenObserver: IntersectionObserver | null = null;

function observeUntilSeen(el: Element, cb: () => void): () => void {
  if (typeof IntersectionObserver === "undefined") {
    cb();
    return () => {};
  }
  seenObserver ??= new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const seen = onSeen.get(entry.target);
        onSeen.delete(entry.target);
        seenObserver?.unobserve(entry.target);
        seen?.();
      }
    },
    // A little ahead of the fold, so a card scrolled into view already has
    // its answer.
    { rootMargin: "200px 0px" },
  );
  onSeen.set(el, cb);
  seenObserver.observe(el);
  return () => {
    onSeen.delete(el);
    seenObserver?.unobserve(el);
  };
}

/** True once the element has been on (or near) screen; stays true. */
function useSeenOnce(ref: React.RefObject<Element | null>): boolean {
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (seen || !el) return;
    return observeUntilSeen(el, () => setSeen(true));
  }, [seen, ref]);
  return seen;
}

// ── Status ─────────────────────────────────────────────────────────────────

/** The running turn's start, as the chat store stamped it. */
function useTurnStartedAt(tabId: string | null): number | null {
  return useChatStore((s) => (tabId ? (s.sessions[tabId]?.turnStartedAt ?? null) : null));
}

function WorkingDuration({ startedAt }: { startedAt: number }) {
  const now = useSyncExternalStore(subscribeTicker, getTickNow);
  return <span className="tabular-nums">{formatWorkingDuration(now - startedAt)}</span>;
}

/** The dashed ring that turns while an agent works. */
function WorkingRing() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      // The motion scale (`duration-*`) is for transitions of 80–260ms; this
      // is a continuous, deliberately slow rotation — the stock `animate-spin`
      // at 1s reads as "loading" rather than "working" — and no slow-spin
      // token exists. Reduced motion stops it.
      className="size-2.5 shrink-0 animate-spin [animation-duration:3s] motion-reduce:animate-none"
    >
      <circle
        cx="8"
        cy="8"
        r="6.25"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeDasharray="2.6 2.3"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Lucide's `circle-dashed-check`, drawn here.
 *
 *  It is not in the pinned lucide (1.41.0) — it landed later — and bumping the
 *  icon set sixteen minors for one glyph risks every other icon in the app on
 *  a rename. The arcs are lucide's own `circle-dashed`, verbatim, plus its
 *  standard check, so it is the same mark the upgrade would eventually bring.
 *
 *  Its dashed ring deliberately echoes `WorkingRing` above: the thread that is
 *  running and the thread that finished wear the same ring, one turning and
 *  one closed by the check. */
function CircleDashedCheck({ size = 12 }: { size?: number }) {
  return (
    <svg
      aria-hidden
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0"
    >
      <path d="M10.1 2.182a10 10 0 0 1 3.8 0" />
      <path d="M13.9 21.818a10 10 0 0 1-3.8 0" />
      <path d="M17.609 3.721a10 10 0 0 1 2.69 2.7" />
      <path d="M2.182 13.9a10 10 0 0 1 0-3.8" />
      <path d="M20.279 17.609a10 10 0 0 1-2.7 2.69" />
      <path d="M21.818 10.1a10 10 0 0 1 0 3.8" />
      <path d="M3.721 6.391a10 10 0 0 1 2.7-2.69" />
      <path d="M6.391 20.279a10 10 0 0 1-2.69-2.7" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}

/** "20h ago" → "20h Ago", "just now" → "Just Now", "20 May" → "20 May".
 *
 *  Per word, and only the first CHARACTER of each: upper-casing the whole
 *  token would give "20H Ago", because `timeAgo`'s unit is glued to its
 *  number. A token starting with a digit is left as it is, which is what
 *  keeps the dates it falls back to past a week intact. */
function titleCase(text: string): string {
  return text.replace(/\S+/g, (word) => word[0]!.toUpperCase() + word.slice(1));
}

export type SessionLiveStatus = "running" | "waiting" | null;

/** The visible status. Hidden from assistive tech: the open button carries a
 *  static description instead, so the per-second timer never chatters.
 *
 *  Three states, each with its own colour, because the card's bottom-left is
 *  the one place a glance can tell them apart: the agent is working (info), it
 *  is blocked on the user (warning), or the thread is finished (success).
 *  "Done" is named rather than left as a bare timestamp — a timestamp alone
 *  reads as metadata, and the point of this row is that nothing is pending. */
function StatusLabel({
  status,
  tabId,
  lastUpdated,
  settledAt,
  liveElsewhere,
}: {
  status: SessionLiveStatus;
  tabId: string | null;
  lastUpdated: string | null;
  /** When the session was settled; `null` while it is active. */
  settledAt: string | null;
  /** Another process is writing this thread. It IS running, Atlas is just not
   *  the one running it. */
  liveElsewhere: boolean;
}) {
  const startedAt = useTurnStartedAt(status === "running" ? tabId : null);
  // A thread another process is writing is a RUNNING thread, so it wears the
  // running treatment rather than a mark of its own. It used to be a green
  // dot beside whatever the status said — which on a finished-looking row
  // read as a second, contradictory state ("Done", but with a live dot), and
  // said nothing about what was actually happening.
  //
  // Only the duration differs: the turn clock is stamped by the chat store
  // when THIS process starts a turn, so there is no start to count from for a
  // turn running somewhere else. The label simply reads "Working".
  if (status === "running" || liveElsewhere) {
    return (
      <span
        data-testid={status === "running" ? undefined : "live-elsewhere-working"}
        title={liveElsewhere ? "Active in another process" : undefined}
        className="flex items-center gap-1 text-3xs font-medium text-info"
      >
        <WorkingRing />
        Working {startedAt !== null && <WorkingDuration startedAt={startedAt} />}
      </span>
    );
  }
  if (status === "waiting") {
    return (
      <span className="flex items-center gap-1 text-3xs font-medium text-warning">
        <span className="size-1 rounded-full bg-current" />
        Needs Input
      </span>
    );
  }
  if (settledAt) {
    // Put away rather than finished: the same closed ring, without the
    // success colour — nothing here is asking to be looked at.
    const since = timeAgo(settledAt, { suffix: true });
    return (
      <span className="flex items-center gap-1 text-3xs font-medium text-muted-foreground">
        <CircleDashedCheck size={11} />
        Settled
        {since && (
          <>
            <span aria-hidden className="text-muted-foreground/50">
              ·
            </span>
            <span className="tabular-nums">{titleCase(since)}</span>
          </>
        )}
      </span>
    );
  }
  const ago = timeAgo(lastUpdated, { suffix: true });
  return (
    <span className="flex items-center gap-1 text-3xs font-medium text-success">
      <CircleDashedCheck size={11} />
      Done
      {ago && (
        <>
          <span aria-hidden className="text-success/50">
            ·
          </span>
          <span className="tabular-nums">{titleCase(ago)}</span>
        </>
      )}
    </span>
  );
}

function statusDescription(
  status: SessionLiveStatus,
  lastUpdated: string | null,
  settledAt: string | null,
  liveElsewhere: boolean,
): string {
  if (status === "running" || liveElsewhere) return "Working";
  if (status === "waiting") return "Needs input";
  if (settledAt) {
    const since = timeAgo(settledAt, { suffix: true });
    return since ? `Settled ${since}` : "Settled";
  }
  const ago = timeAgo(lastUpdated, { suffix: true });
  return ago ? `Done ${ago}` : "Done";
}

// ── Pull request ───────────────────────────────────────────────────────────

const PR_STATE: Record<
  BranchPullRequest["state"],
  { icon: typeof GitPullRequest; className: string; label: string }
> = {
  open: { icon: GitPullRequest, className: "text-success", label: "Open" },
  merged: { icon: GitMerge, className: "text-info", label: "Merged" },
  closed: { icon: GitPullRequestClosed, className: "text-error", label: "Closed" },
};

/** The pull request for the thread's branch, when GitHub has one. */
function PullRequestChip({
  cwd,
  branch,
  enabled,
}: {
  cwd: string;
  branch: string;
  enabled: boolean;
}) {
  const pr = useBranchPullRequest(cwd, branch, enabled);
  if (!pr) return null;
  const state = pr.isDraft && pr.state === "open" ? null : PR_STATE[pr.state];
  const Icon = state?.icon ?? GitPullRequestDraft;
  const label = `${state?.label ?? "Draft"} pull request #${pr.number}: ${pr.title}`;
  return (
    <button
      type="button"
      onClick={() => openPullRequest(pr.url)}
      aria-label={`${label} — open on GitHub`}
      title={label}
      className={cn(
        "relative flex shrink-0 cursor-pointer items-center gap-0.5 rounded-sm text-3xs tabular-nums hover:underline",
        state?.className ?? "text-muted-foreground",
      )}
    >
      <Icon size={10} aria-hidden />
      {pr.number}
    </button>
  );
}

// ── Agent ──────────────────────────────────────────────────────────────────

/** The mark of the agent that ran a thread. */
export function SidebarAgentIcon({ agent }: { agent: SidebarAgent }) {
  if (agent === "codex") return <CodexIcon className="size-2.5" />;
  if (agent === "opencode") return <OpenCodeIcon className="size-2.5" />;
  if (agent === "cursor") return <CursorIcon className="size-2.5" />;
  if (agent === "kilo") return <KiloIcon className="size-2.5" />;
  if (agent === "atlas-agent") return <AtlasIcon size={10} />;
  if (agent === "claude") return <ClaudeIcon className="size-2.5" />;
  const meta = agentMeta(agent);
  return meta.iconDataUrl ? (
    <ExternalAgentIcon dataUrl={meta.iconDataUrl} size={10} />
  ) : (
    <AgentMonogram label={meta.label} size={10} />
  );
}

// ── Card ───────────────────────────────────────────────────────────────────

export interface SessionCardProps {
  /** Atlas's id for the thread — what the handlers are called with. */
  threadId: string;
  title: string;
  projectName: string;
  /** Name the project on the card: the thread belongs to a project other than
   *  the one the list is scoped to. */
  showProject: boolean;
  /** The branch the thread recorded; `null` when it ran outside a branch. */
  branch: string | null;
  /** Where the thread lives — the repository its branch's PR is looked up in. */
  cwd: string;
  lastUpdated: string | null;
  status: SessionLiveStatus;
  /** The open tab hosting this thread, if any — the timer reads its turn. */
  liveTabId: string | null;
  active: boolean;
  agent: SidebarAgent;
  /** Another process (typically a terminal) is writing this session — the
   *  live dot, and the composer's "Send anyway" hold once it is opened. */
  liveElsewhere: boolean;
  /** When the session was settled (it is on the Settled shelf); `null` while
   *  it is active. */
  settledAt: string | null;
  /** Stable across renders (the card is memoised); called with `threadId`. */
  onOpen: (threadId: string) => void;
  onSettle: (threadId: string) => void;
  onUnsettle: (threadId: string) => void;
  onDelete: (threadId: string) => void;
}

export const SessionCard = memo(function SessionCard({
  threadId,
  title,
  projectName,
  showProject,
  branch,
  cwd,
  lastUpdated,
  status,
  liveTabId,
  active,
  agent,
  liveElsewhere,
  settledAt,
  onOpen,
  onSettle,
  onUnsettle,
  onDelete,
}: SessionCardProps) {
  const ref = useRef<HTMLDivElement>(null);
  const seen = useSeenOnce(ref);
  const descriptionId = useId();
  const agentLabel = agentMeta(AGENT_TYPE_BY_SIDEBAR[agent] ?? agent).label;
  const description = [
    showProject ? projectName : null,
    liveElsewhere ? "Active in another process" : null,
    statusDescription(status, lastUpdated, settledAt, liveElsewhere),
    branch,
    agentLabel,
  ]
    .filter(Boolean)
    .join(", ");
  // Bottom-left: what the thread is doing. It no longer shares the title's row
  // with the hover actions, so it no longer fades out under them — the actions
  // are a floating pill over the title instead.
  const statusSlot = (
    <span className="flex shrink-0 items-center gap-1">
      <StatusLabel
        status={status}
        tabId={liveTabId}
        lastUpdated={lastUpdated}
        settledAt={settledAt}
        liveElsewhere={liveElsewhere}
      />
    </span>
  );
  const settled = settledAt !== null;
  // The chord settles the OPEN session, so only the open card names it.
  const settleShortcut = useActionShortcut("chat.settleSession");
  const settleKeys = active ? settleShortcut?.label : undefined;
  // One place for both the hover pill and the context menu, so the two never
  // disagree about what the action is called.
  const settleAction = settled
    ? { label: "Un-settle", hint: "Un-settle — back to the active list", run: onUnsettle }
    : { label: "Settle", hint: "Settle — done for now, kept on the shelf", run: onSettle };

  return (
    <ContextMenu>
      {/* The trigger stays layout-only; the card's look is on its child. */}
      <ContextMenuTrigger render={<div ref={ref} className="select-none" />}>
        <div
          data-settled={settled || undefined}
          className={cn(
            // `rounded-md` is the scale's card step; `rounded-xl` is the dialog
            // step, and at this size it read as a pill rather than a card.
            "group relative flex flex-col gap-1.5 rounded-md px-2.5 py-2 text-left transition-colors duration-fast",
            active
              ? "bg-element-selected ring-1 ring-foreground/10"
              : settled
                ? // Dimmed: off the card fill, onto the sidebar's own, so the
                  // shelf reads as put away. Hover still lifts it.
                  "ring-1 ring-foreground/5 hover:bg-element-hover"
                : "bg-card ring-1 ring-foreground/5 hover:bg-element-hover",
          )}
        >
          {/* The open target: stretched over the whole card, under the PR link
          and the actions, which are its siblings rather than its children. */}
          <button
            type="button"
            onClick={() => onOpen(threadId)}
            aria-current={active || undefined}
            aria-label={title}
            aria-describedby={descriptionId}
            className="absolute inset-0 cursor-pointer rounded-md focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
          />
          <span id={descriptionId} className="sr-only">
            {description}
          </span>

          {showProject && (
            <div aria-hidden className="pointer-events-none flex min-w-0 items-center gap-1.5">
              <span className="grid h-4 min-w-4 shrink-0 place-items-center rounded-sm bg-element-selected px-0.5 text-3xs font-semibold leading-none text-secondary-foreground">
                {projectMonogram(projectName)}
              </span>
              <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                {projectName}
              </span>
            </div>
          )}

          {/* Title, alone on its row. The actions float over its right end on
          hover, so it reserves nothing for them — a permanent gutter cost
          two words of every title to buy a strip that is empty most of the
          time, and the pill below is opaque enough to sit on text. */}
          <div aria-hidden className="pointer-events-none flex min-w-0 items-start">
            <span
              className={cn(
                "line-clamp-2 min-w-0 flex-1 text-sm leading-snug",
                active
                  ? "text-foreground"
                  : settled
                    ? "text-muted-foreground group-hover:text-secondary-foreground"
                    : "text-secondary-foreground group-hover:text-foreground",
              )}
            >
              {title}
            </span>
          </div>

          {/* Status on the left, where the thread's state is; who ran it on the
          right.
          The branch NAME is deliberately not here. The sidebar is scoped to one
          project, so in practice every row named the same branch — a column of
          identical text earning none of the width it cost. The branch is still
          what the pull request is looked up by, and the chip is the part of it
          that actually varies per row, so that stays. The separator went with
          the name: it existed to part the branch from the agent, and there is
          nothing left to part. */}
          <div className="pointer-events-none flex min-w-0 items-center gap-2">
            {statusSlot}
            <span className="ml-auto flex shrink-0 items-center gap-1.5">
              {branch && cwd && (
                <span className="pointer-events-auto flex shrink-0">
                  <PullRequestChip cwd={cwd} branch={branch} enabled={seen} />
                </span>
              )}
              <span
                aria-hidden
                className={cn(
                  "flex shrink-0 items-center",
                  settled ? "text-muted-foreground" : "text-secondary-foreground",
                )}
                title={agentLabel}
              >
                <SidebarAgentIcon agent={agent} />
              </span>
            </span>
          </div>

          {/* Hover actions (settle, delete), as a floating pill over the
          title's right end — the same 24px dock the titlebar and the GitHub
          panel's rows use. Opaque, so the title tail it covers does not show
          through. All work for every agent: the row is Atlas's, so none
          depends on reaching the agent that produced it. */}
          <div className="absolute top-1.5 right-1.5 flex items-center gap-px rounded-full border border-border-subtle bg-card p-0.5 opacity-0 transition-opacity duration-fast group-hover:opacity-100 group-focus-within:opacity-100">
            <Hint label={settleAction.hint} shortcut={settleKeys}>
              <button
                type="button"
                onClick={() => settleAction.run(threadId)}
                aria-label={`${settleAction.label} session`}
                className="flex size-control-xs items-center justify-center rounded-full text-muted-foreground hover:bg-element-active hover:text-foreground"
              >
                {settled ? <Undo2 size={11} /> : <CircleCheck size={11} />}
              </button>
            </Hint>
            <Hint label="Delete session">
              <button
                type="button"
                onClick={() => onDelete(threadId)}
                aria-label="Delete session"
                className="flex size-control-xs items-center justify-center rounded-full text-muted-foreground hover:bg-element-active hover:text-error"
              >
                <X size={11} />
              </button>
            </Hint>
          </div>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onClick={() => onOpen(threadId)}>Open</ContextMenuItem>
        <ContextMenuItem onClick={() => settleAction.run(threadId)}>
          {settleAction.label}
          {settleKeys && <ContextMenuShortcut>{settleKeys}</ContextMenuShortcut>}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" onClick={() => onDelete(threadId)}>
          Delete…
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
});
