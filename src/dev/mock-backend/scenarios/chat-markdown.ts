// Markdown stress on both sides of the thread: lists, fences, tables, inline
// code, and unbroken long lines in user bubbles and agent prose, plus a
// thinking block and a failed command. For checking block spacing, overflow
// and clipping — the things a type-scale or radius change breaks silently.

import type { Scenario } from "../types";
import { text, thinking, tool, tools, user, t } from "../fixtures/chat";
import { setSeedTranscript } from "../fake-agent";

const longToken = "a".repeat(40) + "/" + "very-long-path-segment-".repeat(8) + "end.tsx";

const userMarkdown = [
  "Two things:",
  "",
  "1. Fix the `Button` so `disabled` works",
  "2. Then run this:",
  "",
  "```bash",
  "bun run test src/components --reporter=verbose --coverage --coverage.reporter=text --coverage.include=src/components/**",
  "```",
  "",
  `Also this path never wraps: ${longToken}`,
  "",
  "| col | value |",
  "| --- | ----- |",
  "| a | 1 |",
  "| b | 2 |",
].join("\n");

const agentMarkdown = [
  "Here is the plan:",
  "",
  "- Add a `disabled` prop to `Button`",
  "- Forward it as `aria-disabled`",
  "  - nested item with `inline code`",
  "",
  "```tsx",
  'export function Button({ label, disabled }: { label: string; disabled?: boolean }) { return <button className="btn" disabled={disabled} aria-disabled={disabled}>{label}</button>; }',
  "```",
  "",
  "| File | Change | Notes |",
  "| ---- | ------ | ----- |",
  "| `src/components/button.tsx` | +6 −2 | adds the prop |",
  "| `src/components/button.test.tsx` | +26 | a very long notes cell that should wrap onto several lines instead of pushing the table wider than the column |",
  "",
  `Unbroken: ${longToken}`,
  "",
  "> A blockquote, for good measure.",
].join("\n");

const transcript = [
  user(userMarkdown, t(0)),
  thinking(
    "The user wants two things. First the Button change, then a verbose coverage run. " +
      "I should read the component before editing it, and check the test file exists.",
    t(2),
  ),
  tools(
    [
      tool.read("src/components/button.tsx"),
      tool.run("bun run test src/components --coverage", {
        status: "failed",
        result: `error: coverage provider not installed\n  at ${longToken}\n\nexit code 1`,
      }),
    ],
    t(4),
  ),
  text(agentMarkdown, t(9)),
];

export const chatMarkdown: Scenario = {
  name: "chat-markdown",
  description: "Markdown stress (lists, fences, tables, long lines) in user and agent messages.",
  init: () => setSeedTranscript(transcript),
};
