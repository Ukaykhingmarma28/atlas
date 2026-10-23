import { memo, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronRight, ChevronsDownUp, ChevronsUpDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { IconButton } from "@/ui/icon-button";
import { Hint } from "@/ui/tooltip";
import { FileIcon } from "@/features/icon-theme/components/file-icon";
import { INDENT_PER_LEVEL, ROW_HEIGHT } from "@/features/explorer/lib/tree-constants";
import type { DiffFileStat, DiffFileStatus } from "../../lib/git-review-api";

/**
 * The changed files beside the diff, as a tree with each file's status and
 * line counts. Clicking a file scrolls the diff to it.
 *
 * Drawn as the project tree is (`project-tree-row.tsx`): 24px rows in the
 * 12px system sans, the icon theme's file icons, a soft rounded fill for the
 * selected row, a changed file's name in its status colour. The colours are
 * the diff palette's, so the `diffPalette` setting recolours the tree with
 * the diff.
 *
 * Virtualized: a branch that touches thousands of files lists them without
 * mounting a row for each. A directory with a single child directory is
 * folded into one row (`src/features/git`), as editors do.
 */

const ADDED = "text-[var(--atlas-diff-added-text)]";
const REMOVED = "text-[var(--atlas-diff-removed-text)]";
const MODIFIED = "text-[var(--atlas-diff-modified-text)]";

const STATUS: Record<DiffFileStatus, { letter: string; className: string; label: string }> = {
  added: { letter: "A", className: ADDED, label: "Added" },
  untracked: { letter: "U", className: ADDED, label: "Untracked" },
  modified: { letter: "M", className: MODIFIED, label: "Modified" },
  renamed: { letter: "R", className: MODIFIED, label: "Renamed" },
  copied: { letter: "C", className: MODIFIED, label: "Copied" },
  deleted: { letter: "D", className: REMOVED, label: "Deleted" },
  conflicted: { letter: "!", className: "text-error", label: "Conflicted" },
};

interface DirNode {
  name: string;
  path: string;
  dirs: Map<string, DirNode>;
  files: DiffFileStat[];
}

type Row =
  | { kind: "dir"; path: string; name: string; depth: number }
  | { kind: "file"; stat: DiffFileStat; name: string; depth: number };

function buildTree(files: readonly DiffFileStat[]): DirNode {
  const root: DirNode = { name: "", path: "", dirs: new Map(), files: [] };
  for (const file of files) {
    const parts = file.path.split("/");
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      let next = node.dirs.get(parts[i]);
      if (!next) {
        const path = node.path ? `${node.path}/${parts[i]}` : parts[i];
        next = { name: parts[i], path, dirs: new Map(), files: [] };
        node.dirs.set(parts[i], next);
      }
      node = next;
    }
    node.files.push(file);
  }
  return root;
}

/** Every directory row's path, as `flatten` folds them. */
function dirPaths(root: DirNode): string[] {
  const out: string[] = [];
  const walk = (node: DirNode) => {
    for (const dir of node.dirs.values()) {
      let d = dir;
      while (d.files.length === 0 && d.dirs.size === 1) d = d.dirs.values().next().value as DirNode;
      out.push(d.path);
      walk(d);
    }
  };
  walk(root);
  return out;
}

function flatten(root: DirNode, collapsed: ReadonlySet<string>): Row[] {
  const rows: Row[] = [];
  const walk = (node: DirNode, depth: number) => {
    for (const dir of node.dirs.values()) {
      // Fold a chain of lone directories into one row.
      let d = dir;
      let name = d.name;
      while (d.files.length === 0 && d.dirs.size === 1) {
        d = d.dirs.values().next().value as DirNode;
        name = `${name}/${d.name}`;
      }
      rows.push({ kind: "dir", path: d.path, name, depth });
      if (!collapsed.has(d.path)) walk(d, depth + 1);
    }
    for (const stat of node.files) {
      rows.push({ kind: "file", stat, name: stat.path.split("/").pop() ?? stat.path, depth });
    }
  };
  walk(root, 0);
  return rows;
}

export const DiffFileTree = memo(function DiffFileTree({
  files,
  root,
  selectedPath,
  onSelect,
}: {
  /** In the diff's order. */
  files: readonly DiffFileStat[];
  /** The repository: icon themes match on the absolute path. */
  root: string;
  selectedPath: string | null;
  onSelect: (path: string) => void;
}) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const tree = useMemo(() => buildTree(files), [files]);
  const dirs = useMemo(() => dirPaths(tree), [tree]);
  const rows = useMemo(() => flatten(tree, collapsed), [tree, collapsed]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  // Bring the selected file into view when the selection changes, and only
  // then: a refreshed file list must not pull the tree back to it while the
  // reader scrolls elsewhere. `rows` is read through a ref for that reason.
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  useEffect(() => {
    if (!selectedPath) return;
    const index = rowsRef.current.findIndex(
      (r) => r.kind === "file" && r.stat.path === selectedPath,
    );
    if (index >= 0) virtualizer.scrollToIndex(index, { align: "auto" });
  }, [selectedPath, virtualizer]);

  const toggleDir = (path: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  const allOpen = collapsed.size === 0;
  const base = root.endsWith("/") ? root : `${root}/`;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-control-lg shrink-0 items-center gap-1 border-b border-border-subtle px-2 text-xs text-muted-foreground">
        <span className="px-1 font-medium text-foreground">Files</span>
        <span className="ml-auto tabular-nums">{files.length}</span>
        {dirs.length > 0 && (
          <Hint label={allOpen ? "Collapse all folders" : "Expand all folders"}>
            <IconButton
              size="xs"
              icon={allOpen ? ChevronsDownUp : ChevronsUpDown}
              label={allOpen ? "Collapse all folders" : "Expand all folders"}
              onClick={() => setCollapsed(allOpen ? new Set(dirs) : new Set())}
            />
          </Hint>
        )}
      </div>
      <div
        ref={scrollRef}
        role="tree"
        aria-label="Changed files"
        className="min-h-0 flex-1 overflow-auto py-1"
      >
        <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((item) => {
            const row = rows[item.index];
            const place = {
              height: ROW_HEIGHT,
              transform: `translateY(${item.start}px)`,
              paddingLeft: 2 + row.depth * INDENT_PER_LEVEL,
              paddingRight: 6,
            };
            if (row.kind === "dir") {
              const open = !collapsed.has(row.path);
              return (
                <button
                  key={`d:${row.path}`}
                  type="button"
                  role="treeitem"
                  aria-expanded={open}
                  onClick={() => toggleDir(row.path)}
                  className="absolute top-0 right-1 left-1 flex items-center gap-1.5 rounded-md text-left text-foreground transition-colors duration-fast hover:bg-element-hover"
                  style={place}
                >
                  <ChevronRight
                    size={12}
                    strokeWidth={2}
                    className={cn(
                      "shrink-0 text-muted-foreground transition-transform duration-fast",
                      open && "rotate-90",
                    )}
                  />
                  <span className="flex shrink-0">
                    <FileIcon
                      path={base + row.path}
                      kind={open ? "folderExpanded" : "folder"}
                      size={13}
                    />
                  </span>
                  <span className="min-w-0 flex-1 truncate font-sans text-sm">{row.name}</span>
                </button>
              );
            }
            const status = STATUS[row.stat.status] ?? STATUS.modified;
            const selected = row.stat.path === selectedPath;
            return (
              <button
                key={`f:${row.stat.path}`}
                type="button"
                role="treeitem"
                aria-selected={selected}
                title={row.stat.oldPath ? `${row.stat.oldPath} → ${row.stat.path}` : row.stat.path}
                onClick={() => onSelect(row.stat.path)}
                className={cn(
                  "absolute top-0 right-1 left-1 flex items-center gap-1.5 rounded-md text-left transition-colors duration-fast",
                  selected ? "bg-element-selected" : "hover:bg-element-hover",
                )}
                style={place}
              >
                <span className="w-3 shrink-0" aria-hidden />
                <span className="flex shrink-0">
                  <FileIcon path={base + row.stat.path} size={13} />
                </span>
                <span className={cn("min-w-0 flex-1 truncate font-sans text-sm", status.className)}>
                  {row.name}
                </span>
                {row.stat.additions !== null && row.stat.additions > 0 && (
                  <span className="shrink-0 font-mono text-2xs text-[var(--atlas-diff-added-text)] tabular-nums">
                    +{row.stat.additions}
                  </span>
                )}
                {row.stat.deletions !== null && row.stat.deletions > 0 && (
                  <span className="shrink-0 font-mono text-2xs text-[var(--atlas-diff-removed-text)] tabular-nums">
                    −{row.stat.deletions}
                  </span>
                )}
                <span
                  className={cn(
                    "w-3 shrink-0 text-center font-mono text-2xs font-semibold",
                    status.className,
                  )}
                  aria-label={status.label}
                  title={status.label}
                >
                  {status.letter}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
});
