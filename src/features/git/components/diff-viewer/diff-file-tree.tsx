import { memo, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronRight, Folder } from "lucide-react";
import { cn } from "@/lib/utils";
import type { DiffFileStat, DiffFileStatus } from "../../lib/git-review-api";

/**
 * The changed files beside the diff, as a tree with each file's status and
 * line counts. Clicking a file scrolls the diff to it.
 *
 * Virtualized: a branch that touches thousands of files lists them without
 * mounting a row for each. A directory with a single child directory is
 * folded into one row (`src/features/git`), as editors do.
 */

const ROW_HEIGHT = 24;
const INDENT = 12;

const STATUS: Record<DiffFileStatus, { letter: string; className: string; label: string }> = {
  added: { letter: "A", className: "text-success", label: "Added" },
  untracked: { letter: "U", className: "text-success", label: "Untracked" },
  modified: { letter: "M", className: "text-warning", label: "Modified" },
  renamed: { letter: "R", className: "text-warning", label: "Renamed" },
  copied: { letter: "C", className: "text-warning", label: "Copied" },
  deleted: { letter: "D", className: "text-error", label: "Deleted" },
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
  selectedPath,
  onSelect,
}: {
  /** In the diff's order. */
  files: readonly DiffFileStat[];
  selectedPath: string | null;
  onSelect: (path: string) => void;
}) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const tree = useMemo(() => buildTree(files), [files]);
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

  return (
    <div
      ref={scrollRef}
      role="tree"
      aria-label="Changed files"
      className="min-h-0 flex-1 overflow-auto py-1"
    >
      <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((item) => {
          const row = rows[item.index];
          const indent = { paddingLeft: 8 + row.depth * INDENT };
          if (row.kind === "dir") {
            const open = !collapsed.has(row.path);
            return (
              <button
                key={`d:${row.path}`}
                type="button"
                role="treeitem"
                aria-expanded={open}
                onClick={() => toggleDir(row.path)}
                className="absolute top-0 left-0 flex h-6 w-full items-center gap-1 pr-2 text-left text-xs text-muted-foreground hover:bg-element-hover hover:text-foreground"
                style={{ ...indent, transform: `translateY(${item.start}px)` }}
              >
                <ChevronRight
                  size={12}
                  className={cn("shrink-0 transition-transform duration-fast", open && "rotate-90")}
                />
                <Folder size={12} className="shrink-0" />
                <span className="truncate">{row.name}</span>
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
                "absolute top-0 left-0 flex h-6 w-full items-center gap-1.5 pr-2 text-left text-xs",
                selected
                  ? "bg-element-selected text-foreground"
                  : "text-secondary-foreground hover:bg-element-hover hover:text-foreground",
              )}
              style={{ ...indent, transform: `translateY(${item.start}px)` }}
            >
              <span className="w-3 shrink-0" aria-hidden />
              <span className="min-w-0 flex-1 truncate">{row.name}</span>
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
  );
});
