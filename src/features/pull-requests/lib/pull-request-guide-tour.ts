// The Guide tab's pure helpers: stepping through stops, what a stop shows,
// and cutting an excerpt's rows out of a file's diff as a patch of its own.

import type { FileDiffMetadata } from "@pierre/diffs";

import type { GuideExcerpt, GuideNote, GuideStop } from "./pull-request-guide-types";

export function stepTourPosition(current: number, delta: 1 | -1, stopCount: number): number {
  return Math.max(Math.min(current + delta, stopCount - 1), 0);
}

export function stopFilePaths(stop: GuideStop): string[] {
  return [
    ...new Set([
      ...stop.excerpts.map((excerpt) => excerpt.path),
      ...stop.files.map((file) => file.path),
    ]),
  ];
}

export function stopSubline(stop: GuideStop): string {
  const count = stopFilePaths(stop).length;
  if (count === 0) return "Context, no code";
  return count === 1 ? "1 file" : `${count} files`;
}

function noteMarker(index: number): string {
  return index < 26 ? String.fromCharCode(65 + index) : String(index + 1);
}

export interface DiffRow {
  readonly kind: "context" | "addition" | "deletion";
  readonly oldLine: number | null;
  readonly newLine: number | null;
  readonly oldAt: number;
  readonly newAt: number;
  readonly text: string;
  readonly hunk: number;
}

export function fileDiffRows(file: FileDiffMetadata): DiffRow[] {
  const rows: DiffRow[] = [];
  file.hunks.forEach((hunk, hunkIndex) => {
    let oldAt = hunk.deletionStart;
    let newAt = hunk.additionStart;
    for (const content of hunk.hunkContent) {
      if (content.type === "context") {
        for (let offset = 0; offset < content.lines; offset += 1) {
          rows.push({
            kind: "context",
            oldLine: oldAt,
            newLine: newAt,
            oldAt,
            newAt,
            text: file.additionLines[content.additionLineIndex + offset] ?? "",
            hunk: hunkIndex,
          });
          oldAt += 1;
          newAt += 1;
        }
        continue;
      }
      for (let offset = 0; offset < content.deletions; offset += 1) {
        rows.push({
          kind: "deletion",
          oldLine: oldAt,
          newLine: null,
          oldAt,
          newAt,
          text: file.deletionLines[content.deletionLineIndex + offset] ?? "",
          hunk: hunkIndex,
        });
        oldAt += 1;
      }
      for (let offset = 0; offset < content.additions; offset += 1) {
        rows.push({
          kind: "addition",
          oldLine: null,
          newLine: newAt,
          oldAt,
          newAt,
          text: file.additionLines[content.additionLineIndex + offset] ?? "",
          hunk: hunkIndex,
        });
        newAt += 1;
      }
    }
  });
  return rows;
}

export function excerptRows(
  rows: readonly DiffRow[],
  excerpt: Pick<GuideExcerpt, "side" | "start" | "end">,
): DiffRow[] {
  const lineOf = (row: DiffRow) => (excerpt.side === "new" ? row.newLine : row.oldLine);
  const inRange = (row: DiffRow) => {
    const line = lineOf(row);
    return line !== null && line >= excerpt.start && line <= excerpt.end;
  };
  let first = rows.findIndex(inRange);
  if (first === -1) return [];
  let last = first;
  for (let i = rows.length - 1; i >= first; i -= 1) {
    if (inRange(rows[i]!)) {
      last = i;
      break;
    }
  }
  const sameHunk = (index: number, anchor: number) => rows[index]?.hunk === rows[anchor]?.hunk;
  if (excerpt.side === "new" && rows[first]?.kind === "addition") {
    while (first > 0 && rows[first - 1]?.kind === "deletion" && sameHunk(first - 1, first)) {
      first -= 1;
    }
  }
  if (excerpt.side === "old" && rows[last]?.kind === "deletion") {
    while (
      last < rows.length - 1 &&
      rows[last + 1]?.kind === "addition" &&
      sameHunk(last + 1, last)
    ) {
      last += 1;
    }
  }
  return rows.slice(first, last + 1);
}

const ROW_PREFIX = { context: " ", addition: "+", deletion: "-" } as const;

export function rowsToPatch(path: string, previousPath: string, rows: readonly DiffRow[]): string {
  if (rows.length === 0) return "";
  const lines = [
    `diff --git a/${previousPath} b/${path}`,
    `--- a/${previousPath}`,
    `+++ b/${path}`,
  ];
  let start = 0;
  while (start < rows.length) {
    let end = start;
    while (end + 1 < rows.length && rows[end + 1]?.hunk === rows[start]?.hunk) end += 1;
    const group = rows.slice(start, end + 1);
    const head = group[0]!;
    const oldCount = group.filter((row) => row.oldLine !== null).length;
    const newCount = group.filter((row) => row.newLine !== null).length;
    // Git names the line before an empty side, so a pure insertion after line 9 is `-9,0`.
    const oldStart = oldCount === 0 ? Math.max(head.oldAt - 1, 0) : head.oldAt;
    const newStart = newCount === 0 ? Math.max(head.newAt - 1, 0) : head.newAt;
    lines.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const row of group) lines.push(`${ROW_PREFIX[row.kind]}${row.text.replace(/\r?\n$/, "")}`);
    start = end + 1;
  }
  return `${lines.join("\n")}\n`;
}

export interface ExcerptNoteMarker {
  readonly line: number;
  readonly markers: ReadonlyArray<{ readonly marker: string; readonly title: string }>;
}

export function letterStopNotes(stop: GuideStop): {
  lettered: { marker: string; note: GuideNote }[];
  byExcerpt: ExcerptNoteMarker[][];
} {
  const lettered = stop.notes.map((note, index) => ({ marker: noteMarker(index), note }));
  const byExcerpt = stop.excerpts.map((excerpt) => {
    const lines = new Map<number, Array<{ marker: string; title: string }>>();
    for (const { marker, note } of lettered) {
      if (note.path !== excerpt.path || note.line < excerpt.start || note.line > excerpt.end) {
        continue;
      }
      const entry = { marker, title: note.title };
      const list = lines.get(note.line);
      if (list === undefined) lines.set(note.line, [entry]);
      else list.push(entry);
    }
    return [...lines].map(([line, markers]) => ({ line, markers }));
  });
  return { lettered, byExcerpt };
}
