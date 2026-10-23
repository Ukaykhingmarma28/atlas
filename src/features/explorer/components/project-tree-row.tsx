import { memo, useEffect, useRef } from "react";
import { AlertCircle, ChevronRight, GitCompare, Link2, LoaderCircle } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { FileIcon } from "@/features/icon-theme/components/file-icon";
import type { TreeRowData } from "../lib/project-tree-model";
import { entryNameError } from "../lib/project-file-ops";
import { INDENT_PER_LEVEL, ROW_HEIGHT } from "../lib/tree-constants";

/**
 * One row of the project file tree.
 *
 * Every prop is a primitive or a shared, stable object, and every handler is
 * delegated to the tree's scroller through `data-*` attributes, so `memo`
 * holds: opening a folder re-renders that folder's row and the rows that came
 * into view, not the hundred around them. The row carries its absolute path
 * in `data-tree-path` for the same reason the explorer's rows do: the drag
 * and drop hooks hit-test the DOM, not React.
 */
export interface ProjectTreeRowProps {
  row: TreeRowData;
  /** Absolute; what the DOM, the drag hooks and the icon theme see. */
  absPath: string;
  /** `aria-activedescendant` target. */
  domId: string;
  start: number;
  expanded: boolean;
  loading: boolean;
  error: string | null;
  selected: boolean;
  focused: boolean;
  /** The file in the active editor tab. */
  active: boolean;
  cut: boolean;
  dropTarget: boolean;
  dragging: boolean;
  /** Status colour for a changed file, or the strongest one below a
   *  collapsed folder. */
  gitColor: string | null;
  additions: number | null;
  deletions: number | null;
  /** A changed file: offer its diff. */
  changed: boolean;
  hideArrows: boolean;
  renaming: boolean;
  onRenameCommit: (path: string, name: string) => void;
  onRenameCancel: () => void;
}

export const ProjectTreeRow = memo(function ProjectTreeRow({
  row,
  absPath,
  domId,
  start,
  expanded,
  loading,
  error,
  selected,
  focused,
  active,
  cut,
  dropTarget,
  dragging,
  gitColor,
  additions,
  deletions,
  changed,
  hideArrows,
  renaming,
  onRenameCommit,
  onRenameCancel,
}: ProjectTreeRowProps) {
  const isDir = row.kind === "directory";
  return (
    <div
      id={domId}
      role="treeitem"
      aria-level={row.depth + 1}
      aria-expanded={isDir ? expanded : undefined}
      aria-selected={selected}
      data-tree-path={absPath}
      data-tree-is-dir={isDir}
      data-rel-path={row.path}
      title={error ?? absPath}
      className={cn(
        "group absolute top-0 right-1 left-1 flex items-center gap-1.5 rounded-md select-none",
        "cursor-pointer transition-colors duration-fast",
        selected
          ? "bg-element-selected text-foreground"
          : active
            ? "bg-card text-foreground"
            : "text-secondary-foreground hover:bg-element-hover hover:text-foreground",
        focused && "ring-1 ring-border-strong ring-inset",
        dropTarget &&
          "bg-[var(--atlas-primary-muted)] text-foreground ring-1 ring-primary/40 ring-inset",
        row.ignored && !selected && "text-muted-foreground opacity-60",
        dragging && "opacity-40",
        cut && "opacity-50",
      )}
      style={{
        height: ROW_HEIGHT - 2,
        transform: `translateY(${start + 1}px)`,
        paddingLeft: 2 + row.depth * INDENT_PER_LEVEL,
        paddingRight: 6,
      }}
    >
      {isDir && !hideArrows ? (
        <ChevronRight
          size={12}
          strokeWidth={2}
          className={cn(
            "shrink-0 text-muted-foreground transition-transform duration-fast",
            expanded && "rotate-90",
          )}
        />
      ) : (
        <span className="w-3 shrink-0" aria-hidden />
      )}
      <FileIcon
        path={absPath}
        kind={isDir ? (expanded ? "folderExpanded" : "folder") : "file"}
        size={13}
      />
      {renaming ? (
        <RenameInput
          initial={row.name}
          onCommit={(name) => onRenameCommit(row.path, name)}
          onCancel={onRenameCancel}
        />
      ) : (
        <span
          className={cn(
            "min-w-0 flex-1 truncate font-mono text-xs leading-4",
            isDir && "text-foreground",
            row.ignored && "text-muted-foreground",
          )}
          style={!isDir && gitColor ? { color: gitColor } : undefined}
        >
          {row.name}
        </span>
      )}
      {!renaming && row.kind === "symlink" && (
        <Link2 aria-label="Symbolic link" className="size-3 shrink-0 text-muted-foreground" />
      )}
      {!renaming && (
        <span className="ml-auto flex shrink-0 items-center gap-1">
          {loading && (
            <LoaderCircle
              size={11}
              className="animate-spin text-muted-foreground"
              aria-label="Loading"
            />
          )}
          {error && <AlertCircle size={11} className="text-error" aria-label={error} />}
          {changed && (
            <button
              type="button"
              tabIndex={-1}
              data-tree-action="diff"
              aria-label={`Show changes in ${row.name}`}
              title="Show changes"
              className="hidden size-4 items-center justify-center rounded text-muted-foreground group-hover:flex hover:bg-element-hover hover:text-foreground"
            >
              <GitCompare size={11} />
            </button>
          )}
          {additions !== null && additions > 0 && (
            <span className="font-mono text-2xs text-[var(--atlas-diff-added-text)] tabular-nums">
              +{additions}
            </span>
          )}
          {deletions !== null && deletions > 0 && (
            <span className="font-mono text-2xs text-[var(--atlas-diff-removed-text)] tabular-nums">
              −{deletions}
            </span>
          )}
          {gitColor && (
            <span
              className="grid size-3 place-items-center"
              aria-label={isDir ? "Contains changed files" : "Changed"}
            >
              <span className="size-1.5 rounded-full" style={{ background: gitColor }} />
            </span>
          )}
        </span>
      )}
    </div>
  );
});

/**
 * The inline name editor for rename and for a new entry. Pre-selects the stem
 * so typing replaces the name and keeps the extension, as Finder does; the
 * double frame lets a closing context menu hand focus back first.
 */
export function RenameInput({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const settled = useRef(false);
  useEffect(() => {
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        const el = ref.current;
        if (!el) return;
        el.focus();
        const dot = initial.lastIndexOf(".");
        el.setSelectionRange(0, dot > 0 ? dot : initial.length);
      });
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [initial]);
  /** Enter keeps the editor open on a bad name and says why; leaving the
   *  field (blur) gives up on it instead. */
  const finish = (value: string, fromEnter: boolean) => {
    if (settled.current) return;
    const name = value.trim();
    const invalid = name && name !== initial ? entryNameError(name) : null;
    if (invalid && fromEnter) {
      toast.error(invalid);
      return;
    }
    settled.current = true;
    if (name && name !== initial && !invalid) onCommit(name);
    else onCancel();
  };
  return (
    <input
      ref={ref}
      defaultValue={initial}
      aria-label={initial ? `Rename ${initial}` : "Name"}
      spellCheck={false}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          finish(e.currentTarget.value, true);
        } else if (e.key === "Escape") {
          e.preventDefault();
          settled.current = true;
          onCancel();
        }
      }}
      onBlur={(e) => finish(e.currentTarget.value, false)}
      className="min-w-0 flex-1 rounded border border-border bg-panel-input px-1 py-0.5 font-mono text-xs leading-4 text-foreground outline-none focus:border-border-strong"
    />
  );
}
