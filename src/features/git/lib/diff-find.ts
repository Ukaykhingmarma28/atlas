// Find in the review diff: the matching, and the painting of matches.
//
// The search reads each file's diff DATA, never the rendered rows: the viewer
// virtualizes, so most rows are not in the DOM, and a folded file has none at
// all. Searching the data finds a match wherever it is; going to one unfolds
// its file and scrolls the viewer to its line.
//
// Matches are painted with the CSS Custom Highlight API: ranges over the text
// of the rows that happen to be mounted, rebuilt whenever the viewer mounts
// others. Nothing is written into the rendered DOM, so the viewer's own render
// caches never see a highlight, and painting costs a walk of the visible rows.

import type { FileDiffMetadata } from "@pierre/diffs";

/** Past this many, a query is too broad to be worth stepping through. */
export const MAX_DIFF_FIND_MATCHES = 10_000;

/** The two highlight names; their colours are `::highlight()` rules in the
 *  viewer's stylesheet (`styled-code-view.tsx`), since a highlight is styled
 *  by the tree its text lives in. */
export const DIFF_FIND_HIGHLIGHT = "atlas-diff-find";
export const DIFF_FIND_CURRENT_HIGHLIGHT = "atlas-diff-find-current";

export interface DiffFindMatch {
  /** The viewer item (file) the match is in. */
  id: string;
  /** Which side's line the text is on. Unchanged lines are `additions`, as
   *  the viewer addresses them. */
  side: "additions" | "deletions";
  /** An unchanged line, drawn in both columns of the split view. */
  context: boolean;
  /** The line's number on `side`. */
  lineNumber: number;
  /** An unchanged line's number on the old side: the split view's left copy. */
  deletionLineNumber: number;
  /** Offsets into the line's text. */
  start: number;
  end: number;
}

export interface DiffFindQuery {
  text: string;
  matchCase: boolean;
}

export interface DiffFindItem {
  id: string;
  fileDiff: FileDiffMetadata;
}

function trimLineBreak(text: string): string {
  if (text.endsWith("\r\n")) return text.slice(0, -2);
  if (text.endsWith("\n") || text.endsWith("\r")) return text.slice(0, -1);
  return text;
}

/**
 * Every occurrence of `query` in the files' changed and unchanged hunk lines,
 * in the order the unified view draws them (a change block's removals before
 * its additions). Plain text, not a pattern; case-insensitive unless asked.
 */
export function findInDiff(
  items: readonly DiffFindItem[],
  query: DiffFindQuery,
  limit = MAX_DIFF_FIND_MATCHES,
): DiffFindMatch[] {
  const needle = query.matchCase ? query.text : query.text.toLowerCase();
  if (needle === "" || needle.includes("\n")) return [];
  const out: DiffFindMatch[] = [];

  const scan = (
    raw: string | undefined,
    id: string,
    side: DiffFindMatch["side"],
    context: boolean,
    lineNumber: number,
    deletionLineNumber: number,
  ): boolean => {
    if (raw === undefined) return true;
    const line = trimLineBreak(raw);
    const hay = query.matchCase ? line : line.toLowerCase();
    let from = hay.indexOf(needle);
    while (from !== -1) {
      out.push({
        id,
        side,
        context,
        lineNumber,
        deletionLineNumber,
        start: from,
        end: from + needle.length,
      });
      if (out.length >= limit) return false;
      from = hay.indexOf(needle, from + needle.length);
    }
    return true;
  };

  for (const { id, fileDiff } of items) {
    const { additionLines, deletionLines } = fileDiff;
    for (const hunk of fileDiff.hunks) {
      const addNumber = (index: number) => hunk.additionStart + index - hunk.additionLineIndex;
      const delNumber = (index: number) => hunk.deletionStart + index - hunk.deletionLineIndex;
      for (const block of hunk.hunkContent) {
        if (block.type === "context") {
          for (let i = 0; i < block.lines; i++) {
            const a = block.additionLineIndex + i;
            const d = block.deletionLineIndex + i;
            if (!scan(additionLines[a], id, "additions", true, addNumber(a), delNumber(d)))
              return out;
          }
          continue;
        }
        for (let i = 0; i < block.deletions; i++) {
          const d = block.deletionLineIndex + i;
          if (!scan(deletionLines[d], id, "deletions", false, delNumber(d), delNumber(d)))
            return out;
        }
        for (let i = 0; i < block.additions; i++) {
          const a = block.additionLineIndex + i;
          if (!scan(additionLines[a], id, "additions", false, addNumber(a), -1)) return out;
        }
      }
    }
  }
  return out;
}

/** The match index to start from: the first match at or after `fromId`'s file
 *  (the file at the top of the viewer), else the first. */
export function firstMatchFrom(
  matches: readonly DiffFindMatch[],
  order: readonly string[],
  fromId: string | null,
): number {
  if (matches.length === 0) return -1;
  if (!fromId) return 0;
  const start = order.indexOf(fromId);
  if (start <= 0) return 0;
  const rank = new Map(order.map((id, i) => [id, i]));
  const index = matches.findIndex((m) => (rank.get(m.id) ?? 0) >= start);
  return index === -1 ? 0 : index;
}

/** Where a match is drawn, as the keys of the line elements it paints: a
 *  changed line once, an unchanged one in each column it appears in. */
export function lineKeysOf(match: DiffFindMatch): string[] {
  if (!match.context) return [`${match.side === "deletions" ? "d" : "a"}:${match.lineNumber}`];
  const unified = `c:${match.lineNumber}:${match.deletionLineNumber}`;
  if (match.lineNumber === match.deletionLineNumber) return [unified];
  return [unified, `c:${match.deletionLineNumber}:${match.lineNumber}`];
}

/** The key of a rendered line element (`[data-line]`), in `lineKeysOf`'s
 *  terms; null for a row that is not a line of the diff. */
export function lineKeyOfElement(element: Element): string | null {
  const line = element.getAttribute("data-line");
  const type = element.getAttribute("data-line-type");
  if (line === null || type === null) return null;
  if (type === "change-deletion") return `d:${line}`;
  if (type === "change-addition") return `a:${line}`;
  return `c:${line}:${element.getAttribute("data-alt-line") ?? ""}`;
}

/** A DOM range over characters `start`–`end` of a line element's text. */
export function textRange(element: Element, start: number, end: number): Range | null {
  const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let consumed = 0;
  let startNode: Text | null = null;
  let startOffset = 0;
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    const length = node.data.length;
    if (!startNode && start < consumed + length) {
      startNode = node;
      startOffset = start - consumed;
    }
    if (startNode && end <= consumed + length) {
      const range = element.ownerDocument.createRange();
      range.setStart(startNode, startOffset);
      range.setEnd(node, end - consumed);
      return range;
    }
    consumed += length;
  }
  return null;
}

interface Highlights {
  all: Highlight;
  current: Highlight;
}

let shared: Highlights | null | undefined;

/** The page's two highlight entries, made once; null where the API is
 *  missing (a test DOM), and painting is then a no-op. */
function highlights(): Highlights | null {
  if (shared !== undefined) return shared;
  if (typeof CSS === "undefined" || !("highlights" in CSS) || typeof Highlight === "undefined") {
    shared = null;
    return shared;
  }
  shared = { all: new Highlight(), current: new Highlight() };
  CSS.highlights.set(DIFF_FIND_HIGHLIGHT, shared.all);
  CSS.highlights.set(DIFF_FIND_CURRENT_HIGHLIGHT, shared.current);
  return shared;
}

/** One rendered file: its id and the root its rows are drawn in. */
export interface MountedFile {
  id: string;
  root: ParentNode;
}

/**
 * Paint `matches` over the rows that are mounted now, the `current` one in
 * its own highlight. Returns the current match's line element when it is
 * mounted. Clears every previous range first: one find bar owns the entries.
 */
export function paintMatches(
  mounted: readonly MountedFile[],
  byFile: ReadonlyMap<string, readonly DiffFindMatch[]>,
  current: DiffFindMatch | null,
): Element | null {
  const h = highlights();
  if (!h) return null;
  h.all.clear();
  h.current.clear();
  let currentElement: Element | null = null;
  for (const file of mounted) {
    const matches = byFile.get(file.id);
    if (!matches?.length) continue;
    // A list per key: in the split view an unchanged line numbered the same
    // on both sides is two elements under one key.
    const lines = new Map<string, Element[]>();
    for (const element of file.root.querySelectorAll("[data-line][data-line-type]")) {
      const key = lineKeyOfElement(element);
      if (!key) continue;
      const list = lines.get(key);
      if (list) list.push(element);
      else lines.set(key, [element]);
    }
    for (const match of matches) {
      for (const key of lineKeysOf(match)) {
        for (const element of lines.get(key) ?? []) {
          const range = textRange(element, match.start, match.end);
          if (!range) continue;
          if (match === current) {
            h.current.add(range);
            currentElement ??= element;
          } else h.all.add(range);
        }
      }
    }
  }
  return currentElement;
}

export function clearMatches(): void {
  const h = highlights();
  h?.all.clear();
  h?.current.clear();
}

/** Matches grouped by file, in order. */
export function groupByFile(matches: readonly DiffFindMatch[]): Map<string, DiffFindMatch[]> {
  const out = new Map<string, DiffFindMatch[]>();
  for (const match of matches) {
    let list = out.get(match.id);
    if (!list) out.set(match.id, (list = []));
    list.push(match);
  }
  return out;
}
