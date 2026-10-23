import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { Group, Panel, Separator, useDefaultLayout } from "react-resizable-panels";
import type { CodeViewDiffItem, FileDiffContentsLoader, FileDiffMetadata } from "@pierre/diffs";
import type { CodeViewHandle } from "@pierre/diffs/react";
import {
  AlertCircle,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  ChevronUp,
  Columns2,
  FolderTree,
  Info,
  Pilcrow,
  RefreshCw,
  Rows3,
  WrapText,
} from "lucide-react";
import { openReviewFile } from "../../lib/open-review-file";
import { Button } from "@/ui/button";
import { IconButton } from "@/ui/icon-button";
import { Hint } from "@/ui/tooltip";
import {
  DropdownMenu,
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
import type { EditTurn } from "@/features/chat/lib/turn-edits";
import { useSettingsStore } from "@/features/settings/stores/settings-store";
import { useWordWrap } from "@/features/settings/lib/use-word-wrap";
import { useSessionFiles } from "@/features/chat/lib/session-files";
import { getDiffFileContents, getDiffPreview, type DiffSource } from "../../lib/git-review-api";
import { buildFileDiffContentVersion, fnv1a32 } from "../../lib/diff-rendering";
import { invalidateReviewFiles, useReviewFiles, type ReviewFile } from "../../lib/use-review-files";
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
  type DiffScope,
} from "../../stores/diff-panel-store";
import { useGitStore } from "../../stores/git-store";
import { StyledCodeView } from "./styled-code-view";
import { DiffFileTree } from "./diff-file-tree";
import { CopyPathButton } from "./copy-path-button";
import { DiffPanelSkeleton } from "./diff-panel-skeleton";

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

/** The scope menu's value for the turn the panel follows. */
const turnValue = (turn: string) => `turn:${turn}`;

/** Hide the viewer's own +/- counts: it counts only what has loaded, and a
 *  pending file would read +0 −0. The header shows the backend's numstat. */
const HIDE_VIEWER_COUNTS = "[data-additions-count], [data-deletions-count] { display: none; }";

const itemIdOf = (file: ReviewFile) => `${file.stat.oldPath ?? ""}\0${file.stat.path}`;

/** The tree beside the diff: its width is saved under this. */
const TREE_LAYOUT_ID = "git-review-diff-tree";

interface ChangeTarget {
  id: string;
  lineNumber: number;
  side: "additions" | "deletions";
}

/** The first line of each run of changed lines in a file: what previous/next
 *  change steps through. On the new side when the run adds anything. */
function changeTargetsOf(id: string, fileDiff: FileDiffMetadata): ChangeTarget[] {
  const out: ChangeTarget[] = [];
  for (const hunk of fileDiff.hunks) {
    for (const block of hunk.hunkContent) {
      if (block.type !== "change") continue;
      out.push(
        block.additions > 0
          ? {
              id,
              side: "additions",
              lineNumber: hunk.additionStart + block.additionLineIndex - hunk.additionLineIndex,
            }
          : {
              id,
              side: "deletions",
              lineNumber: hunk.deletionStart + block.deletionLineIndex - hunk.deletionLineIndex,
            },
      );
    }
  }
  return out;
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

export interface DiffPanelProps {
  /** The tab this panel is, so `requestDiffJump` can steer it. */
  tabId: string;
  repoPath: string;
  /** Offer (and default to) the files this agent session touched. */
  sessionId?: string | null;
  /** Source-control actions (commit, push, branch) go here when they land. */
  actions?: ReactNode;
  /** Heads the header: the review panel's view switch. */
  leading?: ReactNode;
}

export function DiffPanel({ tabId, repoPath, sessionId = null, actions, leading }: DiffPanelProps) {
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
  const { files, stats: treeFiles, requestFile, retry } = scope === "turn" ? turnReview : gitReview;

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

  const items = useMemo<CodeViewDiffItem[]>(
    () =>
      files.map((file) => {
        const id = itemIdOf(file);
        const folded = file.state !== "ready" || collapsed.has(id);
        return {
          id,
          type: "diff",
          fileDiff: file.fileDiff,
          collapsed: folded,
          version: fnv1a32(`${contentVersion(file.fileDiff)}:${folded ? 1 : 0}:${file.state}`),
        };
      }),
    [files, collapsed],
  );

  // Expanding the unchanged lines around a hunk needs both whole sides.
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const loadDiffFiles = useCallback<FileDiffContentsLoader>(
    async (fileDiff) => {
      const current = sourceRef.current;
      if (!current) throw new Error("No diff source to load from.");
      const path = fileDiff.name;
      const oldPath = fileDiff.prevName ?? path;
      const contents = await getDiffFileContents(repoPath, {
        sourceKind: current.kind,
        baseRef: current.mergeBase ?? current.baseRef,
        filePath: path,
        oldPath: fileDiff.prevName ?? null,
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
    (path: string) => {
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
    [files, requestFile, updateCollapsed, viewer],
  );
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

  // ── Previous / next change, across every open file ──
  const changes = useMemo(() => {
    const out: ChangeTarget[] = [];
    for (const file of files) {
      const id = itemIdOf(file);
      if (file.state === "ready" && !collapsed.has(id))
        out.push(...changeTargetsOf(id, file.fileDiff));
    }
    return out;
  }, [files, collapsed]);
  const changeCursor = useRef(-1);
  useEffect(() => {
    changeCursor.current = -1;
  }, [changes]);
  const jumpChange = (dir: 1 | -1) => {
    if (!viewer || changes.length === 0) return;
    const next =
      changeCursor.current < 0 && dir < 0
        ? changes.length - 1
        : (changeCursor.current + dir + changes.length) % changes.length;
    changeCursor.current = next;
    const target = changes[next];
    viewer.scrollTo({
      type: "line",
      id: target.id,
      lineNumber: target.lineNumber,
      side: target.side,
      align: "center",
    });
  };

  const header = (
    <div className="flex h-control-lg shrink-0 items-center gap-1 border-b border-border px-2">
      {leading}
      <DropdownMenu onOpenChange={(open) => setScopeMenuOpen(open)}>
        <DropdownMenuTrigger
          render={
            <Button variant="ghost" size="sm" aria-label={`Diff scope: ${scopeLabel}`}>
              <span className="max-w-40 truncate">{scopeLabel}</span>
              <ChevronDown size={12} className="text-muted-foreground" />
            </Button>
          }
        />
        <DropdownMenuContent align="start" sideOffset={4} className="w-48">
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
              <DropdownMenuRadioItem key={s} value={s}>
                {SCOPE_LABEL[s]}
              </DropdownMenuRadioItem>
            ))}
            {sessionId && (
              <DropdownMenuRadioItem value={turnValue(LATEST_TURN)} disabled={!latestTurn}>
                {SCOPE_LABEL.turn}
              </DropdownMenuRadioItem>
            )}
          </DropdownMenuRadioGroup>
          {sessionId && (
            <TurnSubmenu
              turns={turns}
              selected={scope === "turn" && selectedTurn !== latestTurn ? selectedTurn : null}
              onPick={(turnId) => actionsApi.setTurn(tabId, turnId)}
            />
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {scope === "branch-range" && (
        <BaseRefPicker
          current={source?.baseRef ?? null}
          chosen={baseRef}
          branches={branches?.filter((b) => !b.isCurrent).map((b) => b.name) ?? []}
          onPick={(ref) => actionsApi.setBaseRef(repoPath, ref)}
        />
      )}
      <div className="ml-auto flex shrink-0 items-center gap-0.5">
        {files.length > 0 && (
          <span className="mr-1 font-mono text-2xs tabular-nums">
            <span className="text-[var(--atlas-diff-added-text)]">+{totals.additions}</span>{" "}
            <span className="text-[var(--atlas-diff-removed-text)]">−{totals.deletions}</span>
          </span>
        )}
        <Hint label="Previous change">
          <IconButton
            size="sm"
            icon={ChevronUp}
            label="Previous change"
            disabled={changes.length === 0}
            onClick={() => jumpChange(-1)}
          />
        </Hint>
        <Hint label="Next change">
          <IconButton
            size="sm"
            icon={ChevronDown}
            label="Next change"
            disabled={changes.length === 0}
            onClick={() => jumpChange(1)}
          />
        </Hint>
        {/* A turn's edits are a record, not the disk: nothing to refresh. */}
        {scope !== "turn" && (
          <Hint label="Refresh">
            <IconButton
              size="sm"
              icon={RefreshCw}
              label="Refresh diff"
              disabled={preview.isFetching}
              onClick={() => void refetch()}
            />
          </Hint>
        )}
        {files.length > 1 && (
          <Hint label={allCollapsed ? "Expand all files" : "Collapse all files"}>
            <IconButton
              size="sm"
              icon={allCollapsed ? ChevronsUpDown : ChevronsDownUp}
              label={allCollapsed ? "Expand all files" : "Collapse all files"}
              onClick={toggleAll}
            />
          </Hint>
        )}
        <Hint label={layout === "split" ? "Unified view" : "Split view"}>
          <IconButton
            size="sm"
            icon={layout === "split" ? Rows3 : Columns2}
            label={layout === "split" ? "Unified view" : "Split view"}
            onClick={() => actionsApi.setLayout(layout === "split" ? "unified" : "split")}
          />
        </Hint>
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
        <Hint label={fileTreeOpen ? "Hide file tree" : "Show file tree"}>
          <IconButton
            size="sm"
            icon={FolderTree}
            label="Show file tree"
            aria-pressed={fileTreeOpen}
            onClick={() => actionsApi.setFileTreeOpen(!fileTreeOpen)}
          />
        </Hint>
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
  } else if (git && preview.data?.sources.length === 0) {
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
            className="h-full min-h-0 min-w-0"
            onClickCapture={(event) => {
              // A click on a file's header row or its name (not on one of its
              // buttons) opens the file.
              const path = event.nativeEvent.composedPath();
              for (const node of path) {
                if (node instanceof HTMLButtonElement || node instanceof HTMLAnchorElement) return;
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
              const file = name ? files.find((f) => f.stat.path === name) : undefined;
              // A deleted file has nothing on disk to open; its diff is all
              // there is of it.
              if (!file || file.stat.status === "deleted") return;
              // Header or name alike open the file, as a right-panel file tab
              // (or the system editor for a file outside the project). The
              // chevron, a button, still folds.
              void openReviewFile(`${repoPath}/${file.stat.path}`);
            }}
          >
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
                    onToggle={toggleFile}
                  />
                );
              }}
              renderHeaderFilenameSuffix={(item) => {
                const file = fileById.get(item.id);
                if (!file) return null;
                return (
                  <FileStatus file={file} onRequest={requestFile} onRetry={retry} turn={!git} />
                );
              }}
              renderHeaderMetadata={(item) => {
                const stat = fileById.get(item.id)?.stat;
                if (!stat || stat.additions === null) return null;
                return (
                  <span className="font-mono text-2xs tabular-nums">
                    <span className="text-[var(--atlas-diff-added-text)]">+{stat.additions}</span>{" "}
                    <span className="text-[var(--atlas-diff-removed-text)]">−{stat.deletions}</span>
                  </span>
                );
              }}
            />
          </div>
        </Panel>
        {fileTreeOpen && (
          <>
            <Separator className="w-px bg-border transition-colors hover:bg-primary data-[separator=active]:bg-primary cursor-col-resize" />
            <Panel
              id="review-diff-tree"
              defaultSize="26"
              minSize="12"
              maxSize="50"
              className="flex min-w-0 flex-col"
            >
              <DiffFileTree files={treeFiles} selectedPath={selected} onSelect={reveal} />
            </Panel>
          </>
        )}
      </Group>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--atlas-editor-background)]">
      {header}
      {!git && selectedTurn && <TurnNote turn={selectedTurn} />}
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
  onToggle,
}: {
  id: string;
  path: string;
  collapsed: boolean;
  disabled: boolean;
  onToggle: (id: string) => void;
}) {
  return (
    <IconButton
      size="xs"
      icon={collapsed ? ChevronRight : ChevronDown}
      label={collapsed ? `Expand ${path}` : `Collapse ${path}`}
      aria-expanded={!collapsed}
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation();
        onToggle(id);
      }}
    />
  );
});

/** The header's tail: copy, and what is wrong with the file if anything. A
 *  pending file's row asks for its contents when it mounts, which is when the
 *  viewer has scrolled it into its render window. */
function FileStatus({
  file,
  onRequest,
  onRetry,
  turn = false,
}: {
  file: ReviewFile;
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
      <CopyPathButton path={path} />
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

/** Under the header in the turn scope: which turn, and what these diffs are.
 *  They are rebuilt from the agent's own edit calls, so a change a command
 *  made (a formatter, a codegen step, `git mv`) is not in them. */
function TurnNote({ turn }: { turn: EditTurn }) {
  return (
    <div className="flex shrink-0 flex-col gap-0.5 border-b border-border px-3 py-1.5 text-2xs text-muted-foreground">
      <span className="min-w-0 truncate">
        <span className="text-secondary-foreground">Turn {turn.number}</span>
        {turn.prompt && <> · {turn.prompt}</>}
      </span>
      <span>The agent's own edits. Changes made by commands aren't included.</span>
    </div>
  );
}

/** "Turn ▸": every turn of the session that changed files, newest first. */
function TurnSubmenu({
  turns,
  selected,
  onPick,
}: {
  turns: readonly EditTurn[];
  /** The pinned turn, when it is not simply the latest. */
  selected: EditTurn | null;
  onPick: (turnId: string) => void;
}) {
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger disabled={turns.length === 0}>Turn</DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="max-h-80 w-72 overflow-auto">
        <DropdownMenuRadioGroup
          value={selected ? selected.turnId : ""}
          onValueChange={(value) => onPick(String(value))}
        >
          {turns.map((turn) => (
            <DropdownMenuRadioItem key={turn.turnId} value={turn.turnId}>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="flex items-baseline gap-2">
                  <span>Turn {turn.number}</span>
                  <span className="ml-auto text-2xs text-muted-foreground tabular-nums">
                    {formatTime(turn.timestamp)}
                  </span>
                </span>
                {turn.prompt && (
                  <span className="truncate text-2xs text-muted-foreground">{turn.prompt}</span>
                )}
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
            aria-label={`Compared against ${current ?? "the base branch"}`}
          >
            <span className="text-muted-foreground">vs</span>
            <span className="max-w-32 truncate">{current ?? "base"}</span>
            <ChevronDown size={12} className="text-muted-foreground" />
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
