// The changed-files card's data: a turn's edited files as a folder tree with
// line counts rolled up into every folder, and the rows the card draws from
// it. Pure, so the card can memoize on the turn's frozen file list and a
// settled turn never rebuilds its tree.

import type { TurnFile } from "@/types/agent";
import { toRepoRelative } from "./open-turn-diff";

export interface DiffStat {
  added: number;
  removed: number;
}

/** One file the turn changed, by its repo-relative path. */
export interface ChangedFile extends DiffStat {
  path: string;
  /** The path as the turn reported it (absolute, usually), for opening. */
  source: string;
  created: boolean;
}

export interface ChangedDirNode {
  kind: "dir";
  /** What the row shows: one segment, or a folded chain (`src/server/api`). */
  name: string;
  /** The deepest folder of the chain; what expansion is keyed by. */
  path: string;
  stat: DiffStat;
  children: ChangedNode[];
}

export interface ChangedFileNode {
  kind: "file";
  name: string;
  path: string;
  file: ChangedFile;
}

export type ChangedNode = ChangedDirNode | ChangedFileNode;

export interface ChangedRow {
  node: ChangedNode;
  depth: number;
}

/**
 * The files a turn changed, repo-relative, with what it only read left out.
 * The order is the turn's own; the tree sorts.
 */
export function changedFilesOf(files: readonly TurnFile[], repoPath: string): ChangedFile[] {
  const out: ChangedFile[] = [];
  for (const f of files) {
    if (f.kind !== "edit") continue;
    out.push({
      path: toRepoRelative(f.path, repoPath),
      source: f.path,
      added: f.added,
      removed: f.removed,
      created: f.created === true,
    });
  }
  return out;
}

export function sumStats(files: readonly DiffStat[]): DiffStat {
  let added = 0;
  let removed = 0;
  for (const f of files) {
    added += f.added;
    removed += f.removed;
  }
  return { added, removed };
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const byName = (a: { name: string }, b: { name: string }) => collator.compare(a.name, b.name);

interface MutableDir {
  name: string;
  path: string;
  stat: DiffStat;
  dirs: Map<string, MutableDir>;
  files: ChangedFileNode[];
}

/** A folder whose only child is a folder is shown as one row, as editors do. */
function compact(dir: ChangedDirNode): ChangedDirNode {
  let node: ChangedDirNode = {
    ...dir,
    children: dir.children.map((c) => (c.kind === "dir" ? compact(c) : c)),
  };
  while (node.children.length === 1 && node.children[0].kind === "dir") {
    const only: ChangedDirNode = node.children[0];
    node = { ...only, name: `${node.name}/${only.name}` };
  }
  return node;
}

function toNodes(dir: MutableDir): ChangedNode[] {
  const dirs = [...dir.dirs.values()].sort(byName).map((d): ChangedDirNode =>
    compact({
      kind: "dir",
      name: d.name,
      path: d.path,
      stat: { added: d.stat.added, removed: d.stat.removed },
      children: toNodes(d),
    }),
  );
  return [...dirs, ...[...dir.files].sort(byName)];
}

/** Folders first, then files, each by name; counts summed up every folder. */
export function buildChangedFilesTree(files: readonly ChangedFile[]): ChangedNode[] {
  const root: MutableDir = {
    name: "",
    path: "",
    stat: { added: 0, removed: 0 },
    dirs: new Map(),
    files: [],
  };
  for (const file of files) {
    const segments = file.path.split(/[/\\]/).filter(Boolean);
    const name = segments.pop();
    if (!name) continue;
    let dir = root;
    const chain = [root];
    for (const segment of segments) {
      let next = dir.dirs.get(segment);
      if (!next) {
        next = {
          name: segment,
          path: dir.path ? `${dir.path}/${segment}` : segment,
          stat: { added: 0, removed: 0 },
          dirs: new Map(),
          files: [],
        };
        dir.dirs.set(segment, next);
      }
      dir = next;
      chain.push(dir);
    }
    dir.files.push({ kind: "file", name, path: file.path, file });
    for (const d of chain) {
      d.stat.added += file.added;
      d.stat.removed += file.removed;
    }
  }
  return toNodes(root);
}

/** Every folder path in the tree, depth first. */
export function folderPaths(nodes: readonly ChangedNode[], out: string[] = []): string[] {
  for (const node of nodes) {
    if (node.kind !== "dir") continue;
    out.push(node.path);
    folderPaths(node.children, out);
  }
  return out;
}

/**
 * The rows on screen: every node whose folders are open. A folder is open
 * when the reader opened it (`overrides`), else when all are (`allExpanded`).
 */
export function visibleRows(
  nodes: readonly ChangedNode[],
  overrides: Readonly<Record<string, boolean>>,
  allExpanded: boolean,
  depth = 0,
  rows: ChangedRow[] = [],
): ChangedRow[] {
  for (const node of nodes) {
    rows.push({ node, depth });
    if (node.kind === "dir" && (overrides[node.path] ?? allExpanded)) {
      visibleRows(node.children, overrides, allExpanded, depth + 1, rows);
    }
  }
  return rows;
}

/** A count for a narrow gutter: `999`, `1.2k`, `12k`, `3.4m`. */
export function formatDiffCount(value: number): string {
  const scaled = (n: number, unit: string) =>
    `${n < 10 ? n.toFixed(1).replace(/\.0$/, "") : Math.round(n)}${unit}`;
  if (value < 1000) return String(value);
  // 999,600 rounds to 1000k; it reads as 1m.
  if (value < 999_500) return scaled(value / 1000, "k");
  return scaled(value / 1_000_000, "m");
}
