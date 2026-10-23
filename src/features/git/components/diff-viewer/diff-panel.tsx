import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import type { CodeViewDiffItem, FileDiffContentsLoader, FileDiffMetadata } from "@pierre/diffs";
import type { CodeViewHandle } from "@pierre/diffs/react";
import {
  AlertCircle,
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
  WrapText,
} from "lucide-react";
import { openFile } from "@/lib/open-file";
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
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { useSettingsStore } from "@/features/settings/stores/settings-store";
import { useSessionFiles } from "@/features/chat/lib/session-files";
import { getDiffFileContents, getDiffPreview, type DiffSource } from "../../lib/git-review-api";
import { buildFileDiffContentVersion, fnv1a32 } from "../../lib/diff-rendering";
import { useReviewFiles, type ReviewFile } from "../../lib/use-review-files";
import { useDiffJump } from "../../lib/diff-jump";
import { collapsedSetOf, useDiffPanelStore, type DiffScope } from "../../stores/diff-panel-store";
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
 * one at a time as their rows come into view. Rendering: `StyledCodeView`,
 * which tokenizes in a worker pool and never on this thread.
 */

const SCOPE_LABEL: Record<DiffScope, string> = {
  session: "This session",
  "working-tree": "Uncommitted",
  "branch-range": "Branch",
};

/** Hide the viewer's own +/- counts: it counts only what has loaded, and a
 *  pending file would read +0 −0. The header shows the backend's numstat. */
const HIDE_VIEWER_COUNTS = "[data-additions-count], [data-deletions-count] { display: none; }";

const itemIdOf = (file: ReviewFile) => `${file.stat.oldPath ?? ""}\0${file.stat.path}`;

/** Per-object memo of the content hash: re-hashing every line of every file on
 *  every render would cost more than the render. */
const versionCache = new WeakMap<FileDiffMetadata, number>();
function contentVersion(fileDiff: FileDiffMetadata): number {
  let v = versionCache.get(fileDiff);
  if (v === undefined) {
    v = buildFileDiffContentVersion(fileDiff);
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
}

export function DiffPanel({ tabId, repoPath, sessionId = null, actions }: DiffPanelProps) {
  const scopes: DiffScope[] = sessionId
    ? ["session", "working-tree", "branch-range"]
    : ["working-tree", "branch-range"];
  const storedScope = useDiffPanelStore((s) => s.scope[tabId]);
  const scope = storedScope && scopes.includes(storedScope) ? storedScope : scopes[0];
  const baseRef = useDiffPanelStore((s) => s.baseRef[repoPath] ?? null);
  const layout = useDiffPanelStore.use.layout();
  const wordWrap = useDiffPanelStore.use.wordWrap();
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
  // edit Atlas did not make. Coalesced, since an edit is a burst of events.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const soon = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void refetch(), 250);
    };
    const offGit = listen<{ project: string }>("atlas:git-changed", (e) => {
      if (e.payload?.project === repoPath) soon();
    });
    const offFs = listen("atlas:explorer:changed", soon);
    return () => {
      if (timer) clearTimeout(timer);
      void offGit.then((off) => off());
      void offFs.then((off) => off());
    };
  }, [repoPath, refetch]);

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

  const review = useReviewFiles({ repoPath, source, only });
  const { files, requestFile, retry } = review;

  const collapseScopeKey = `${repoPath}\0${scope}\0${baseRef ?? ""}\0${sessionId ?? ""}`;
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
      const key = `review:${current.diffHash}:${path}`;
      const newFile = { name: path, contents: contents.newText, cacheKey: `${key}:new` };
      if (fileDiff.type === "rename-pure") return { oldFile: null, newFile };
      return {
        oldFile: { name: oldPath, contents: contents.oldText, cacheKey: `${key}:old` },
        newFile,
      };
    },
    [repoPath],
  );

  // ── Revealing a file: from the tree, or from outside (`requestDiffJump`) ──
  const [viewer, setViewer] = useState<CodeViewHandle<undefined, undefined> | null>(null);
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

  const header = (
    <div className="flex h-control-lg shrink-0 items-center gap-1 border-b border-border px-2">
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button variant="ghost" size="sm" aria-label={`Diff scope: ${SCOPE_LABEL[scope]}`}>
              {SCOPE_LABEL[scope]}
              <ChevronDown size={12} className="text-muted-foreground" />
            </Button>
          }
        />
        <DropdownMenuContent align="start" sideOffset={4} className="w-48">
          <DropdownMenuRadioGroup
            value={scope}
            onValueChange={(value) => actionsApi.setScope(tabId, value as DiffScope)}
          >
            {scopes.map((s) => (
              <DropdownMenuRadioItem key={s} value={s}>
                {SCOPE_LABEL[s]}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
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
        <Hint label="Refresh">
          <IconButton
            size="sm"
            icon={RefreshCw}
            label="Refresh diff"
            disabled={preview.isFetching}
            onClick={() => void refetch()}
          />
        </Hint>
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
        <Hint label={wordWrap ? "Don't wrap lines" : "Wrap lines"}>
          <IconButton
            size="sm"
            icon={WrapText}
            label="Wrap lines"
            aria-pressed={wordWrap}
            onClick={() => actionsApi.setWordWrap(!wordWrap)}
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

  let body: ReactNode;
  if (!repoPath) {
    body = <Empty>Open a project to review its changes.</Empty>;
  } else if (preview.isError) {
    body = <Empty>Couldn't read the diff: {String(preview.error)}</Empty>;
  } else if (!preview.data) {
    body = <DiffPanelSkeleton />;
  } else if (preview.data.sources.length === 0) {
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
      <div className="flex min-h-0 flex-1">
        <div
          className="min-h-0 min-w-0 flex-1"
          onClickCapture={(event) => {
            // A click on a file's header row (not on one of its buttons)
            // folds it; a click on its name opens the file.
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
            if (!file) return;
            if (title) void openFile(`${repoPath}/${file.stat.path}`);
            else if (file.state === "ready") toggleFile(itemIdOf(file));
          }}
        >
          <StyledCodeView
            key={`${collapseScopeKey}\0${review.scope}`}
            viewerRef={setViewer}
            className="h-full min-h-0 overflow-auto"
            items={items}
            fallback={<DiffPanelSkeleton />}
            extraCSS={HIDE_VIEWER_COUNTS}
            options={{
              diffStyle: layout,
              overflow: wordWrap ? "wrap" : "scroll",
              stickyHeaders: true,
              loadDiffFiles,
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
              return <FileStatus file={file} onRequest={requestFile} onRetry={retry} />;
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
        {fileTreeOpen && (
          <aside className="flex w-56 max-w-[40%] min-w-40 shrink-0 flex-col border-l border-border">
            <DiffFileTree
              files={files.map((f) => f.stat)}
              selectedPath={selected}
              onSelect={reveal}
            />
          </aside>
        )}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--atlas-editor-background)]">
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
}: {
  file: ReviewFile;
  onRequest: (path: string) => void;
  onRetry: (path: string) => void;
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
        <Hint label="Too large to show in full. Counts include every change.">
          <span className="inline-flex text-muted-foreground" aria-label="Partial diff">
            <Info size={12} />
          </span>
        </Hint>
      )}
    </span>
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
