// Turning a unified patch into what the diff viewer renders, and the keys that
// let it repaint only the files that changed.
//
// Everything here runs on the main thread, so none of it tokenizes: parsing a
// patch into hunks is linear and cheap, and highlighting is the worker pool's.

import { parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs";

const FNV_OFFSET_BASIS_32 = 0x811c9dc5;
const FNV_PRIME_32 = 0x01000193;
const SECONDARY_HASH_SEED = 0x9e3779b9;
const SECONDARY_HASH_MULTIPLIER = 0x85ebca6b;

export function fnv1a32(
  input: string,
  seed = FNV_OFFSET_BASIS_32,
  multiplier = FNV_PRIME_32,
): number {
  let hash = seed >>> 0;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, multiplier) >>> 0;
  }
  return hash >>> 0;
}

/** Two independent 32-bit hashes and the length: the viewer's highlight cache
 *  is keyed by this, and a collision would paint one patch's tokens on another. */
function buildPatchCacheKey(patch: string, scope: string): string {
  const primary = fnv1a32(patch).toString(36);
  const secondary = fnv1a32(patch, SECONDARY_HASH_SEED, SECONDARY_HASH_MULTIPLIER).toString(36);
  return `${scope}:${patch.length}:${primary}:${secondary}`;
}

export type RenderablePatch =
  | { kind: "files"; files: FileDiffMetadata[] }
  | { kind: "raw"; text: string; reason: string };

export interface DiffLineStat {
  additions: number;
  deletions: number;
}

export function getDiffLineStat(files: ReadonlyArray<FileDiffMetadata>): DiffLineStat {
  const total = { additions: 0, deletions: 0 };
  for (const file of files) {
    for (const hunk of file.hunks) {
      total.additions += hunk.additionLines;
      total.deletions += hunk.deletionLines;
    }
  }
  return total;
}

/**
 * The parser keeps a partial patch's hunk starts in source-file coordinates,
 * but the virtualizer lays a partial file out as compact rows. Without this a
 * review diff reserves the height of every unchanged line between hunks.
 * `collapsedBefore` survives, so the "N unmodified lines" separator still reads
 * right.
 */
function compactPartialHunkOffsets(file: FileDiffMetadata): FileDiffMetadata {
  if (!file.isPartial) return file;
  let splitLineStart = 0;
  let unifiedLineStart = 0;
  const hunks = file.hunks.map((hunk) => {
    const compact = { ...hunk, splitLineStart, unifiedLineStart };
    splitLineStart += hunk.splitLineCount;
    unifiedLineStart += hunk.unifiedLineCount;
    return compact;
  });
  return {
    ...file,
    hunks,
    splitLineCount: splitLineStart,
    unifiedLineCount: unifiedLineStart,
    ...(file.cacheKey ? { cacheKey: `${file.cacheKey}:compact-partial` } : {}),
  };
}

/** `null` for an empty patch; `raw` when it does not parse as files. */
export function getRenderablePatch(
  patch: string | undefined,
  cacheScope = "diff-panel",
): RenderablePatch | null {
  if (!patch) return null;
  const normalized = patch.trim();
  if (normalized.length === 0) return null;
  try {
    const parsed = parsePatchFiles(normalized, buildPatchCacheKey(normalized, cacheScope));
    const files = parsed.flatMap((p) => p.files).map(compactPartialHunkOffsets);
    if (files.length > 0) return { kind: "files", files };
    return { kind: "raw", text: normalized, reason: "Unsupported diff format. Showing raw patch." };
  } catch {
    return { kind: "raw", text: normalized, reason: "Failed to parse patch. Showing raw patch." };
  }
}

/** The file's own path (git quotes odd names; the parser decodes them). */
export function resolveFileDiffPath(fileDiff: FileDiffMetadata): string {
  return fileDiff.name ?? fileDiff.prevName ?? "";
}

export function resolveFileDiffPreviousPath(fileDiff: FileDiffMetadata): string {
  return fileDiff.prevName ?? fileDiff.name ?? "";
}

/** A type change (file → symlink) arrives as a deletion and an addition of one
 *  path, so the change type is part of the identity. */
export function buildFileDiffIdentityKey(fileDiff: FileDiffMetadata): string {
  return `${resolveFileDiffPreviousPath(fileDiff)}\u0000${resolveFileDiffPath(fileDiff)}\u0000${fileDiff.type}`;
}

function hashPart(hash: number, value: string | number | boolean | undefined): number {
  const serialized = value === undefined ? "undefined" : String(value);
  return fnv1a32(serialized, fnv1a32(`${typeof value}:${serialized.length}:`, hash));
}

/**
 * A version for one file's content. The parser's cache key covers the whole
 * patch, so keying a viewer item by it would repaint every file when one
 * changes; this changes only when this file does.
 */
export function buildFileDiffContentVersion(fileDiff: FileDiffMetadata): number {
  let hash = FNV_OFFSET_BASIS_32;
  const append = (value: string | number | boolean | undefined) => {
    hash = hashPart(hash, value);
  };
  append(fileDiff.name);
  append(fileDiff.prevName);
  append(fileDiff.lang);
  append(fileDiff.newObjectId);
  append(fileDiff.prevObjectId);
  append(fileDiff.mode);
  append(fileDiff.prevMode);
  append(fileDiff.type);
  append(fileDiff.isPartial);
  append(fileDiff.splitLineCount);
  append(fileDiff.unifiedLineCount);
  for (const line of fileDiff.additionLines) append(line);
  for (const line of fileDiff.deletionLines) append(line);
  for (const hunk of fileDiff.hunks) {
    append(hunk.collapsedBefore);
    append(hunk.additionStart);
    append(hunk.additionCount);
    append(hunk.additionLines);
    append(hunk.additionLineIndex);
    append(hunk.deletionStart);
    append(hunk.deletionCount);
    append(hunk.deletionLines);
    append(hunk.deletionLineIndex);
    append(hunk.hunkContext);
    append(hunk.hunkSpecs);
    append(hunk.splitLineStart);
    append(hunk.splitLineCount);
    append(hunk.unifiedLineStart);
    append(hunk.unifiedLineCount);
    append(hunk.noEOFCRAdditions);
    append(hunk.noEOFCRDeletions);
    for (const content of hunk.hunkContent) {
      append(content.type);
      append(content.additionLineIndex);
      append(content.deletionLineIndex);
      append(content.type === "change" ? content.additions : content.lines);
      append(content.type === "change" ? content.deletions : undefined);
    }
  }
  return hash;
}
