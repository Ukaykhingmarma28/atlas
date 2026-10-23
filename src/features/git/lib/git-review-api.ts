// Bridge to `commands::diff_preview` — the review diff as raw unified patches
// plus a complete per-file numstat, for a viewer that parses patches itself.

import { invoke } from "@tauri-apps/api/core";

/** `working-tree`: uncommitted changes against HEAD. `branch-range`: the
 *  working tree against the merge base with the base branch. */
export type DiffSourceKind = "working-tree" | "branch-range";

export type DiffFileStatus =
  | "added"
  | "deleted"
  | "modified"
  | "renamed"
  | "copied"
  | "conflicted"
  | "untracked";

export interface DiffFileStat {
  /** Relative to the project path. */
  path: string;
  /** The path before a rename or copy. */
  oldPath?: string;
  /** `null` when not counted (an untracked file over 4 MB, or past the first
   *  5,000 untracked files); the source is then `truncated`. */
  additions: number | null;
  deletions: number | null;
  status: DiffFileStatus;
  /** Omitted when false. */
  binary?: boolean;
}

export interface DiffSource {
  kind: DiffSourceKind;
  /** `branch-range` only: the base compared against (`origin/main`), or null
   *  when none was found and the range is just the working tree. */
  baseRef: string | null;
  /** `branch-range` only: the merge-base commit. Hand it back as `baseRef` to
   *  {@link getDiffFileContents} so the base is not resolved again. */
  mergeBase: string | null;
  /** Unified patch, capped near 120 KB at a file boundary: every file in it
   *  is whole. */
  diff: string;
  /** Changes when `diff` or `files` does. */
  diffHash: string;
  /** Some file in `files` is not in `diff` (past the cap, or too large to
   *  count): check each file's presence and load the missing ones per file. */
  truncated: boolean;
  /** Every changed file, even when `diff` is truncated. */
  files: DiffFileStat[];
}

export interface DiffPreview {
  /** Empty outside a git repository; otherwise working-tree, then branch-range. */
  sources: DiffSource[];
}

export interface DiffFileContents {
  oldText: string;
  newText: string;
  /** A side was over 1 MB and is cut at a line boundary. */
  truncated: boolean;
  /** Either side is binary; both texts are then empty. */
  binary: boolean;
}

export interface DiffPreviewOptions {
  /** Base branch for the range; the remote default (or main/master) when omitted. */
  baseRef?: string;
  ignoreWhitespace?: boolean;
}

/** Both review sources for the project at `path`. */
export function getDiffPreview(path: string, opts: DiffPreviewOptions = {}): Promise<DiffPreview> {
  return invoke<DiffPreview>("git_diff_preview", {
    path,
    baseRef: opts.baseRef ?? null,
    ignoreWhitespace: opts.ignoreWhitespace ?? false,
  });
}

export interface DiffFileContentsRequest {
  sourceKind: DiffSourceKind;
  /** For `branch-range`: the source's `mergeBase` (or a base branch). */
  baseRef?: string | null;
  filePath: string;
  oldPath?: string | null;
}

/** Both sides of one file — for a file the capped patch left out. */
export function getDiffFileContents(
  path: string,
  req: DiffFileContentsRequest,
): Promise<DiffFileContents> {
  return invoke<DiffFileContents>("git_diff_file_contents", {
    path,
    sourceKind: req.sourceKind,
    baseRef: req.baseRef ?? null,
    filePath: req.filePath,
    oldPath: req.oldPath ?? null,
  });
}
