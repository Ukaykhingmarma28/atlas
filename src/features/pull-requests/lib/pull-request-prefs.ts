// Per-viewer conveniences the pull-request tab remembers across restarts: the
// merge method last picked, and the Summary's comment filter. Browser storage
// only — losing either costs one click — and every access is guarded, since
// storage can be missing or throw.

import type { PrMergeMethod } from "./pull-requests-types";
import type { CommentFilter } from "./pull-request-logic";

const MERGE_METHOD_KEY = "atlas:pull-request:merge-method:v1";
const COMMENT_FILTER_KEY = "atlas:pull-request:comment-filter:v1";

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Unavailable: the choice lasts this session only.
  }
}

export function lastMergeMethod(): PrMergeMethod | null {
  const value = read(MERGE_METHOD_KEY);
  return value === "merge" || value === "squash" || value === "rebase" ? value : null;
}

export function rememberMergeMethod(method: PrMergeMethod): void {
  write(MERGE_METHOD_KEY, method);
}

export const DEFAULT_COMMENT_FILTER: CommentFilter = { bots: false, resolved: false };

export function savedCommentFilter(): CommentFilter {
  const raw = read(COMMENT_FILTER_KEY);
  if (!raw) return DEFAULT_COMMENT_FILTER;
  try {
    const parsed = JSON.parse(raw) as Partial<CommentFilter>;
    return { bots: parsed.bots === true, resolved: parsed.resolved === true };
  } catch {
    return DEFAULT_COMMENT_FILTER;
  }
}

export function saveCommentFilter(filter: CommentFilter): void {
  write(COMMENT_FILTER_KEY, JSON.stringify(filter));
}
