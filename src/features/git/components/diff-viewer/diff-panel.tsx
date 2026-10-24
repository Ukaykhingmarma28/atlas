import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { Group, Panel, Separator, useDefaultLayout } from "react-resizable-panels";
import type { CodeViewDiffItem, FileDiffContentsLoader, FileDiffMetadata } from "@pierre/diffs";
import type { CodeViewHandle } from "@pierre/diffs/react";
import {
  AlertCircle,
  ArrowRight,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Columns2,
  FolderTree,
  Info,
  Pilcrow,
  RefreshCw,
  Rows3,
  Settings2,
  WrapText,
} from "lucide-react";
import { openReviewFile } from "../../lib/open-review-file";
import { Button } from "@/ui/button";
import { IconButton } from "@/ui/icon-button";
import { Segmented } from "@/ui/segmented";
import { useScopedHotkeys } from "@/features/keybindings/lib/use-scoped-hotkeys";
import { Hint } from "@/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { formatTime } from "@/lib/format-time";
import { cn } from "@/lib/utils";
import type { EditTurn } from "@/features/chat/lib/turn-edits";
import { useSettingsStore } from "@/features/settings/stores/settings-store";
import { useWordWrap } from "@/features/settings/lib/use-word-wrap";
import { useSessionFiles } from "@/features/chat/lib/session-files";
import { getDiffFileContents, getDiffPreview, type DiffSource } from "../../lib/git-review-api";
import { buildFileDiffContentVersion, fnv1a32 } from "../../lib/diff-rendering";
import { FileViewedContext, FileViewedToggle, type FileViewedState } from "./file-viewed-toggle";
import { invalidateReviewFiles, useReviewFiles, type ReviewFile } from "../../lib/use-review-files";
import {
  combineReviews,
  useAttachedRootReviews,
  useSessionTouchedPaths,
} from "../../lib/use-root-review";
import { useSessionRoots } from "@/features/chat/hooks/use-session-roots";
import { isAbsolutePath } from "@/features/chat/lib/open-turn-diff";
import { useDiffJump } from "../../lib/diff-jump";
import {
  useSessionEditTurns,
  useTurnEdits,
  useTurnReviewFiles,
} from "../../lib/use-turn-review-files";
import {
  collapsedSetOf,
  LATEST_TURN,
  useDiffPanelStore,
  type DiffLayout,
  type DiffScope,
  type ViewedMark,
} from "../../stores/diff-panel-store";
import { useGitStore } from "../../stores/git-store";
import { StyledCodeView } from "./styled-code-view";
import { DiffFileTree } from "./diff-file-tree";
import { CopyPathButton } from "./copy-path-button";
import { DiffPanelSkeleton } from "./diff-panel-skeleton";
import { DiffFindBar, type DiffFindHandle } from "./diff-find-bar";
import { formatCompactCount } from "../../lib/format-compact-count";

/**
 * The review diff: every changed file of the working tree or the branch,
 * stacked in one virtualized viewer, beside a tree of the files.
 *
 * Data: `getDiffPreview` answers both sources at once with a capped patch and
 * a complete file list; `useReviewFiles` fills in the files the cap left out,
 * one at a time as their rows come into view. Beside a session there is also
 * the turn scope, which reads no git at all: one turn's own edits, diffed from
 * the texts its tool calls carried (`use-turn-review-files.ts`). Rendering: `StyledCodeView`,
 * which tokenizes in a worker pool and never on this thread.
 */

const SCOPE_LABEL: Record<DiffScope, string> = {
  session: "This session",
  turn: "Latest turn",
  "working-tree": "Uncommitted",
  "branch-range": "Branch",
};

const LAYOUT_OPTIONS = [
  { value: "unified", label: "Stacked diff view", icon: <Rows3 size={12} />, iconOnly: true },
  { value: "split", label: "Split diff view", icon: <Columns2 size={12} />, iconOnly: true },
] as const;

/** `+12 −3`, in the diff palette's colours, compact past a thousand. */
const DiffStat = memo(function DiffStat({
  additions,
  deletions,
  className,
}: {
  additions: number;
  deletions: number;
  className?: string;
}) {
  return (
    <span
      role="group"
      aria-label={`${additions} additions, ${deletions} deletions`}
      className={cn("inline-flex items-center gap-1 font-mono text-2xs tabular-nums", className)}
    >
      <span aria-hidden className="text-[var(--atlas-diff-added-text)]">
        +{formatCompactCount(additions)}
      </span>
      <span aria-hidden className="text-[var(--atlas-diff-removed-text)]">
        −{formatCompactCount(deletions)}
      </span>
    </span>
  );
});

/** The scope menu's value for the turn the panel follows. */
const turnValue = (turn: string) => `turn:${turn}`;

/** Hide the viewer's own +/- counts: it counts only what has loaded, and a
 *  pending file would read +0 −0. The header shows the backend's numstat. */
const HIDE_VIEWER_COUNTS = "[data-additions-count], [data-deletions-count] { display: none; }";

const itemIdOf = (file: ReviewFile) => `${file.stat.oldPath ?? ""}\0${file.stat.path}`;

/** The tree beside the diff: its width is saved under this. */
const TREE_LAYOUT_ID = "git-review-diff-tree";

/** A file header's counts, written the way the viewer writes its own: removals
 *  first, and a side with nothing in it left out (`-8`, `-36 +1`, `+12`). The
 *  viewer's own are hidden ({@link HIDE_VIEWER_COUNTS}) because they count
 *  only what has loaded; these are the backend's numstat. */
const HeaderStat = memo(function HeaderStat({
  additions,
  deletions,
}: {
  additions: number;
  deletions: number;
}) {
  const showDeletions = deletions > 0 || additions === 0;
  const showAdditions = additions > 0 || deletions === 0;
  return (
    <span
      role="group"
      aria-label={`${additions} additions, ${deletions} deletions`}
      className="inline-flex items-center gap-1 font-mono text-xs tabular-nums"
    >
      {showDeletions && (
        <span aria-hidden className="text-[var(--atlas-diff-removed-text)]">
          -{formatCompactCount(deletions)}
        </span>
      )}
      {showAdditions && (
        <span aria-hidden className="text-[var(--atlas-diff-added-text)]">
          +{formatCompactCount(additions)}
        </span>
      )}
    </span>
  );
});

/** The fold chevron takes the colour of the change, as the round icon beside
 *  it does: added, removed, or modified (a rename included). */
function chevronToneOf(fileDiff: FileDiffMetadata): string {
  switch (fileDiff.type) {
    case "new":
      return "text-[var(--atlas-diff-added-text)]";
    case "deleted":
      return "text-[var(--atlas-diff-removed-text)]";
    case "change":
    case "rename-pure":
    case "rename-changed":
      return "text-[var(--atlas-diff-modified-text)]";
    default:
      return "text-muted-foreground";
  }
}

/** Per-object memo of the content hash: re-hashing every line of every file on
 *  every render would cost more than the render. A parsed file's cache key
 *  already is its content hash (`withContentCacheKey`), so it is reused. */
const versionCache = new WeakMap<FileDiffMetadata, number>();
function contentVersion(fileDiff: FileDiffMetadata): number {
  let v = versionCache.get(fileDiff);
  if (v === undefined) {
    v = fileDiff.cacheKey ? fnv1a32(fileDiff.cacheKey) : buildFileDiffContentVersion(fileDiff);
    versionCache.set(fileDiff, v);
  }
  return v;
}

/** What a "Viewed" mark remembers of a file: its diff's content, free of the
 *  scope-specific cache key, so the capped patch and a lazily loaded one of
 *  the same change agree. `null` until the diff has loaded. */
const signatureCache = new WeakMap<FileDiffMetadata, number>();
function viewedSignature(file: ReviewFile): number | null {
  if (file.state !== "ready") return null;
  let sig = signatureCache.get(file.fileDiff);
  if (sig === undefined) {
    sig = buildFileDiffContentVersion(file.fileDiff);
    signatureCache.set(file.fileDiff, sig);
  }
  return sig;
}

const NO_VIEWED: Record<string, ViewedMark> = {};

/** Marked viewed, and the diff now on screen is not the one that was read. A
 *  mark from another whitespace mode, or made before the diff loaded, cannot
 *  tell, so it is not called stale. */
function isStaleMark(mark: ViewedMark | undefined, file: ReviewFile | undefined, ws: boolean) {
  if (!mark || !file || mark.sig === null || mark.ws !== ws) return false;
  const sig = viewedSignature(file);
  return sig !== null && sig !== mark.sig;
}

export interface DiffPanelProps {
  /** The tab this panel is, so `requestDiffJump` can steer it. */
  tabId: string;
  repoPath: string;
  /** Offer (and default to) the files this agent session touched. */
  sessionId?: string | null;
  /** Source-control actions (commit, push, branch) go here when they land. */
  actions?: ReactNode;
  /** Heads the header. */
  leading?: ReactNode;
  /**
   * A "Viewed" box on every file header and an "X / N viewed" count: a pull
   * request's review, where the reader works through the files. Off beside a
   * session, whose diff is read, not signed off.
   */
  viewedMarks?: boolean;
}

export function DiffPanel({
  tabId,
  repoPath,
  sessionId = null,
  actions,
  leading,
  viewedMarks: viewedMarksOn = false,
}: DiffPanelProps) {
  // The git scopes the menu lists as items; `turn` has its own entries.
  const scopes: DiffScope[] = sessionId
    ? ["session", "working-tree", "branch-range"]
    : ["working-tree", "branch-range"];
  const storedScope = useDiffPanelStore((s) => s.scope[tabId]);
  const scope =
    storedScope && (scopes.includes(storedScope) || (storedScope === "turn" && sessionId))
      ? storedScope
      : scopes[0];
  const turnChoice = useDiffPanelStore((s) => s.turn[tabId] ?? LATEST_TURN);
  const baseRef = useDiffPanelStore((s) => s.baseRef[repoPath] ?? null);
  const layout = useDiffPanelStore.use.layout();
  // The global `wordWrap` setting: the button below flips it for file tabs too.
  const { wrap: wordWrap, toggle: toggleWordWrap } = useWordWrap();
  const fileTreeOpen = useDiffPanelStore.use.fileTreeOpen();
  const storedWhitespace = useDiffPanelStore.use.ignoreWhitespace();
  const settingWhitespace = useSettingsStore((s) => s.settings.diffIgnoreWhitespace);
  const ignoreWhitespace = storedWhitespace ?? settingWhitespace;
  const collapseByDefault = useSettingsStore((s) => s.settings.diffFilesCollapsed);
  const actionsApi = useDiffPanelStore.use.actions();

  const preview = useQuery({
    queryKey: ["git-diff-preview", repoPath, baseRef, ignoreWhitespace],
    queryFn: () => getDiffPreview(repoPath, { baseRef: baseRef ?? undefined, ignoreWhitespace }),
    enabled: !!repoPath,
    placeholderData: keepPreviousData,
    staleTime: 2_000,
  });
  const { refetch } = preview;

  // Live: the git watcher fires on commit/stage/checkout, the explorer on any
  // write under the project. Coalesced, since an edit is a burst of events.
  const queryClient = useQueryClient();
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const soon = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void refetch(), 250);
    };
    const offGit = listen<{ project: string }>("atlas:git-changed", (e) => {
      if (e.payload?.project !== repoPath) return;
      // HEAD may have moved under files whose patches are cached by what is
      // on disk; those keys cannot see it.
      invalidateReviewFiles(queryClient, repoPath);
      soon();
    });
    const offFs = listen<{ dirs?: string[]; fullRefresh?: boolean }>(
      "atlas:explorer:changed",
      (e) => {
        const dirs = e.payload?.dirs;
        // An opaque batch (a rename) names no directories: assume it is ours.
        const ours =
          e.payload?.fullRefresh ||
          !dirs?.length ||
          dirs.some((d) => d === repoPath || d.startsWith(`${repoPath}/`));
        if (ours) soon();
      },
    );
    return () => {
      if (timer) clearTimeout(timer);
      void offGit.then((off) => off());
      void offFs.then((off) => off());
    };
  }, [repoPath, refetch, queryClient]);

  const sourceKind = scope === "branch-range" ? "branch-range" : "working-tree";
  const source: DiffSource | null =
    preview.data?.sources.find((s) => s.kind === sourceKind) ?? null;

  const sessionFiles = useSessionFiles(
    scope === "session" ? repoPath : null,
    scope === "session" ? sessionId : null,
  );
  const only = useMemo(
    () =>
      scope === "session"
        ? new Set(sessionFiles.filter((f) => !f.outOfRepo).map((f) => f.path))
        : null,
    [scope, sessionFiles],
  );

  // ── The turn scope: one turn's own edits, from the session's message log ──
  // Walked only while something shows them: the turn scope, or its picker.
  const [scopeMenuOpen, setScopeMenuOpen] = useState(false);
  const turns = useSessionEditTurns(sessionId, repoPath, scope === "turn" || scopeMenuOpen);
  const latestTurn = turns[0] ?? null;
  const selectedTurn =
    scope !== "turn"
      ? null
      : turnChoice === LATEST_TURN
        ? latestTurn
        : (turns.find((t) => t.turnId === turnChoice) ?? null);
  const turnEdits = useTurnEdits(sessionId, selectedTurn?.turnId ?? null, repoPath);
  const turnReview = useTurnReviewFiles({ edits: turnEdits, ignoreWhitespace });

  const gitReview = useReviewFiles({
    repoPath,
    source: scope === "turn" ? null : source,
    only,
    ignoreWhitespace,
  });
  const baseReview = scope === "turn" ? turnReview : gitReview;

  // ── The session's other roots: its attached projects' working trees, and
  // a turn's files grouped by the root that holds them (`use-root-review.ts`).
  // Beside no session there are none, and the list is the main review's. ──
  const roots = useSessionRoots(sessionId, repoPath);
  const attachedRoots = useMemo(
    () => (sessionId ? roots.filter((r) => r.kind === "attached") : []),
    [roots, sessionId],
  );
  const touchedByAgent = useSessionTouchedPaths(scope === "session" ? sessionId : null);
  const touched = useMemo(() => {
    if (scope !== "session") return null;
    const set = new Set(touchedByAgent ?? []);
    // The record's files outside the main project carry their own path.
    for (const f of sessionFiles) if (f.outOfRepo && isAbsolutePath(f.path)) set.add(f.path);
    return set as ReadonlySet<string>;
  }, [scope, touchedByAgent, sessionFiles]);
  const attachedReview = useAttachedRootReviews({
    roots: attachedRoots,
    kind: scope === "turn" ? null : sourceKind,
    touched,
    ignoreWhitespace,
  });
  // An attached project's repository moving (a commit, a checkout) re-reads
  // its preview, as the main project's does above.
  const refetchAttached = useRef(attachedReview.refetch);
  refetchAttached.current = attachedReview.refetch;
  const attachedKey = attachedRoots.map((r) => r.path).join("\0");
  useEffect(() => {
    if (!attachedKey) return;
    const paths = new Set(attachedKey.split("\0"));
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = listen<{ project: string }>("atlas:git-changed", (e) => {
      const project = e.payload?.project;
      if (!project || !paths.has(project)) return;
      invalidateReviewFiles(queryClient, project);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => refetchAttached.current(), 250);
    });
    return () => {
      if (timer) clearTimeout(timer);
      void off.then((u) => u());
    };
  }, [attachedKey, queryClient]);
  const combined = useMemo(
    () => combineReviews(baseReview.files, scope === "turn" ? [] : attachedReview.reviews, roots),
    [baseReview.files, attachedReview.reviews, roots, scope],
  );
  const { files, stats: treeFiles } = combined;

  // Loading and retrying go to the review the file came from, by the path it
  // knows the file by. Stable: every pending row's header holds them.
  const routeRef = useRef({ combined, baseReview, attached: attachedReview.reviews });
  routeRef.current = { combined, baseReview, attached: attachedReview.reviews };
  const requestFile = useCallback((key: string) => {
    const { combined, baseReview, attached } = routeRef.current;
    const info = combined.keys.get(key);
    if (info && info.slot >= 0) attached[info.slot]?.review.requestFile(info.orig);
    else baseReview.requestFile(info?.orig ?? key);
  }, []);
  const retry = useCallback((key: string) => {
    const { combined, baseReview, attached } = routeRef.current;
    const info = combined.keys.get(key);
    if (info && info.slot >= 0) attached[info.slot]?.review.retry(info.orig);
    else baseReview.retry(info?.orig ?? key);
  }, []);

  const collapseScopeKey =
    scope === "turn"
      ? `${repoPath}\0turn\0${selectedTurn?.turnId ?? ""}\0${sessionId ?? ""}`
      : `${repoPath}\0${scope}\0${baseRef ?? ""}\0${sessionId ?? ""}`;
  const scopeLabel =
    scope !== "turn"
      ? SCOPE_LABEL[scope]
      : selectedTurn && selectedTurn !== latestTurn
        ? `Turn ${selectedTurn.number}`
        : SCOPE_LABEL.turn;
  const itemIds = useMemo(() => files.map(itemIdOf), [files]);
  const defaultCollapsed = useMemo<ReadonlySet<string>>(
    () => new Set(collapseByDefault && itemIds.length > 1 ? itemIds : []),
    [collapseByDefault, itemIds],
  );
  const storedCollapsed = useDiffPanelStore((s) => s.collapsed[collapseScopeKey]);
  const collapsed = useMemo(
    () => collapsedSetOf(storedCollapsed, defaultCollapsed),
    [storedCollapsed, defaultCollapsed],
  );
  const updateCollapsed = useCallback(
    (update: (current: ReadonlySet<string>) => ReadonlySet<string>) =>
      actionsApi.updateCollapsed(collapseScopeKey, defaultCollapsed, update),
    [actionsApi, collapseScopeKey, defaultCollapsed],
  );
  const toggleFile = useCallback(
    (id: string) =>
      updateCollapsed((current) => {
        const next = new Set(current);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }),
    [updateCollapsed],
  );
  const allCollapsed = itemIds.length > 0 && itemIds.every((id) => collapsed.has(id));
  const toggleAll = () => updateCollapsed(() => (allCollapsed ? new Set() : new Set(itemIds)));

  const fileById = useMemo(() => new Map(files.map((f) => [itemIdOf(f), f])), [files]);
  const fileByPath = useMemo(() => new Map(files.map((f) => [f.stat.path, f])), [files]);

  // ── Viewed: per scope and path, remembered across relaunches. Only where
  // the panel offers it (`viewedMarks`): elsewhere no mark is read, so none
  // reaches a header or an item's version. ──
  const viewedMarks = useDiffPanelStore((s) =>
    viewedMarksOn ? (s.viewed[collapseScopeKey] ?? NO_VIEWED) : NO_VIEWED,
  );
  const isViewed = useCallback((path: string) => path in viewedMarks, [viewedMarks]);
  const isStale = useCallback(
    (path: string) => isStaleMark(viewedMarks[path], fileByPath.get(path), ignoreWhitespace),
    [viewedMarks, fileByPath, ignoreWhitespace],
  );
  const setViewed = useCallback(
    (id: string, path: string, viewed: boolean) => {
      const file = fileByPath.get(path);
      actionsApi.setViewed(
        collapseScopeKey,
        path,
        viewed ? { sig: file ? viewedSignature(file) : null, ws: ignoreWhitespace } : null,
      );
      // Marking a file viewed folds it; unmarking opens it again.
      updateCollapsed((current) => {
        if (current.has(id) === viewed) return current;
        const next = new Set(current);
        if (viewed) next.add(id);
        else next.delete(id);
        return next;
      });
    },
    [actionsApi, collapseScopeKey, fileByPath, ignoreWhitespace, updateCollapsed],
  );
  const viewedState = useMemo<FileViewedState>(
    () => ({ isViewed, isStale, setViewed }),
    [isViewed, isStale, setViewed],
  );
  const viewedCount = useMemo(
    () => files.reduce((n, f) => (f.stat.path in viewedMarks ? n + 1 : n), 0),
    [files, viewedMarks],
  );

  const items = useMemo<CodeViewDiffItem[]>(
    () =>
      files.map((file) => {
        const id = itemIdOf(file);
        const folded = file.state !== "ready" || collapsed.has(id);
        const path = file.stat.path;
        const mark = viewedMarks[path];
        const viewedMark = mark ? (isStaleMark(mark, file, ignoreWhitespace) ? "s" : "v") : "";
        return {
          id,
          type: "diff",
          fileDiff: file.fileDiff,
          collapsed: folded,
          version: fnv1a32(
            `${contentVersion(file.fileDiff)}:${folded ? 1 : 0}:${file.state}:${viewedMark}`,
          ),
        };
      }),
    [files, collapsed, viewedMarks, ignoreWhitespace],
  );

  // Expanding the unchanged lines around a hunk needs both whole sides.
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const loadDiffFiles = useCallback<FileDiffContentsLoader>(
    async (fileDiff) => {
      const path = fileDiff.name;
      const oldPath = fileDiff.prevName ?? path;
      // An attached project's file is read from its own repository, by its
      // path there; the viewer knows it by its key.
      const { combined, attached } = routeRef.current;
      const info = combined.keys.get(path);
      const slot = info && info.slot >= 0 ? attached[info.slot] : null;
      const current = slot ? slot.source : sourceRef.current;
      if (!current) throw new Error("No diff source to load from.");
      const contents = await getDiffFileContents(slot ? slot.root.path : repoPath, {
        sourceKind: current.kind,
        baseRef: current.mergeBase ?? current.baseRef,
        filePath: info?.orig ?? path,
        oldPath: fileDiff.prevName ? (info?.origOld ?? fileDiff.prevName) : null,
      });
      // Keyed by content, so an unchanged side stays cached across refreshes.
      const keyOf = (name: string, text: string) =>
        `review-full:${name}:${text.length}:${fnv1a32(text).toString(36)}`;
      const newFile = {
        name: path,
        contents: contents.newText,
        cacheKey: keyOf(path, contents.newText),
      };
      if (fileDiff.type === "rename-pure") return { oldFile: null, newFile };
      return {
        oldFile: {
          name: oldPath,
          contents: contents.oldText,
          cacheKey: keyOf(oldPath, contents.oldText),
        },
        newFile,
      };
    },
    [repoPath],
  );

  // ── Revealing a file: from the tree, or from outside (`requestDiffJump`) ──
  // The handle is held with the scope key its viewer was mounted for: the
  // viewer remounts per scope, and a jump that changes scope must not land on
  // the handle of the viewer it replaced.
  const [mounted, setMounted] = useState<{
    key: string;
    handle: CodeViewHandle<undefined, undefined>;
  } | null>(null);
  const setViewer = useCallback(
    (handle: CodeViewHandle<undefined, undefined> | null) =>
      setMounted((current) =>
        handle
          ? { key: collapseScopeKey, handle }
          : current?.key === collapseScopeKey
            ? null
            : current,
      ),
    [collapseScopeKey],
  );
  const viewer = mounted?.key === collapseScopeKey ? mounted.handle : null;
  const [selected, setSelected] = useState<string | null>(null);
  const reveal = useCallback(
    (requested: string) => {
      // A jump from outside names the file as its source does (absolute, for
      // a file outside the main project); the list keys it per root.
      const path = files.some((f) => f.stat.path === requested)
        ? requested
        : combined.keyOf(requested);
      const file = files.find((f) => f.stat.path === path);
      if (!file) return false;
      const id = itemIdOf(file);
      setSelected(path);
      if (file.state === "pending") requestFile(path);
      updateCollapsed((current) => {
        if (!current.has(id)) return current;
        const next = new Set(current);
        next.delete(id);
        return next;
      });
      viewer?.scrollTo({ type: "item", id, align: "start" });
      return true;
    },
    [files, combined, requestFile, updateCollapsed, viewer],
  );
  // ── Find (⌘F), scoped to this tab: the session beside it keeps its own ──
  const [find, setFind] = useState({ open: false, focus: 0 });
  const findRef = useRef<DiffFindHandle>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const openFind = useCallback(() => setFind((f) => ({ open: true, focus: f.focus + 1 })), []);
  const closeFind = useCallback(() => {
    setFind((f) => ({ ...f, open: false }));
    rootRef.current?.focus({ preventScroll: true });
  }, []);
  const canFind = files.length > 0;
  const unloaded = useMemo(() => files.filter((f) => f.state === "pending").length, [files]);
  useScopedHotkeys({
    tabId,
    handlers: {
      "diff.find": () => {
        if (!canFind) return false;
        openFind();
      },
    },
  });
  // Stable: what it reads is rebuilt whenever a file loads, and the find bar
  // must not see a new callback each time.
  const unfoldDeps = useRef({ fileById, requestFile, updateCollapsed });
  unfoldDeps.current = { fileById, requestFile, updateCollapsed };
  const unfold = useCallback((id: string) => {
    const { fileById, requestFile, updateCollapsed } = unfoldDeps.current;
    const file = fileById.get(id);
    if (file?.state === "pending") requestFile(file.stat.path);
    updateCollapsed((current) => {
      if (!current.has(id)) return current;
      const next = new Set(current);
      next.delete(id);
      return next;
    });
  }, []);
  // Each file's render remounts rows; the open find repaints over them.
  const repaintFind = useCallback(() => findRef.current?.repaint(), []);

  const jump = useDiffJump(tabId);
  const handledJump = useRef<number | null>(null);
  useEffect(() => {
    if (!jump || handledJump.current === jump.nonce || !viewer) return;
    if (reveal(jump.path)) handledJump.current = jump.nonce;
  }, [jump, reveal, viewer]);

  const totals = useMemo(() => {
    let additions = 0;
    let deletions = 0;
    for (const f of files) {
      additions += f.stat.additions ?? 0;
      deletions += f.stat.deletions ?? 0;
    }
    return { additions, deletions };
  }, [files]);

  const branches = useGitStore((s) => (s.repoPath === repoPath ? s.branchesFull : null));

  // The tree's width, remembered across sessions.
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({ id: TREE_LAYOUT_ID });

  const headRef = branches?.find((b) => b.isCurrent)?.name ?? "HEAD";
  // One row: what is shown on the left (scope or turn, and the refs a branch
  // diff compares), how it is shown on the right. Layout, wrap and whitespace
  // sit inline while the panel has room and fold into one menu when it does
  // not.
  const header = (
    <div className="@container flex h-control-lg shrink-0 items-center gap-2 border-b border-border-subtle px-2">
      {leading}
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <DropdownMenu onOpenChange={(open) => setScopeMenuOpen(open)}>
          <DropdownMenuTrigger
            render={
              <Button variant="secondary" size="sm" aria-label={`Diff scope: ${scopeLabel}`}>
                <span className="max-w-40 truncate">{scopeLabel}</span>
                <ChevronDown size={12} className="shrink-0 text-muted-foreground" />
              </Button>
            }
          />
          <DropdownMenuContent align="start" sideOffset={4}>
            <DropdownMenuRadioGroup
              value={
                scope !== "turn" ? scope : selectedTurn === latestTurn ? turnValue(LATEST_TURN) : ""
              }
              onValueChange={(value) => {
                const v = String(value);
                if (v.startsWith("turn:")) actionsApi.setTurn(tabId, v.slice(5));
                else actionsApi.setScope(tabId, v as DiffScope);
              }}
            >
              {scopes.map((s) => (
                <DropdownMenuRadioItem key={s} value={s} closeOnClick>
                  {SCOPE_LABEL[s]}
                </DropdownMenuRadioItem>
              ))}
              {sessionId && (
                <DropdownMenuRadioItem
                  value={turnValue(LATEST_TURN)}
                  disabled={!latestTurn}
                  closeOnClick
                >
                  {SCOPE_LABEL.turn}
                </DropdownMenuRadioItem>
              )}
            </DropdownMenuRadioGroup>
            {sessionId && (
              <TurnSubmenu
                turns={turns}
                selected={scope === "turn" ? selectedTurn : null}
                onPick={(turnId) => actionsApi.setTurn(tabId, turnId)}
              />
            )}
          </DropdownMenuContent>
        </DropdownMenu>
        {viewedMarksOn && files.length > 0 && (
          <span className="min-w-0 shrink truncate text-xs text-muted-foreground tabular-nums">
            {viewedCount} / {files.length} viewed
          </span>
        )}
        {scope === "branch-range" && (
          <div
            className="flex min-w-0 items-center gap-2 overflow-hidden text-xs text-muted-foreground"
            aria-label={`Comparing ${headRef} against ${source?.baseRef ?? "the base branch"}`}
          >
            <span className="max-w-48 min-w-0 truncate">{headRef}</span>
            <ArrowRight size={12} className="shrink-0" aria-hidden />
            <BaseRefPicker
              current={source?.baseRef ?? null}
              chosen={baseRef}
              branches={branches?.filter((b) => !b.isCurrent).map((b) => b.name) ?? []}
              onPick={(ref) => actionsApi.setBaseRef(repoPath, ref)}
            />
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {files.length > 0 && (
          <DiffStat
            additions={totals.additions}
            deletions={totals.deletions}
            className="mr-1 hidden @sm:inline-flex"
          />
        )}
        {/* A turn's edits are a record, not the disk: nothing to refresh. */}
        {scope !== "turn" && (
          <Hint label="Refresh diff">
            <IconButton
              size="sm"
              icon={RefreshCw}
              label="Refresh diff"
              disabled={preview.isFetching}
              onClick={() => {
                void refetch();
                attachedReview.refetch();
              }}
            />
          </Hint>
        )}
        {files.length > 0 && (
          <Hint label={allCollapsed ? "Expand all files" : "Collapse all files"}>
            <IconButton
              size="sm"
              icon={allCollapsed ? ChevronsUpDown : ChevronsDownUp}
              label={allCollapsed ? "Expand all files" : "Collapse all files"}
              onClick={toggleAll}
            />
          </Hint>
        )}
        <DropdownMenu>
          <Hint label="Diff options">
            <DropdownMenuTrigger
              render={
                <IconButton
                  size="sm"
                  icon={Settings2}
                  label="Diff options"
                  className="@md:hidden"
                />
              }
            />
          </Hint>
          <DropdownMenuContent align="end" sideOffset={4} className="w-48">
            <DropdownMenuRadioGroup
              value={layout}
              onValueChange={(value) => actionsApi.setLayout(value as DiffLayout)}
            >
              <DropdownMenuRadioItem value="unified" closeOnClick>
                Stacked
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="split" closeOnClick>
                Split
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuCheckboxItem checked={wordWrap} onCheckedChange={toggleWordWrap}>
              Wrap lines
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem
              checked={ignoreWhitespace}
              onCheckedChange={(checked) => actionsApi.setIgnoreWhitespace(checked)}
            >
              Hide whitespace changes
            </DropdownMenuCheckboxItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <div className="hidden items-center gap-1 @md:flex">
          <Segmented
            size="sm"
            aria-label="Diff layout"
            value={layout}
            onValueChange={actionsApi.setLayout}
            options={LAYOUT_OPTIONS}
          />
          <Hint label={wordWrap ? "Disable word wrap" : "Enable word wrap"}>
            <IconButton
              size="sm"
              icon={WrapText}
              label="Word wrap"
              aria-pressed={wordWrap}
              onClick={toggleWordWrap}
            />
          </Hint>
          <Hint label={ignoreWhitespace ? "Show whitespace changes" : "Hide whitespace changes"}>
            <IconButton
              size="sm"
              icon={Pilcrow}
              label="Hide whitespace changes"
              aria-pressed={ignoreWhitespace}
              onClick={() => actionsApi.setIgnoreWhitespace(!ignoreWhitespace)}
            />
          </Hint>
        </div>
        {files.length > 0 && (
          <Hint label={fileTreeOpen ? "Hide file tree" : "Show file tree"}>
            <IconButton
              size="sm"
              icon={FolderTree}
              label="Show file tree"
              aria-pressed={fileTreeOpen}
              onClick={() => actionsApi.setFileTreeOpen(!fileTreeOpen)}
            />
          </Hint>
        )}
        {actions}
      </div>
    </div>
  );

  // The turn scope reads the session's record, not git: none of the
  // repository's states below apply to it.
  const git = scope !== "turn";
  let body: ReactNode;
  if (!git && !selectedTurn) {
    body = (
      <Empty>
        {turns.length > 0
          ? "That turn isn't in this session any more."
          : "No turn in this session has changed a file yet."}
      </Empty>
    );
  } else if (!git && files.length === 0) {
    body = <Empty>This turn's edits have nothing to show.</Empty>;
  } else if (git && !repoPath) {
    body = <Empty>Open a project to review its changes.</Empty>;
  } else if (git && preview.isError) {
    body = <Empty>Couldn't read the diff: {String(preview.error)}</Empty>;
  } else if (git && !preview.data) {
    body = <DiffPanelSkeleton />;
  } else if (git && preview.data?.sources.length === 0 && files.length === 0) {
    body = <Empty>This project isn't a git repository.</Empty>;
  } else if (files.length === 0) {
    body = (
      <Empty>
        {scope === "session"
          ? only && only.size > 0
            ? "Nothing uncommitted is left from this session."
            : "This session hasn't changed any files."
          : scope === "branch-range"
            ? `No changes against ${source?.baseRef ?? "the base branch"}.`
            : "No uncommitted changes."}
      </Empty>
    );
  } else {
    body = (
      <Group
        id={TREE_LAYOUT_ID}
        orientation="horizontal"
        defaultLayout={defaultLayout}
        onLayoutChanged={onLayoutChanged}
        className="min-h-0 flex-1"
      >
        <Panel id="review-diff-files" className="min-w-0">
          <div
            className="relative h-full min-h-0 min-w-0"
            onClickCapture={(event) => {
              // A file's name opens the file; the rest of its header row folds
              // it. Its buttons keep their own actions: the chevron in
              // particular must not also reach the row, or the two folds
              // cancel out.
              const path = event.nativeEvent.composedPath();
              for (const node of path) {
                if (node instanceof HTMLButtonElement || node instanceof HTMLAnchorElement) return;
                // The find bar floats over the viewer; its clicks are its own.
                if (node instanceof HTMLElement && node.hasAttribute("data-diff-find")) return;
                if (node instanceof HTMLElement && node.hasAttribute("data-viewed-toggle")) return;
              }
              const title = path.find(
                (n): n is HTMLElement => n instanceof HTMLElement && n.hasAttribute("data-title"),
              );
              const header = path.find(
                (n): n is HTMLElement =>
                  n instanceof HTMLElement && n.hasAttribute("data-diffs-header"),
              );
              if (!header) return;
              const name = (title ?? header.querySelector("[data-title]"))?.textContent?.trim();
              const file = name ? fileByPath.get(name) : undefined;
              if (!file) return;
              if (!title) {
                if (file.state === "ready") toggleFile(itemIdOf(file));
                return;
              }
              // A deleted file has nothing on disk to open; its diff is all
              // there is of it.
              if (file.stat.status === "deleted") return;
              // As a right-panel file tab, or the system editor for a file
              // outside the project.
              void openReviewFile(
                combined.keys.get(file.stat.path)?.abs ?? `${repoPath}/${file.stat.path}`,
              );
            }}
          >
            <FileViewedContext value={viewedMarksOn ? viewedState : null}>
              <StyledCodeView
                // Remounted only when what it shows is a different diff (another
                // scope or base). A refresh after an edit updates items in place,
                // keeping the scroll position and every unchanged file's tokens.
                key={collapseScopeKey}
                viewerRef={setViewer}
                className="h-full min-h-0 overflow-auto"
                items={items}
                fallback={<DiffPanelSkeleton />}
                extraCSS={HIDE_VIEWER_COUNTS}
                options={{
                  diffStyle: layout,
                  overflow: wordWrap ? "wrap" : "scroll",
                  stickyHeaders: true,
                  // Whole lines tinted, no word-level boxes inside them: a
                  // review reads the line, and the boxes fight the syntax colour.
                  lineDiffType: "none",
                  onPostRender: repaintFind,
                  // Unchanged lines around a hunk come from git, which knows
                  // nothing of a past turn's texts.
                  loadDiffFiles: git ? loadDiffFiles : undefined,
                }}
                renderHeaderPrefix={(item) => {
                  const file = fileById.get(item.id);
                  if (!file) return null;
                  return (
                    <CollapseToggle
                      id={item.id}
                      path={file.stat.path}
                      collapsed={item.collapsed === true}
                      disabled={file.state !== "ready"}
                      tone={chevronToneOf(file.fileDiff)}
                      onToggle={toggleFile}
                    />
                  );
                }}
                renderHeaderFilenameSuffix={(item) => {
                  const file = fileById.get(item.id);
                  if (!file) return null;
                  return (
                    <FileStatus
                      file={file}
                      copyPath={combined.keys.get(file.stat.path)?.rel}
                      onRequest={requestFile}
                      onRetry={retry}
                      turn={!git}
                    />
                  );
                }}
                renderHeaderMetadata={(item) => {
                  const stat = fileById.get(item.id)?.stat;
                  if (!stat) return null;
                  return (
                    <FileViewedToggle
                      id={item.id}
                      path={stat.path}
                      stat={
                        stat.additions === null ? null : (
                          <HeaderStat additions={stat.additions} deletions={stat.deletions ?? 0} />
                        )
                      }
                    />
                  );
                }}
              />
            </FileViewedContext>
            {/* After the viewer: its item updates land first (`DiffFindBar`). */}
            {find.open && (
              <DiffFindBar
                ref={findRef}
                viewer={viewer}
                items={items}
                onUnfold={unfold}
                onClose={closeFind}
                focusRequest={find.focus}
                unloaded={unloaded}
              />
            )}
          </div>
        </Panel>
        {fileTreeOpen && (
          <>
            <Separator className="w-px bg-border-subtle transition-colors hover:bg-primary data-[separator=active]:bg-primary cursor-col-resize" />
            <Panel
              id="review-diff-tree"
              defaultSize="34"
              minSize="16"
              maxSize="50"
              className="flex min-w-0 flex-col"
            >
              <DiffFileTree
                files={treeFiles}
                groups={combined.grouped ? combined.groups : undefined}
                root={repoPath}
                selectedPath={selected}
                onSelect={reveal}
              />
            </Panel>
          </>
        )}
      </Group>
    );
  }

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      data-diff-panel
      className="flex h-full min-h-0 flex-col bg-[var(--atlas-editor-background)] outline-none"
    >
      {header}
      {body}
    </div>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-1 items-center justify-center px-6 text-center text-xs text-muted-foreground">
      {children}
    </div>
  );
}

const CollapseToggle = memo(function CollapseToggle({
  id,
  path,
  collapsed,
  disabled,
  tone,
  onToggle,
}: {
  id: string;
  path: string;
  collapsed: boolean;
  disabled: boolean;
  /** The change's colour (`chevronToneOf`). */
  tone: string;
  onToggle: (id: string) => void;
}) {
  // A plain button rather than `IconButton`: the glyph wears the change's
  // colour, which the primitive's ghost look would override.
  const Chevron = collapsed ? ChevronRight : ChevronDown;
  return (
    <Hint label={collapsed ? "Expand diff" : "Collapse diff"}>
      <button
        type="button"
        aria-label={collapsed ? `Expand ${path}` : `Collapse ${path}`}
        aria-expanded={!collapsed}
        disabled={disabled}
        onClick={(event) => {
          event.stopPropagation();
          onToggle(id);
        }}
        className={cn(
          "-ms-0.5 inline-flex size-control-xs shrink-0 cursor-pointer items-center justify-center rounded transition-colors duration-fast hover:bg-element-hover disabled:cursor-not-allowed disabled:opacity-50",
          tone,
        )}
      >
        <Chevron size={16} aria-hidden />
      </button>
    </Hint>
  );
});

/** The header's tail: copy, and what is wrong with the file if anything. A
 *  pending file's row asks for its contents when it mounts, which is when the
 *  viewer has scrolled it into its render window. */
function FileStatus({
  file,
  copyPath,
  onRequest,
  onRetry,
  turn = false,
}: {
  file: ReviewFile;
  /** What "Copy path" copies: the path in the file's own root. */
  copyPath?: string;
  onRequest: (path: string) => void;
  onRetry: (path: string) => void;
  /** A turn's file: diffed from its texts, so "no changes" is not "now". */
  turn?: boolean;
}) {
  const { path } = file.stat;
  const pending = file.state === "pending";
  useEffect(() => {
    if (pending) onRequest(path);
  }, [pending, path, onRequest]);
  return (
    <span className="ml-1 inline-flex items-center gap-1">
      <CopyPathButton path={copyPath ?? path} />
      {pending && <span className="text-2xs text-muted-foreground">Loading…</span>}
      {file.state === "binary" && <span className="text-2xs text-muted-foreground">Binary</span>}
      {file.state === "too-large" && (
        <span className="text-2xs text-muted-foreground">Too large to show</span>
      )}
      {file.state === "empty" && (
        <span className="text-2xs text-muted-foreground">
          {turn ? "No changes" : "No changes now"}
        </span>
      )}
      {file.excerpt && (
        <Hint label="Only the lines the agent replaced are known, not the whole file. Line numbers count from the excerpt.">
          <span className="rounded border border-border px-1 text-2xs text-muted-foreground">
            Excerpt
          </span>
        </Hint>
      )}
      {file.state === "error" && (
        <Hint label="Couldn't load this file. Retry">
          <IconButton
            size="xs"
            icon={AlertCircle}
            label="Retry loading diff"
            onClick={(event) => {
              event.stopPropagation();
              onRetry(path);
            }}
          />
        </Hint>
      )}
      {file.truncated && (
        <Hint label="Too large to show in full: only the first hunks are shown. Counts include every change.">
          <span className="inline-flex text-muted-foreground" aria-label="Partial diff">
            <Info size={12} />
          </span>
        </Hint>
      )}
    </span>
  );
}

/** "Turn ▸": every turn of the session that changed files, newest first, one
 *  line each: its number and when it ended. The prompt that started it is the
 *  row's tooltip. A turn's diff is rebuilt from the agent's own edit calls,
 *  so a change a command made (a formatter, a codegen step, `git mv`) is not
 *  in it; the menu says so once, above the turns. */
function TurnSubmenu({
  turns,
  selected,
  onPick,
}: {
  turns: readonly EditTurn[];
  /** The turn on show, if the scope is a turn. */
  selected: EditTurn | null;
  onPick: (turnId: string) => void;
}) {
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger disabled={turns.length === 0}>Turn</DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="max-h-80 overflow-auto">
        <p className="max-w-56 px-2 py-1 text-2xs text-muted-foreground">
          The agent's own edits. Changes made by commands aren't included.
        </p>
        <DropdownMenuRadioGroup
          value={selected ? selected.turnId : ""}
          onValueChange={(value) => onPick(String(value))}
        >
          {turns.map((turn) => (
            <DropdownMenuRadioItem
              key={turn.turnId}
              value={turn.turnId}
              title={turn.prompt || undefined}
              closeOnClick
            >
              <span className="flex flex-1 items-center gap-2">
                <span>Turn {turn.number}</span>
                <span className="ml-auto text-xs text-muted-foreground tabular-nums">
                  {formatTime(turn.timestamp)}
                </span>
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

const AUTOMATIC = "__automatic__";

function BaseRefPicker({
  current,
  chosen,
  branches,
  onPick,
}: {
  /** What the backend compared against. */
  current: string | null;
  /** What the reader picked; `null` is automatic. */
  chosen: string | null;
  branches: string[];
  onPick: (ref: string | null) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            aria-label={`Change comparison target. Currently ${current ?? "the base branch"}`}
          >
            <span className="max-w-48 min-w-0 truncate">{current ?? "base"}</span>
            <ChevronDown size={12} className="shrink-0 text-muted-foreground" />
          </Button>
        }
      />
      <DropdownMenuContent align="start" sideOffset={4} className="max-h-80 w-56 overflow-auto">
        <DropdownMenuLabel>Compare against</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={chosen ?? AUTOMATIC}
          onValueChange={(value) => onPick(value === AUTOMATIC ? null : String(value))}
        >
          <DropdownMenuRadioItem value={AUTOMATIC}>Automatic</DropdownMenuRadioItem>
          {branches.length > 0 && <DropdownMenuSeparator />}
          {branches.map((name) => (
            <DropdownMenuRadioItem key={name} value={name}>
              <span className="truncate">{name}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
