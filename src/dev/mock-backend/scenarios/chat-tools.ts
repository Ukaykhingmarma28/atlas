// A chat with every tool-call state the transcript renders: a finished turn
// (folded tool block, a delegated sub-agent, edits, a failed command) followed
// by a live turn with a command still streaming output.

import type { Scenario } from "../types";
import { lines, text, thinking, tool, tools, user, t } from "../fixtures/chat";
import {
  appendToolOutput,
  finishTurn,
  playTranscript,
  requestPermission,
  requestPermissionLongArgs,
  requestPermissionPlan,
  requestPermissionQuestion,
  requestPermissionQuestionMulti,
  setSeedTranscript,
  setStatus,
  upsertToolCall,
} from "../fake-agent";

const buttonBefore = `export function Button({ label }: { label: string }) {
  return <button className="btn">{label}</button>;
}
`;
const buttonAfter = `export function Button({ label, disabled }: { label: string; disabled?: boolean }) {
  return (
    <button className="btn" disabled={disabled} aria-disabled={disabled}>
      {label}
    </button>
  );
}
`;

const settledTurn = [
  user("Add a disabled state to the Button component and make sure the tests pass.", t(0)),
  thinking(
    "I should look at the Button component and where it is used before changing its props.",
    t(2),
  ),
  tools(
    [
      tool.delegate("Find every Button call site"),
      tool.search("Button"),
      tool.read("src/components/button.tsx"),
      tool.read("src/components/header.tsx"),
      tool.run("ls src/components", { result: "button.tsx\nheader.tsx\n" }),
    ],
    t(4),
  ),
  text("The Button has no `disabled` prop yet. I'll add one and forward it to the element.", t(9)),
  tools(
    [
      tool.edit("src/components/button.tsx", buttonBefore, buttonAfter),
      tool.edit("src/components/button.test.tsx", undefined, lines(24, "// test")),
    ],
    t(11),
  ),
  tools(
    [
      tool.run("bun run test src/components", {
        status: "failed",
        result:
          "FAIL src/components/button.test.tsx\n  ✕ renders disabled (4 ms)\n\n  Expected: true\n  Received: undefined\n\nTests: 1 failed, 3 passed",
      }),
      tool.edit("src/components/button.test.tsx", lines(24, "// test"), lines(26, "// test")),
      tool.run("bun run test src/components", {
        result: "PASS src/components/button.test.tsx\n\nTests: 4 passed",
      }),
    ],
    t(20),
  ),
  text(
    "Done. `Button` now accepts `disabled`, sets `aria-disabled` to match, and the four component tests pass.",
    t(41),
  ),
];

async function liveTurn(): Promise<void> {
  await playTranscript([
    user("Now run the full test suite.", t(60)),
    text("Running the whole suite.", t(62)),
  ]);
  await setStatus("running");

  const running = tool.run("bun run test", { id: "tc-live", status: "running" });
  const message = tools([running], t(63));
  await playTranscript([message]);

  const output = [
    "RUN  v3.2.4 /Users/dev/acme-app\n",
    " ✓ src/lib/api.test.ts (12 tests) 41ms\n",
    " ✓ src/lib/utils.test.ts (8 tests) 9ms\n",
    " ✓ src/components/button.test.tsx (4 tests) 22ms\n",
  ];
  for (const delta of output) {
    await new Promise((r) => setTimeout(r, 700));
    await appendToolOutput(message.id, running.id, delta);
  }
  // Left running on purpose — that is the state worth looking at.
  finishLive = async () => {
    await upsertToolCall(message.id, {
      ...running,
      status: "completed",
      result: output.join("") + "\nTests: 24 passed",
    });
    await finishTurn();
  };
}

let finishLive = async () => {};

export const chatTools: Scenario = {
  name: "chat-tools",
  description:
    "Finished turn with folded tools, edits and a failed run; then a live running command.",
  init: () => setSeedTranscript(settledTurn),
  setup: async () => {
    // The chat tab binds its session shortly after mount; the seed plays then.
    await new Promise((r) => setTimeout(r, 1500));
    await liveTurn();
    // A scripted beat: the agent wants to run something next, so a reviewer
    // walking this scenario meets the permission modal without needing to
    // know `__atlasMock.actions` exists. Left pending like the live command
    // above — nothing auto-resolves it.
    await new Promise((r) => setTimeout(r, 3500));
    await requestPermission();
  },
  actions: {
    /** Complete the running command: `__atlasMock.actions.finishLive()`. */
    finishLive: () => finishLive(),
    // Every `permission-modal.tsx` variant, on demand.
    requestPermission,
    requestPermissionLongArgs,
    requestPermissionPlan,
    requestPermissionQuestion,
    requestPermissionQuestionMulti,
  },
};
