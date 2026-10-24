// A review diff big enough to measure: 60 changed TypeScript files and about
// 3,600 changed lines, so the patch passes the 120 KB cap and most files load
// one at a time. Opens the diff beside the session on load.
//
// `__atlasMock.actions.edit()` rewrites one line of a file, as an agent's
// write would, and fires the watcher event, so a live refresh can be watched
// (and timed) without a backend.

import { emit } from "@tauri-apps/api/event";
import type { Scenario } from "../types";
import { diffPreviewOf, unifiedDiff, type PreviewChange } from "../fixtures/diff";
import { MOCK_PROJECT } from "../project";

const FILES = 60;
const LINES = 120;

/** A deterministic module, with every third line rewritten in the "after",
 *  except for a run in the middle left alone: the unchanged lines between two
 *  hunks, which the viewer folds behind "N unmodified lines". */
function moduleText(index: number, edited: boolean): string {
  const lines: string[] = [`// module ${index}`, `import { assert } from "./assert";`, ""];
  for (let i = 0; i < LINES; i++) {
    const touched = edited && i % 3 === 0 && (i < 30 || i >= 60);
    const name = `value${index}_${i}`;
    lines.push(
      touched
        ? `export const ${name} = compute(${i}, "edited-${index}") ?? fallback(${i * 2}); // updated`
        : `export const ${name} = compute(${i}, "seed-${index}");`,
    );
    if (i % 10 === 9)
      lines.push(`export function check${i}(x: number): boolean {`, `  return x > ${i};`, "}");
  }
  return `${lines.join("\n")}\n`;
}

const CHANGES: PreviewChange[] = Array.from({ length: FILES }, (_, i) => ({
  path: `src/modules/group-${Math.floor(i / 10)}/module-${String(i).padStart(2, "0")}.ts`,
  before: moduleText(i, false),
  after: moduleText(i, true),
  status: "modified",
}));

const byPath = new Map(CHANGES.map((c) => [c.path, c]));
const previewOf = () =>
  diffPreviewOf(CHANGES, { baseRef: "origin/main", mergeBase: "0".repeat(40) });
let preview = previewOf();
let edits = 0;

export const diffLarge: Scenario = {
  name: "diff-large",
  description: "The review diff on 60 files and ~3,600 changed lines, past the patch cap.",
  commands: {
    git_diff_preview: () => preview,
    git_diff_file_contents: ({ filePath }) => {
      const change = byPath.get(String(filePath));
      return {
        oldText: change?.before ?? "",
        newText: change?.after ?? "",
        truncated: false,
        binary: false,
      };
    },
    git_diff_file_patch: ({ filePath }) => {
      const change = byPath.get(String(filePath));
      const patch = change ? unifiedDiff(change.before ?? "", change.after ?? "", change.path) : "";
      return { patch, truncated: false, binary: false };
    },
  },
  actions: {
    /** An agent's write to the first file: one more changed line. */
    edit: async () => {
      edits += 1;
      const first = CHANGES[0];
      first.after = `${first.after}export const appended${edits} = ${edits};\n`;
      preview = previewOf();
      await emit("atlas:explorer:changed", {
        dirs: [`${MOCK_PROJECT.path}/src/modules/group-0`],
        fullRefresh: false,
      });
      return `edit ${edits} to ${first.path}`;
    },
  },
  setup: async () => {
    const { openGitDiff } = await import("@/features/git/lib/git-diff-api");
    openGitDiff(MOCK_PROJECT.path, "", false);
  },
};
