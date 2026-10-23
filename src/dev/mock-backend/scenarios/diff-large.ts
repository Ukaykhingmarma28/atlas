// A review diff big enough to measure: 60 changed TypeScript files and about
// 5,000 changed lines, so the patch passes the 120 KB cap and most files load
// one at a time. Opens the diff beside the session on load.

import type { Scenario } from "../types";
import { diffPreviewOf, type PreviewChange } from "../fixtures/diff";
import { MOCK_PROJECT } from "../project";

const FILES = 60;
const LINES = 120;

/** A deterministic module, with every third line rewritten in the "after". */
function moduleText(index: number, edited: boolean): string {
  const lines: string[] = [`// module ${index}`, `import { assert } from "./assert";`, ""];
  for (let i = 0; i < LINES; i++) {
    const touched = edited && i % 3 === 0;
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
const PREVIEW = diffPreviewOf(CHANGES, { baseRef: "origin/main", mergeBase: "0".repeat(40) });

export const diffLarge: Scenario = {
  name: "diff-large",
  description: "The review diff on 60 files and ~5,000 changed lines, past the patch cap.",
  commands: {
    git_diff_preview: () => PREVIEW,
    git_diff_file_contents: ({ filePath }) => {
      const change = byPath.get(String(filePath));
      return {
        oldText: change?.before ?? "",
        newText: change?.after ?? "",
        truncated: false,
        binary: false,
      };
    },
  },
  setup: async () => {
    const { openGitDiff } = await import("@/features/git/lib/git-diff-api");
    openGitDiff(MOCK_PROJECT.path, "", false);
  },
};
