import { useQuery, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import {
  Fragment,
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useCallback,
} from "react";
import { ArrowUp, ChevronRight, History, Search } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Hint } from "@/ui/tooltip";
import { ScrollFade, useScrollEdges } from "@/ui/scroll-fade";
import { isBusyAgentStatus, agentTypeFromPluginId } from "@/types/agent";
import { pluginIdForAgent } from "@/types/agent";
import { repoPullRequestsKey } from "@/features/git/lib/git-pr-api";
import { invalidatePullRequestQueries } from "@/features/pull-requests/lib/pull-requests-queries";
import { ThreadHistoryView } from "./thread-history-view";
import { SessionCard } from "./session-card";
import {
  nextAfterSettling,
  placeProjectNames,
  SETTLED_SHELF_FIRST_PAGE,
  SETTLED_SHELF_PAGE,
  sortThreads,
  splitSettled,
} from "../lib/sidebar-grouping";
import { registerSettleAndAdvance } from "../lib/settle-and-advance";
import { openNewAgentChat } from "../lib/open-agent-session";
import { useSettingsStore } from "@/features/settings/stores/settings-store";
import { confirmDeleteChat } from "../lib/confirm-delete-chat";
import { useAppStore } from "@/features/app/stores/app-store";
import { useProjectStore } from "@/features/projects/stores/project-store";
import { useActiveOrgProjects } from "@/features/projects/lib/org-scope";
import { useOrgStore } from "@/features/organisations/stores/org-store";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { useChatStore } from "../stores/chat-store";
import { useFrozenOrder } from "../hooks/use-frozen-order";
import { bumpLoadToken, isLoadStale } from "../lib/load-tokens";
import {
  archiveThread,
  deleteThread,
  onThreadsChanged,
  settleThread,
  syncProjectThreads,
  threadProjects,
  unsettleThread,
  type ThreadRow,
} from "../lib/history-api";
import { getAgentSync } from "../lib/agents-api";
import { useRecentChatsStore } from "@/features/projects/stores/recent-chats-store";
import { resumeThreadFast, ResumeError } from "../lib/resume-session";
import { applyModeOnResume, holdUnrestoredMode } from "../lib/resume-mode";
import { AGENT_TYPE_BY_SIDEBAR, sidebarAgentOf, type SidebarAgent } from "../lib/sidebar-agents";

/** A row's identity for the frozen order (and its React key). */
const rowKey = (item: SidebarItem) => item.threadId;

/** The list's edge fades. They ramp from the sidebar's own fill — fading from
 *  `--background` here was a grey wash over the panel rather than an invisible
 *  one. */
const LIST_FADE = "from-[var(--sidebar)] via-[var(--sidebar)]/80";

/** The way back to the newest thread, over the bottom of the list.
 *
 *  It rides ON the bottom fade, so it only ever sits over rows that are
 *  already dimmed — and it is a pill with its own fill, which is what lets it
 *  overlap them at all. */
function JumpToLatest({ visible, onJump }: { visible: boolean; onJump: () => void }) {
  return (
    <div
      className={cn(
        "absolute inset-x-0 bottom-2 z-20 flex justify-center transition-opacity duration-200",
        visible ? "opacity-100" : "pointer-events-none opacity-0",
      )}
    >
      <button
        type="button"
        onClick={onJump}
        tabIndex={visible ? 0 : -1}
        aria-hidden={!visible}
        className="flex h-control-xs cursor-pointer items-center gap-1 rounded-full border border-border-subtle bg-card px-2 text-2xs font-medium text-secondary-foreground shadow-md transition-colors hover:bg-element-hover hover:text-foreground"
      >
        <ArrowUp size={10} aria-hidden />
        Jump to latest
      </button>
    </div>
  );
}
/** The message of a failed query, for the error row. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The reason a rejected `invoke` gives. It carries the backend's `CmdError`
 *  — a plain `{ message, kind }` object, not an `Error` — and its message is
 *  the reason (the session is still running, or active in another process). */
function invokeErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "object" && err !== null && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}

/** How long the Undo on a settle stays up. */
const SETTLE_UNDO_MS = 5_000;

/** One key for the whole sidebar: history is one store, so there is one query. */
const THREAD_PROJECTS_KEY = ["thread-projects"] as const;

/** One history row, as the list renders it. Used by the sidebar's own list and
 *  by the history view handing a row back to be opened — one builder, so the
 *  two cannot disagree about what a row is. */
function itemFromThread(thread: ThreadRow, projectName: string, elsewhere = false): SidebarItem {
  return {
    // Never a draft: `threads_projects` lists only threads that have been sent
    // to, so the session id is always there.
    id: thread.sessionId ?? "",
    threadId: thread.threadId,
    kind: "agent",
    title: thread.title,
    projectName,
    elsewhere,
    lastUpdated: thread.updatedAt,
    agent: sidebarAgentOf(thread.agentId),
    // The thread's own directory — where it resumes.
    cwd: thread.folderPaths[0] ?? "",
    liveElsewhere: thread.liveElsewhere,
    branch: thread.branch ?? null,
    settledAt: thread.settledAt ?? null,
  };
}

/** Compact token count: 1234 → "1.2k", 1_200_000 → "1.2M". */

interface SidebarItem {
  /** The agent's session id, or a stand-in while the thread is still a draft.
   *  Only used to match the row against a live tab. */
  id: string;
  /** Atlas's own id for the conversation — what opening and deleting use. */
  threadId: string;
  kind: "agent";
  title: string;
  lastUpdated: string | null;
  /** Which agent ran this session (drives the row icon). */
  agent: SidebarAgent;
  /** The project this thread belongs to. Named on the card only when it is
   *  `elsewhere`, and as a heading when no project is open. */
  projectName: string;
  /** The thread belongs to a project other than the open one. From the
   *  project's own `isCurrent`, not a path compare here: the stored paths are
   *  canonicalised and the UI's `cwd` is not, so comparing them directly
   *  marked every row "elsewhere" the moment the two spellings diverged. */
  elsewhere: boolean;
  /** The thread's own working directory — where it resumes, which is not
   *  necessarily the project that happens to be open. */
  cwd: string;
  /** Another process (likely a terminal) is still writing this session. */
  liveElsewhere: boolean;
  /** The branch the thread ran on, as it recorded it. */
  branch: string | null;
  /** When the session was settled — it is on the Settled shelf; `null` while
   *  it is active. */
  settledAt: string | null;
}

interface SessionSidebarProps {
  tabId: string;
  /**
   * Where this list is being rendered.
   *
   * `"sidebar"` (default) — the resizable left column inside the chat panel,
   * gated on `chatSidebar.visible`.
   *
   * `"dropdown"` — the body of the header's session picker. Same data, same
   * handlers, different chrome: no fixed width, no resize handle, no border,
   * and NOT gated on the sidebar's visibility (the picker exists precisely so
   * history is reachable with the sidebar closed).
   *
   * This is a variant rather than a second component on purpose. Reading the
   * list is one query now, but OPENING a row is still a hundred lines of
   * resume logic with several hard-won edge cases (orphan tabs, a running tab
   * that must not be overwritten, stale clicks). Duplicating that would
   * guarantee the two drift.
   */
  variant?: "sidebar" | "dropdown";
  /** Called after a row is opened — lets the picker close itself. */
  onOpened?: () => void;
}

// memo: ChatPanel re-renders once per streaming rAF flush (whole-session
// subscription), and this whole body was re-executed with it every frame.
// Props are stable from ChatPanel
// (tabId string; the dropdown variant passes its own onOpened, whose identity
// its parent controls), so memo confines re-runs to this component's own
// subscriptions.
export const SessionSidebar = memo(function SessionSidebar({
  tabId,
  variant = "sidebar",
  onOpened,
}: SessionSidebarProps) {
  const asDropdown = variant === "dropdown";
  const queryClient = useQueryClient();
  const project = useAppStore.use.currentProject();
  // `currentProject` is a legacy field that's transiently null during boot and
  // project switches (it's repopulated by a fire-and-forget `void switchTo`).
  // When it's null, `cwd` was "" → every history query (gated on
  // `cwd.length > 0`) returned [] → the sidebar showed only ephemeral live rows.
  // Fall back to the active project's path (the real source of truth).
  const activeProjectId = useProjectStore.use.activeProjectId();
  // ACTIVE-org projects only — the fallback below must never resolve to (or
  // hold, via the sticky ref) a path that belongs to another organisation.
  // (`projects` further down is the thread-history grouping, not this list.)
  const orgProjects = useActiveOrgProjects();
  const activeOrganisationId = useOrgStore.use.activeOrganisationId();
  const resolvedCwd =
    project?.path ?? orgProjects.find((w) => w.id === activeProjectId)?.path ?? "";
  // STICKY cwd. It no longer keys any query — history is one app-level store —
  // but it still decides which project's threads sort to the top and which
  // directory a resumed thread binds against, and both would flicker if it
  // collapsed to "" for a render. Even with the project fallback,
  // `currentProject` and
  // `activeProjectId`/`orgProjects` can momentarily DISAGREE mid-switch,
  // collapsing `resolvedCwd` to "" for a render or two. Hold the last NON-EMPTY
  // cwd across those blips; only clear it when there is genuinely no project
  // open (zero projects).
  const lastCwdRef = useRef("");
  // The sticky hold must not survive an ORG switch — it would pin the
  // outgoing org's cwd (and thus its thread ordering) into the new org while
  // teardown has everything transiently null. Reset it the moment the org
  // changes, render-synchronously.
  const lastOrgRef = useRef(activeOrganisationId);
  if (lastOrgRef.current !== activeOrganisationId) {
    lastOrgRef.current = activeOrganisationId;
    lastCwdRef.current = "";
  }
  if (resolvedCwd) {
    lastCwdRef.current = resolvedCwd;
  } else if (orgProjects.length === 0) {
    lastCwdRef.current = "";
  }
  const cwd = lastCwdRef.current;

  // Stable signature string of the slim per-tab fields the sidebar reads.
  // Returning a primitive means zustand's default Object.is equality short-
  // circuits cleanly — the sidebar only re-runs its render when one of the
  // tracked fields actually changes, NOT on every streaming chunk (those
  // mutate `messages[].content` and don't touch any field in the signature).
  //
  // The earlier `useShallow(... -> Record<TabId, { nested }> ...)` version
  // looked sensible but blew up: useShallow only does one-level shallow eq,
  // and the inner objects were freshly allocated per call → never equal →
  // infinite-loop re-render via useSyncExternalStore.
  const sessionsSignature = useChatStore((s) => {
    const keys = Object.keys(s.sessions).sort();
    let sig = "";
    for (const k of keys) {
      const x = s.sessions[k];
      sig +=
        k +
        "|" +
        x.title +
        "|" +
        x.status +
        "|" +
        (x.acpAgentId ?? "") +
        "|" +
        (x.acpSessionId ?? "") +
        "|" +
        x.updatedAt +
        "|" +
        (x.firstUserContent ?? "") +
        "|" +
        (x.userMessageCount ?? 0) +
        "|" +
        (x.agentType ?? "claude-code") +
        "|" +
        (x.workingDirectory ?? "") +
        "|" +
        (x.messages.length > 0 ? 1 : 0) +
        "\n";
    }
    return sig;
  });
  const tabSummaries = useMemo(() => {
    // Pull current state non-reactively. The signature above is what gates
    // recomputation; `getState()` here just gives us the rich object form.
    const sessions = useChatStore.getState().sessions;
    const out: Record<
      string,
      {
        id: string;
        title: string;
        status: string;
        acpAgentId: string | undefined;
        acpSessionId: string | undefined;
        updatedAt: string;
        firstUserContent: string;
        userMessageCount: number;
        agentType: string;
        workingDirectory: string;
        hasAnyMessage: boolean;
      }
    > = {};
    for (const [tid, sess] of Object.entries(sessions)) {
      out[tid] = {
        id: sess.id,
        title: sess.title,
        status: sess.status,
        acpAgentId: sess.acpAgentId,
        acpSessionId: sess.acpSessionId,
        updatedAt: sess.updatedAt,
        firstUserContent: sess.firstUserContent ?? "",
        userMessageCount: sess.userMessageCount ?? 0,
        agentType: sess.agentType ?? "claude-code",
        workingDirectory: sess.workingDirectory ?? "",
        hasAnyMessage: sess.messages.length > 0,
      };
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionsSignature]);
  const activeSession = tabSummaries[tabId];
  const activeAcpId = activeSession?.acpSessionId;

  const {
    replaceMessages,
    setAcpBinding,
    setAcpModels,
    setAcpConfigOptions,
    setAcpAvailableCommands,
    setSessionAgentType,
    clearSession,
    setSessionTitle,
    setTranscriptLoading,
    setResumePending,
    createSession,
    hydrateSessionSnapshot,
  } = useChatStore.use.actions();

  const chatSidebar = useLayoutStore.use.chatSidebar();
  const { setChatSidebarWidth, setChatSidebarSettledExpanded, addTab, setActiveTab } =
    useLayoutStore.use.actions();

  const [search, setSearch] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);

  // Atlas's own history — the only source. It used to be six: Claude's JSONL
  // directory, Codex's SQLite, Kilo's SQLite, the old native store, Atlas's
  // transcripts and a live ACP `session/list`, merged by session id. That
  // coupled the sidebar to four private storage formats and meant an agent
  // nobody had written a reader for had no history at all (ADR-0001).
  //
  // No polling here: the store's change event says when to re-read.
  const {
    data: projects = [],
    isLoading,
    isError: historyFailed,
    error: historyError,
    isSuccess: historyReady,
  } = useQuery({
    queryKey: [...THREAD_PROJECTS_KEY, cwd],
    queryFn: () => threadProjects(cwd),
    staleTime: 30_000,
    refetchInterval: false,
    placeholderData: keepPreviousData,
    // A history store that failed to open fails the same way on a retry; say
    // so at once instead of spinning "Loading…" through three attempts.
    retry: false,
  });

  useEffect(() => {
    const invalidate = () => {
      queryClient.invalidateQueries({ queryKey: THREAD_PROJECTS_KEY });
    };
    const unlistenPromise = onThreadsChanged(invalidate);
    window.addEventListener("focus", invalidate);
    return () => {
      unlistenPromise.then((u) => u());
      window.removeEventListener("focus", invalidate);
    };
  }, [queryClient]);

  // Pick up sessions started outside Atlas (a terminal) for the open project:
  // on mount, when the project changes, and when the window regains focus. The
  // backend debounces per cwd, so this stays cheap; the threads-changed
  // listener above refreshes the list when rows land (ADR-0001 amendment).
  useEffect(() => {
    if (!cwd) return;
    const sync = () => {
      void syncProjectThreads(cwd).catch(() => {});
    };
    sync();
    window.addEventListener("focus", sync);
    return () => window.removeEventListener("focus", sync);
  }, [cwd]);

  // The open project's threads, in the `sidebarSort` order. `threads_projects`
  // is scoped to `cwd`, so this is normally a single group; Rust already sorted
  // each group by recency, and `sortThreads` only reorders for "created". The
  // flatMap still handles several groups because the unscoped case (no
  // project open) returns them all.
  const sidebarSort = useSettingsStore((s) => s.settings.sidebarSort);
  const items = useMemo<SidebarItem[]>(
    () =>
      projects.flatMap((project) =>
        sortThreads(project.threads, sidebarSort).map((thread) =>
          itemFromThread(thread, project.name, !project.isCurrent),
        ),
      ),
    [projects, sidebarSort],
  );

  // Self-heal the project panel's persisted "Chats" list for THIS project.
  // That list (`atlas-recent-chats`) is recorded on agent activity and never
  // re-validated, so rows for sessions deleted elsewhere linger forever. Now
  // that history is one store, "does this still exist" is one lookup.
  useEffect(() => {
    if (!cwd || !historyReady) return;
    const known = new Set<string>();
    for (const project of projects) {
      for (const thread of project.threads) {
        if (thread.sessionId) known.add(thread.sessionId);
      }
    }
    const liveTabs = new Set<string>();
    for (const s of Object.values(tabSummaries)) {
      if (s.acpSessionId) known.add(s.acpSessionId);
      liveTabs.add(s.id);
    }
    const { items: recent, actions } = useRecentChatsStore.getState();
    // Grace period: a freshly-active row can be ahead of the store's own
    // change event, so judging it against a stale snapshot would purge a real
    // chat. Only rows quiet for a minute are eligible.
    const cutoff = Date.now() - 60_000;
    for (const c of recent) {
      if (c.projectPath !== cwd) continue;
      if (c.updatedAt > cutoff) continue;
      const alive = c.acpSessionId ? known.has(c.acpSessionId) : liveTabs.has(c.tabId);
      if (!alive) actions.remove(c.tabId);
    }
  }, [cwd, historyReady, projects, tabSummaries]);

  // Sessions currently busy (the card's live status, and the tab whose turn
  // its timer reads).
  // Keys MUST match the `id`s used when constructing `items` above, otherwise
  // the spinner never lights up. Once an agent session is bound we key by
  // `acpSessionId`; while it's still spawning we use the synthetic
  // `live-${tabId}` placeholder.
  const liveByKey = useMemo(() => {
    const map = new Map<string, { status: "running" | "waiting"; tabId: string }>();
    for (const [tid, s] of Object.entries(tabSummaries)) {
      if (!isBusyAgentStatus(s.status)) continue;
      const liveId = s.acpSessionId ?? `live-${s.id}`;
      map.set(`agent:${liveId}`, {
        status: s.status === "waiting" ? "waiting" : "running",
        tabId: tid,
      });
    }
    return map;
  }, [tabSummaries]);

  // A turn that just ended may have pushed a branch or opened a PR: refresh
  // that repository's pull requests, the one query every card in it shares,
  // and any pull-request surface reads open for it.
  const busyDirsRef = useRef(new Map<string, string>());
  useEffect(() => {
    const busyNow = new Map<string, string>();
    for (const [tid, s] of Object.entries(tabSummaries)) {
      if (isBusyAgentStatus(s.status)) busyNow.set(tid, s.workingDirectory);
    }
    for (const [tid, dir] of busyDirsRef.current) {
      if (!busyNow.has(tid) && dir) {
        void queryClient.invalidateQueries({ queryKey: repoPullRequestsKey(dir) });
        void invalidatePullRequestQueries(queryClient, dir);
      }
    }
    busyDirsRef.current = busyNow;
  }, [tabSummaries, queryClient]);

  // Two sections: the active list, and the Settled shelf under it — sessions
  // put away by hand or by the idle sweep, newest settled first.
  const { active: activeItems, settled: settledItems } = useMemo(
    () => splitSettled(items),
    [items],
  );

  // Rows keep their order while the pointer is over the list or focus is in
  // it: a session another process keeps writing moves to the top on every
  // write, and used to jump under the pointer just as it was clicked. Content
  // still updates live; leaving applies the real order (`use-frozen-order.ts`).
  // Each section holds its own order: a row settling out of one section is
  // not a reason to reshuffle the other.
  const { ordered, listProps: frozenListProps } = useFrozenOrder(activeItems, rowKey);
  const { ordered: settledOrdered, listProps: settledListProps } = useFrozenOrder(
    settledItems,
    rowKey,
  );
  const query = search.trim().toLowerCase();
  const filtered = useMemo(
    () => (query ? ordered.filter((it) => it.title.toLowerCase().includes(query)) : ordered),
    [ordered, query],
  );
  const settledFiltered = useMemo(
    () =>
      query
        ? settledOrdered.filter((it) => it.title.toLowerCase().includes(query))
        : settledOrdered,
    [settledOrdered, query],
  );

  // No project open: Rust marks nothing current and returns every project.
  const grouped = !projects.some((project) => project.isCurrent);
  // Where each row's project is named (`placeProjectNames`): on the card for a
  // row from another project, as headings when no project is open.
  const placements = useMemo(() => placeProjectNames(filtered, grouped), [filtered, grouped]);

  // The shelf starts collapsed, and remembers being opened (per viewer, with
  // the rest of the layout prefs). Open, it shows a page at a time; the page
  // count restarts with the project.
  const settledExpanded = chatSidebar.settledExpanded;
  const [settledPage, setSettledPage] = useState({ cwd, limit: SETTLED_SHELF_FIRST_PAGE });
  const settledLimit = settledPage.cwd === cwd ? settledPage.limit : SETTLED_SHELF_FIRST_PAGE;

  // The list is newest-first (Rust sorts by recency), so "latest" is the TOP
  // of it and the way back is up — which is why the pill shows while there is
  // something scrolled off above (`edges.top`) rather than below.
  //
  // `chatSidebar.visible` is a dep because hidden, this component stays mounted
  // and renders null: the list element is a NEW node every time the sidebar
  // reopens, and without it the hook kept listening to the detached old one —
  // the fades and the pill never showed after a ⌘⌥J toggle or a hidden start.
  const listRef = useRef<HTMLDivElement>(null);
  const edges = useScrollEdges(listRef, [
    filtered.length,
    settledFiltered.length,
    settledExpanded,
    settledLimit,
    search,
    isLoading,
    asDropdown || chatSidebar.visible,
  ]);
  const jumpToLatest = useCallback(() => {
    listRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  // Singleton model: "New chat" always starts a fresh session in the CURRENT
  // tab (never a second tab). Shared with ⌘T / the palette / the context menu.

  const handleOpenAgent = (item: SidebarItem) => {
    const storeSnapshot = useChatStore.getState().sessions;

    // Live-focus: if an open tab already holds this conversation, focus it.
    // Only a tab that still EXISTS — a closed chat leaves its session behind,
    // and focusing that dead tab id makes `setActiveTab` bounce to tab[0].
    const openTabIds = new Set(useLayoutStore.getState().tabs.map((t) => t.id));
    for (const [tid, s] of Object.entries(storeSnapshot)) {
      if (s.acpSessionId && s.acpSessionId === item.id && openTabIds.has(tid)) {
        setActiveTab(tid);
        return;
      }
    }

    // The agent that actually ran this conversation, from the row — not the
    // tab's current selection. Opening a Codex thread into a Claude tab used
    // to resume it through the wrong process.
    const resumedAgentType = AGENT_TYPE_BY_SIDEBAR[item.agent] ?? item.agent;
    const pluginId = pluginIdForAgent(resumedAgentType);
    // The thread's OWN directory. A row from another worktree resumes into the
    // worktree it belongs to, which is the point of listing it here at all.
    const threadCwd = item.cwd || cwd;

    // Decide the target tab. If the current tab is mid-flight the agent is
    // still streaming into it, so open a new tab rather than overwrite.
    const currentRunning = isBusyAgentStatus(storeSnapshot[tabId]?.status);
    const targetTabId = currentRunning
      ? `chat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
      : tabId;

    if (currentRunning) {
      addTab({
        id: targetTabId,
        type: "chat",
        title: item.title.slice(0, 40) || "Session",
        closable: true,
        dirty: false,
        data: {},
      });
      createSession(targetTabId, resumedAgentType);
      setActiveTab(targetTabId);
    }

    clearSession(targetTabId);
    setSessionAgentType(targetTabId, resumedAgentType);
    setSessionTitle(targetTabId, item.title.slice(0, 40));
    const cachedAgent = getAgentSync(pluginId);
    if (cachedAgent && item.id) {
      // Optimistic: the backend has not loaded it yet, so flag the window so a
      // send queues rather than firing at a session the manager lacks.
      setAcpBinding(targetTabId, cachedAgent.agent_id, item.id, threadCwd);
    }
    setResumePending(targetTabId, true);
    setTranscriptLoading(targetTabId, true);

    // Click-token cancellation: each click bumps the token for this tab, so
    // rapid clicks collapse instead of piling up in-flight resumes.
    const myToken = bumpLoadToken(targetTabId);
    const isStale = () => isLoadStale(targetTabId, myToken);

    void (async () => {
      await Promise.resolve();
      if (isStale()) return;

      let resumed;
      try {
        resumed = await resumeThreadFast({
          threadId: item.threadId,
          cwd: threadCwd,
          sessionId: item.id || null,
          cb: {
            paint: (msgs) => replaceMessages(targetTabId, msgs),
            onPainted: () => setTranscriptLoading(targetTabId, false),
            isStale,
          },
        });
      } catch (err) {
        if (isStale()) return;
        setResumePending(targetTabId, false);
        setTranscriptLoading(targetTabId, false);
        const stage = err instanceof ResumeError ? err.stage : "resume";
        const msg = err instanceof Error ? err.message : String(err);
        if (stage === "snapshot") {
          // The session IS open — only reading it back failed. Leave the bind,
          // and since the mode was never applied, hold sends until a pick.
          holdUnrestoredMode(targetTabId);
          toast.error(`Couldn't load session: ${msg}`);
        } else {
          // Roll the optimistic binding back: leaving `acpSessionId` pointing
          // at a session the backend never opened strands the tab, because the
          // chat panel's bind effect early-returns when a binding exists. True
          // whether the agent failed to start or failed to reopen — one call
          // did both, and neither left a session behind. The history row is
          // untouched: only the user deletes rows.
          console.warn("resume failed:", err);
          clearSession(targetTabId);
          toast.error(`Couldn't resume this session: ${msg.slice(0, 120)}`);
        }
        return;
      }
      if (isStale()) return;

      const { key, snapshot } = resumed;
      setAcpBinding(targetTabId, key.agent_id, key.session_id, threadCwd);
      // Before the send gate opens. `setResumePending(false)` is what releases
      // a queued prompt, so a mode applied after it can lose the race and the
      // first turn runs under the engine's default instead of the user's pick.
      // The session/new path guards the same race the same way.
      await applyModeOnResume(targetTabId, key, snapshot);
      if (isStale()) return;
      setResumePending(targetTabId, false);
      if (resumed.resumedWithoutHistory) {
        // Honest rather than mysterious. Any messages on screen came from
        // Atlas's own transcript, so the user can still read the conversation —
        // but the AGENT was handed none of it and won't refer back to it.
        toast.info("This agent can't replay past messages — it won't remember what's above.");
      }
      // With its subagents: the bind above cleared them, and a finished child
      // is never re-announced by a live delta — left out, a reopened chat's
      // delegated work came back as bare launching tool calls.
      hydrateSessionSnapshot(targetTabId, snapshot.status, snapshot.plan, snapshot.subagents);
      if (snapshot.available_models.length > 0) {
        setAcpModels(targetTabId, snapshot.current_model, snapshot.available_models);
      }
      setAcpAvailableCommands(targetTabId, snapshot.available_commands ?? []);
      // The knobs travel the same way (#32): the resume snapshot is the only
      // carrier for an agent that never volunteers a notification. Tagged with
      // the snapshot's own agent so a stale binding can't seed another
      // agent's pill or cache (#36).
      setAcpConfigOptions(
        targetTabId,
        snapshot.config_options ?? [],
        agentTypeFromPluginId(snapshot.plugin_id),
      );
      setTranscriptLoading(targetTabId, false);
    })();
  };

  /** Whether a tab other than this one already holds the row's session. */
  const isOpenInAnotherTab = (item: SidebarItem) => {
    if (item.kind !== "agent") return false;
    const openTabIds = new Set(useLayoutStore.getState().tabs.map((t) => t.id));
    return Object.entries(useChatStore.getState().sessions).some(
      ([tid, s]) => tid !== tabId && openTabIds.has(tid) && s.acpSessionId === item.id,
    );
  };

  const isActiveItem = (item: SidebarItem) => {
    if (item.kind === "agent") {
      // Match the active tab by the SAME id formula `items` uses for live
      // rows: bound acpSessionId, else the synthetic `live-<tabId>`. Without
      // the fallback a focused live-only session (e.g. Codex, or any chat
      // before it binds) never highlights.
      const activeId = activeAcpId ?? `live-${tabId}`;
      return item.id === activeId;
    }
    return item.id === tabId;
  };

  // Settle: onto the shelf, with a few seconds to take it back. Settling the
  // open session moves this tab on to the next active one (or a fresh session
  // when there is none) — the open session is what the user just finished
  // with, and leaving it on screen would make the shelf pointless. A row
  // already open in another tab is skipped: opening it would focus that tab
  // and leave this one showing the settled session. The target is chosen
  // BEFORE the list changes under it. Undo takes the session back off the
  // shelf and, if it was the open one, back into view.
  const handleSettleAgent = async (item: SidebarItem) => {
    const wasOpen = isActiveItem(item);
    const next = wasOpen
      ? nextAfterSettling(
          filtered.filter((row) => row.threadId === item.threadId || !isOpenInAnotherTab(row)),
          item.threadId,
        )
      : null;
    let settled: boolean;
    try {
      settled = await settleThread(item.threadId);
    } catch (err) {
      toast.error(`Couldn't settle: ${invokeErrorMessage(err)}`);
      return;
    }
    // Nothing changed (already settled, gone, or just sent to): no move, no
    // toast, nothing to undo.
    if (!settled) return;
    if (wasOpen) {
      if (next && next.threadId !== item.threadId) handleOpenAgent(next);
      else openNewAgentChat();
    }
    toast("Session settled", {
      duration: SETTLE_UNDO_MS,
      action: {
        label: "Undo",
        onClick: () => {
          void unsettleThread(item.threadId)
            .then(() => {
              if (wasOpen) handleOpenAgent(item);
            })
            .catch((err: unknown) => {
              toast.error(`Couldn't undo: ${invokeErrorMessage(err)}`);
            });
        },
      },
    });
  };

  const handleUnsettleAgent = async (item: SidebarItem) => {
    try {
      await unsettleThread(item.threadId);
    } catch (err) {
      toast.error(`Couldn't un-settle: ${invokeErrorMessage(err)}`);
    }
  };

  const handleArchiveAgent = async (item: SidebarItem) => {
    try {
      // Out of the way, not gone. The thread stays in History and comes back
      // the moment it is opened (ADR-0001: archive is a shelf, not a grave).
      await archiveThread(item.threadId);
    } catch (err) {
      toast.error(`Couldn't archive: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleDeleteAgent = async (item: SidebarItem) => {
    if (!(await confirmDeleteChat(item.title))) return;
    try {
      // One call for every agent. Atlas's own row goes first and always; the
      // agent is asked to forget its copy only if it advertised that it can
      // (ADR-0001). No per-agent branch, and no path into anyone's storage.
      await deleteThread(item.threadId);
      if (activeAcpId === item.id) clearSession(tabId);
      // The project panel's "Chats" list is a separate persisted store,
      // recorded on agent activity and never re-validated — purge the deleted
      // session's row so it doesn't linger there.
      useRecentChatsStore.getState().actions.removeBySession(item.id);
    } catch (err) {
      console.error("Failed to delete session:", err);
      toast.error(`Couldn't delete session: ${invokeErrorMessage(err)}`);
    }
  };

  // Stable per-card handlers, so the memoised cards do not all re-render with
  // the list. They look the row up by thread id and call the latest handler
  // through a ref (the handlers close over this render's cwd and tab).
  const itemsByThreadRef = useRef(new Map<string, SidebarItem>());
  itemsByThreadRef.current = new Map(items.map((it) => [it.threadId, it]));
  const handlersRef = useRef({
    open: handleOpenAgent,
    settle: handleSettleAgent,
    unsettle: handleUnsettleAgent,
    archive: handleArchiveAgent,
    remove: handleDeleteAgent,
    onOpened,
  });
  handlersRef.current = {
    open: handleOpenAgent,
    settle: handleSettleAgent,
    unsettle: handleUnsettleAgent,
    archive: handleArchiveAgent,
    remove: handleDeleteAgent,
    onOpened,
  };
  // What the settle chord acts on. Written after commit, not during render:
  // a concurrent render React throws away would otherwise leave the chord
  // pointing at a session this tab never showed.
  const openItem = items.find(isActiveItem);
  const openItemRef = useRef<SidebarItem | undefined>(undefined);
  useLayoutEffect(() => {
    openItemRef.current = openItem;
  }, [openItem]);
  const onOpenCard = useCallback((threadId: string) => {
    const item = itemsByThreadRef.current.get(threadId);
    if (!item) return;
    handlersRef.current.open(item);
    // Dismiss the picker; the sidebar variant stays put.
    handlersRef.current.onOpened?.();
  }, []);
  const onSettleCard = useCallback((threadId: string) => {
    const item = itemsByThreadRef.current.get(threadId);
    if (item) void handlersRef.current.settle(item);
  }, []);
  const onUnsettleCard = useCallback((threadId: string) => {
    const item = itemsByThreadRef.current.get(threadId);
    if (item) void handlersRef.current.unsettle(item);
  }, []);

  // The settle chord (`chat.settleSession`) acts on this tab's open session:
  // settles it and moves on, or brings it back off the shelf. Registered by
  // the sidebar proper — hidden, it is still mounted — and not by the
  // picker, which is the same list for a moment.
  useEffect(() => {
    if (asDropdown) return;
    return registerSettleAndAdvance(tabId, () => {
      const item = openItemRef.current;
      if (!item) {
        toast.info("Nothing to settle: this session has no messages yet.");
        return;
      }
      void (item.settledAt ? handlersRef.current.unsettle(item) : handlersRef.current.settle(item));
    });
  }, [asDropdown, tabId]);

  const onArchiveCard = useCallback((threadId: string) => {
    const item = itemsByThreadRef.current.get(threadId);
    if (item) void handlersRef.current.archive(item);
  }, []);
  const onDeleteCard = useCallback((threadId: string) => {
    const item = itemsByThreadRef.current.get(threadId);
    if (item) void handlersRef.current.remove(item);
  }, []);

  // --- Resize handle ---
  const containerRef = useRef<HTMLDivElement>(null);
  const resizeStartXRef = useRef<number | null>(null);
  const resizeStartWidthRef = useRef<number>(0);

  const onResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      // Guard against a second drag starting before the first's mouseup
      // cleanup runs (e.g. rapid double-mousedown) — that would stack two
      // `mousemove` listeners and move the handle double-distance per pixel.
      if (resizeStartXRef.current !== null) return;
      resizeStartXRef.current = e.clientX;
      resizeStartWidthRef.current = chatSidebar.width;
      const onMove = (ev: MouseEvent) => {
        if (resizeStartXRef.current === null) return;
        const delta = ev.clientX - resizeStartXRef.current;
        setChatSidebarWidth(resizeStartWidthRef.current + delta);
      };
      const onUp = () => {
        resizeStartXRef.current = null;
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [chatSidebar.width, setChatSidebarWidth],
  );

  if (!asDropdown && !chatSidebar.visible) {
    return null;
  }

  // An error is not an empty list: a history store that failed to open says so.
  const showError = historyFailed && projects.length === 0;
  const showEmpty =
    !isLoading && !showError && filtered.length === 0 && settledFiltered.length === 0;

  // What the shelf shows. A search looks through all of it, open or not. Open,
  // a page at a time. Collapsed, only the rows that need to be seen: the open
  // session, and any that came alive again — running, waiting on the user, or
  // live in another process. Outside activity does not un-settle a session,
  // but it must not be buried behind a shut shelf either.
  const needsSight = (item: SidebarItem) => {
    if (isActiveItem(item) || item.liveElsewhere) return true;
    const status = liveByKey.get(`${item.kind}:${item.id}`)?.status;
    return status === "running" || status === "waiting";
  };
  const shelfRows = query
    ? settledFiltered
    : settledExpanded
      ? settledFiltered.slice(0, settledLimit)
      : settledFiltered.filter(needsSight);
  const shelfHidden = query ? 0 : settledFiltered.length - shelfRows.length;
  const shelfOpen = settledExpanded || !!query;

  const renderCard = (item: SidebarItem, showProject: boolean) => {
    const live = liveByKey.get(`${item.kind}:${item.id}`);
    return (
      <SessionCard
        key={item.threadId}
        threadId={item.threadId}
        title={item.title}
        projectName={item.projectName}
        showProject={showProject}
        branch={item.branch}
        cwd={item.cwd}
        lastUpdated={item.lastUpdated}
        status={live?.status ?? null}
        liveTabId={live?.tabId ?? null}
        active={isActiveItem(item)}
        agent={item.agent}
        liveElsewhere={item.liveElsewhere}
        settledAt={item.settledAt}
        onOpen={onOpenCard}
        onSettle={onSettleCard}
        onUnsettle={onUnsettleCard}
        onArchive={onArchiveCard}
        onDelete={onDeleteCard}
      />
    );
  };

  return (
    <div
      ref={containerRef}
      style={asDropdown ? undefined : { width: chatSidebar.width }}
      className={cn(
        "relative flex flex-col",
        asDropdown
          ? "h-[min(420px,60vh)] w-[340px]"
          : "shrink-0 h-full border-r border-[var(--border)] bg-[var(--sidebar)]",
      )}
    >
      {/* Search — full-width row matching the GitHub panel's search */}
      <div
        className={cn(
          "flex items-center gap-1.5 h-[32px] shrink-0 px-3",
          // The dropdown sits on a blurred, translucent panel — an opaque fill
          // here would punch a solid rectangle through the blur.
          asDropdown
            ? "border-b border-[var(--atlas-element-hover)]"
            : "border-b border-border bg-background",
        )}
      >
        <Search size={11} className="text-muted-foreground shrink-0" />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Search sessions"
          placeholder="Search…"
          className="flex-1 bg-transparent outline-none text-xs text-foreground placeholder:text-muted-foreground min-w-0"
        />
        {/* Everything ever, archived included — and where import lives. */}
        {!asDropdown && (
          <Hint label="All history — archived threads, and import">
            <button
              type="button"
              onClick={() => setHistoryOpen(true)}
              aria-label="All history"
              className="shrink-0 flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-element-hover hover:text-foreground transition-colors cursor-pointer"
            >
              <History size={11} />
            </button>
          </Hint>
        )}
      </div>
      <ThreadHistoryView
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        onOpenThread={(thread) => handleOpenAgent(itemFromThread(thread, thread.projectName))}
      />

      {/* List. The wrapper is what the fades and the jump pill are positioned
          against — inside the scroller they would scroll away with the rows.
          `min-h-0` so the scroller actually scrolls instead of growing the
          column past the panel. */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          ref={listRef}
          data-testid="session-list"
          className={cn(
            "flex flex-1 flex-col gap-1.5 overflow-y-auto p-2 hide-scrollbar",
            // The dropdown gets a mask instead of the sidebar's colour fades:
            // its panel is blurred, and an opaque gradient over it would be a
            // solid strip. Clipped mid-row with nothing, the list reads as
            // finished when it is not.
            asDropdown && "atlas-scroll-mask-b",
          )}
          // The active rows hold their order while the pointer is anywhere
          // over the list; the shelf's rows hold theirs while it is over the
          // shelf.
          {...frozenListProps}
        >
          {isLoading && <div className="px-1 py-1 text-xs text-muted-foreground">Loading…</div>}
          {showError && (
            <div role="alert" className="px-1 py-1 text-xs leading-relaxed text-error">
              Couldn't load chats: {errorMessage(historyError)}
            </div>
          )}
          {showEmpty && (
            <div className="px-1 py-1 text-xs leading-relaxed text-muted-foreground">
              {/* Names the scope: the list is this project's, so an empty one
                means "nothing here yet", not "no chats anywhere". Other
                projects' chats are behind the History button in the header. */}
              {search.trim() ? "No sessions match your search." : "No chats in this project yet."}
            </div>
          )}
          <div className="flex flex-col gap-1.5">
            {filtered.map((item, index) => {
              const { heading, showProject } = placements[index]!;
              const card = renderCard(item, showProject);
              if (!heading) return card;
              return (
                <Fragment key={item.threadId}>
                  <div
                    role="heading"
                    aria-level={3}
                    className={cn(
                      "-mx-2 truncate px-3 pt-1.5 pb-0.5 text-3xs font-medium uppercase tracking-wider text-muted-foreground",
                      // Sticky in the sidebar, where the list sits on the opaque
                      // sidebar fill; the dropdown's panel is translucent and
                      // blurred, and a sticky fill there would punch through it.
                      !asDropdown && "sticky top-0 z-panel bg-[var(--sidebar)]",
                    )}
                  >
                    {heading}
                  </div>
                  {card}
                </Fragment>
              );
            })}
          </div>

          {/* The Settled shelf, under everything active. Collapsed by default;
              a search reaches into it either way. */}
          {settledFiltered.length > 0 && (
            <div
              data-testid="settled-shelf"
              className="mt-1 flex flex-col gap-1.5"
              {...settledListProps}
            >
              <button
                type="button"
                onClick={() => setChatSidebarSettledExpanded(!settledExpanded)}
                aria-expanded={shelfOpen}
                disabled={!!query}
                className="flex cursor-pointer items-center gap-1 rounded-sm px-1 py-0.5 text-left text-3xs font-medium uppercase tracking-wider text-muted-foreground hover:text-foreground disabled:cursor-default disabled:hover:text-muted-foreground"
              >
                <ChevronRight
                  size={10}
                  aria-hidden
                  className={cn("transition-transform duration-fast", shelfOpen && "rotate-90")}
                />
                Settled
                <span className="tabular-nums">{settledFiltered.length}</span>
              </button>
              {/* A settled row from another project is named on its card, and
                  so is every one when no project is open: the shelf has no
                  headings of its own. */}
              {shelfRows.map((item) => renderCard(item, grouped || item.elsewhere))}
              {settledExpanded && shelfHidden > 0 && (
                <button
                  type="button"
                  onClick={() => setSettledPage({ cwd, limit: settledLimit + SETTLED_SHELF_PAGE })}
                  className="cursor-pointer self-start rounded-sm px-1 py-0.5 text-2xs text-muted-foreground hover:text-foreground"
                >
                  Show {Math.min(shelfHidden, SETTLED_SHELF_PAGE)} more
                </button>
              )}
            </div>
          )}
        </div>

        {/* Edge fades, and the way back to the top. Sidebar only: the
            dropdown's panel is translucent and blurred, and an opaque
            gradient over it punches a solid strip through the blur — the same
            rule the search row and the sticky headings follow. */}
        {!asDropdown && (
          <>
            <ScrollFade className={LIST_FADE} at="top" visible={edges.top} />
            <ScrollFade className={LIST_FADE} at="bottom" visible={edges.bottom} />
          </>
        )}
        <JumpToLatest visible={edges.top} onJump={jumpToLatest} />
      </div>

      {/* Resize handle — subtle, matches main panel handles. The dropdown has
          its own fixed size, so it has nothing to resize. */}
      {!asDropdown && (
        <div
          onMouseDown={onResizeStart}
          className="absolute top-0 -right-px w-px h-full bg-border hover:bg-primary transition-colors cursor-col-resize"
          title="Drag to resize"
        />
      )}
    </div>
  );
});
