// The changed-files card at the end of a turn: what the turn edited, as a
// folder tree with line counts, and a way into the turn's diff.
//
// Performance contract (see `turn-rows.ts`): the card is the footer row of a
// SETTLED turn — `turnSummary` is frozen at `turn_finished` and its `files`
// array keeps its identity across projections, so the tree below is built
// once per turn and a streaming turn elsewhere never re-renders it. Nothing
// here animates in a loop, so the offscreen-animation rules have nothing to
// pause. The rows are real DOM like the rest of the transcript; a turn that
// touched hundreds of files shows the first `ROW_LIMIT` rows until asked.

import { memo, useMemo, useState, type MouseEvent } from "react";
import { ChevronRight, ChevronsDownUp, ChevronsUpDown, FileDiff } from "lucide-react";
import type { TurnFile } from "@/types/agent";
import { cn } from "@/lib/utils";
import { copyText } from "@/lib/clipboard";
import { Button } from "@/ui/button";
import { IconButton } from "@/ui/icon-button";
import { Hint } from "@/ui/tooltip";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/ui/context-menu";
import { useAppStore } from "@/features/app/stores/app-store";
import { FileIcon } from "@/features/icon-theme/components/file-icon";
import { openReviewFile } from "@/features/git/lib/open-review-file";
import {
  buildChangedFilesTree,
  changedFilesOf,
  folderPaths,
  formatDiffCount,
  sumStats,
  visibleRows,
  type ChangedFile,
  type ChangedRow,
} from "../lib/changed-files-tree";
import { isAbsolutePath, joinPath, openTurnDiff } from "../lib/open-turn-diff";
import { HEADER_INSET } from "../lib/row-metrics";
import { useChangedFilesStore } from "../stores/changed-files-store";

/** Rows drawn before "Show all": a card is a summary, not the file list. */
export const ROW_LIMIT = 200;
/** One level of the tree's indent, in px. */
const INDENT = 14;
const NO_OVERRIDES: Record<string, boolean> = {};

/**
 * Settled cards off screen cost nothing per frame.
 *
 * A card is a few dozen nodes, and a long session has one under every turn
 * that edited, so they add up to thousands. A streaming frame restyles the
 * document, and measured against the card-less footer that was +0.4 ms a
 * frame and twice the dropped frames. `content-visibility: auto` lets the
 * browser skip their style and layout until they scroll near.
 *
 * Skipped, a card measures as its intrinsic size. `auto` makes that the size
 * it last rendered at; before its first render it is this estimate, which is
 * exact: the header (`h-control-xs` plus `py-1`), a 1.5rem row per visible
 * row, and the tree's `pb-1`. An exact guess matters because the transcript
 * grows upward, and a card that changed height as it scrolled in would move
 * everything under the reader.
 */
function cardStyle(rows: number) {
  return {
    contentVisibility: "auto",
    containIntrinsicSize: `auto calc(var(--control-xs) + 0.75rem + ${rows} * 1.5rem)`,
  } as const;
}

/** `+12 −3`, compact past a thousand. Zero sides are kept: a column of
 *  figures reads by position. */
export function DiffCounts({
  added,
  removed,
  className,
}: {
  added: number;
  removed: number;
  className?: string;
}) {
  return (
    <span
      role="group"
      aria-label={`${added} added, ${removed} removed`}
      className={cn("inline-flex shrink-0 gap-1 font-mono tabular-nums", className)}
    >
      <span aria-hidden className="text-[var(--atlas-diff-added-text)]">
        +{formatDiffCount(added)}
      </span>
      <span aria-hidden className="text-[var(--atlas-diff-removed-text)]">
        −{formatDiffCount(removed)}
      </span>
    </span>
  );
}

export const ChangedFilesCard = memo(function ChangedFilesCard({
  turnKey,
  files: turnFiles,
}: {
  /** The turn's stable key (`stableTurnKey`): what the card opens, and
   *  what its expand-all answer is remembered by across relaunches. */
  turnKey: string;
  /** The turn's frozen `turnSummary.files`; reads are left out here. */
  files: readonly TurnFile[];
}) {
  const repoPath = useAppStore((s) => s.currentProject?.path ?? "");
  const files = useMemo(() => changedFilesOf(turnFiles, repoPath), [turnFiles, repoPath]);
  const total = useMemo(() => sumStats(files), [files]);
  const tree = useMemo(() => buildChangedFilesTree(files), [files]);
  const hasFolders = tree.some((n) => n.kind === "dir");

  const allExpanded = useChangedFilesStore((s) => s.expanded[turnKey] === true);
  const { setExpanded } = useChangedFilesStore.use.actions();
  // What the card measures before it has ever been laid out (see `cardStyle`).
  const firstRows = useMemo(() => {
    const n = visibleRows(tree, NO_OVERRIDES, allExpanded).length;
    return n > ROW_LIMIT ? ROW_LIMIT + 1 : n;
  }, [tree, allExpanded]);

  return (
    <div className="rounded-lg bg-card" data-changed-files="" style={cardStyle(firstRows)}>
      <div
        className="sticky z-10 flex items-center justify-between gap-2 rounded-t-lg bg-card py-1 pr-1 pl-3"
        // Under the session's floating header, not behind it.
        style={{ top: HEADER_INSET }}
      >
        <div className="flex min-w-0 items-center gap-3 text-xs font-medium text-foreground">
          <span className="truncate">
            {files.length} changed file{files.length === 1 ? "" : "s"}
          </span>
          {(total.added > 0 || total.removed > 0) && (
            <DiffCounts added={total.added} removed={total.removed} className="text-2xs" />
          )}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {hasFolders && (
            <Hint label={allExpanded ? "Collapse all folders" : "Expand all folders"} side="top">
              <IconButton
                size="xs"
                icon={allExpanded ? ChevronsDownUp : ChevronsUpDown}
                label={allExpanded ? "Collapse all folders" : "Expand all folders"}
                aria-pressed={allExpanded}
                onClick={() => setExpanded(turnKey, !allExpanded)}
              />
            </Hint>
          )}
          <Hint label="Open this turn's diff" side="top">
            <Button variant="ghost" size="xs" onClick={() => openTurnDiff(turnKey)}>
              <FileDiff size={12} />
              Open diff
            </Button>
          </Hint>
        </div>
      </div>
      <div className="px-1 pb-1">
        <ChangedFilesTree
          // A new expand-all answer starts the folders afresh, as it says.
          key={allExpanded ? "all" : "folded"}
          turnKey={turnKey}
          repoPath={repoPath}
          tree={tree}
          allExpanded={allExpanded}
        />
      </div>
    </div>
  );
});

const ChangedFilesTree = memo(function ChangedFilesTree({
  turnKey,
  repoPath,
  tree,
  allExpanded,
}: {
  turnKey: string;
  repoPath: string;
  tree: ReturnType<typeof buildChangedFilesTree>;
  allExpanded: boolean;
}) {
  // The reader's own folder toggles, over the expand-all default. Keyed by
  // the tree's folders, so a different set of folders starts clean.
  const folderKey = useMemo(() => folderPaths(tree).join("\0"), [tree]);
  const [overrides, setOverrides] = useState<{ key: string; open: Record<string, boolean> }>({
    key: folderKey,
    open: NO_OVERRIDES,
  });
  const open = overrides.key === folderKey ? overrides.open : NO_OVERRIDES;
  const toggle = (path: string) =>
    setOverrides((current) => {
      const prior = current.key === folderKey ? current.open : NO_OVERRIDES;
      return { key: folderKey, open: { ...prior, [path]: !(prior[path] ?? allExpanded) } };
    });

  const rows = useMemo(() => visibleRows(tree, open, allExpanded), [tree, open, allExpanded]);
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? rows : rows.slice(0, ROW_LIMIT);
  const flat = !tree.some((n) => n.kind === "dir");

  // One menu for the whole tree, aimed by the row that was right-clicked.
  const [menuFile, setMenuFile] = useState<ChangedFile | null>(null);
  const onContextMenu = (event: MouseEvent) => {
    const el = (event.target as HTMLElement).closest<HTMLElement>("[data-changed-file]");
    const path = el?.dataset.changedFile;
    const row = path ? rows.find((r) => r.node.kind === "file" && r.node.path === path) : null;
    setMenuFile(row?.node.kind === "file" ? row.node.file : null);
  };
  const absolute = (file: ChangedFile) =>
    isAbsolutePath(file.source) || !repoPath ? file.source : joinPath(repoPath, file.path);

  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={<div role="tree" aria-label="Changed files" />}
        onContextMenu={onContextMenu}
      >
        {shown.map((row) => (
          <TreeRow
            key={`${row.node.kind}:${row.node.path}`}
            row={row}
            open={row.node.kind === "dir" && (open[row.node.path] ?? allExpanded)}
            flat={flat}
            onToggle={toggle}
            onOpen={(file) => openTurnDiff(turnKey, file.source)}
          />
        ))}
        {rows.length > shown.length && (
          <button
            type="button"
            onClick={() => setShowAll(true)}
            className="flex h-6 w-full cursor-pointer items-center rounded-md px-2 text-left text-2xs text-muted-foreground hover:bg-element-hover hover:text-foreground"
          >
            Show {rows.length - shown.length} more
          </button>
        )}
      </ContextMenuTrigger>
      {menuFile && (
        <ContextMenuContent>
          <ContextMenuItem onClick={() => openTurnDiff(turnKey, menuFile.source)}>
            Show diff
          </ContextMenuItem>
          <ContextMenuItem onClick={() => void openReviewFile(absolute(menuFile))}>
            Open file
          </ContextMenuItem>
          <ContextMenuItem onClick={() => void copyText(menuFile.path)}>Copy path</ContextMenuItem>
        </ContextMenuContent>
      )}
    </ContextMenu>
  );
});

const ROW =
  "group flex h-6 w-full cursor-pointer items-center gap-1.5 rounded-md pr-2 text-left outline-none transition-colors duration-fast hover:bg-element-hover focus-visible:ring-1 focus-visible:ring-border-strong focus-visible:ring-inset";

function TreeRow({
  row,
  open,
  flat,
  onToggle,
  onOpen,
}: {
  row: ChangedRow;
  open: boolean;
  /** No folders anywhere: files sit flush, with no chevron column. */
  flat: boolean;
  onToggle: (path: string) => void;
  onOpen: (file: ChangedFile) => void;
}) {
  const { node, depth } = row;
  const indent = { paddingLeft: 6 + depth * INDENT };
  if (node.kind === "dir") {
    return (
      <button
        type="button"
        role="treeitem"
        aria-expanded={open}
        title={node.path}
        onClick={() => onToggle(node.path)}
        className={ROW}
        style={indent}
      >
        <ChevronRight
          size={12}
          className={cn(
            "shrink-0 text-muted-foreground transition-transform duration-fast",
            open && "rotate-90",
          )}
        />
        <FileIcon path={node.path} kind={open ? "folderExpanded" : "folder"} size={13} />
        <span className="min-w-0 truncate font-mono text-2xs text-muted-foreground group-hover:text-foreground">
          {node.name}
        </span>
        {(node.stat.added > 0 || node.stat.removed > 0) && (
          <DiffCounts
            added={node.stat.added}
            removed={node.stat.removed}
            className="ml-auto text-2xs"
          />
        )}
      </button>
    );
  }
  const { file } = node;
  return (
    <button
      type="button"
      role="treeitem"
      title={file.path}
      data-changed-file={file.path}
      onClick={() => onOpen(file)}
      className={ROW}
      style={indent}
    >
      {!flat && <span className="w-3 shrink-0" aria-hidden />}
      <FileIcon path={file.path} size={13} />
      <span className="min-w-0 truncate font-mono text-xs text-secondary-foreground group-hover:text-foreground">
        {node.name}
      </span>
      <DiffCounts added={file.added} removed={file.removed} className="ml-auto text-2xs" />
    </button>
  );
}
