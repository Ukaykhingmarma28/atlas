// User bubbles at every length: a one-liner, a multi-line prompt just under the
// "Show more" clamp, and a long one well past it. The bubble's shape has to
// hold at all three — a radius that suits a one-liner can clip a tall bubble.

import type { Scenario } from "../types";
import { text, user, t } from "../fixtures/chat";
import { setSeedTranscript } from "../fake-agent";

const multiLine = [
  "Dmg Assets see the path, see the new icons and finder backgrounds for dmg that i have brought",
  "i want you to search up tauri docs and see how i can integrate this into atlas. it most likely involves editing the tauri config",
  "before you do anything, go to my fork of atlas at zuhayermasud and create a feature branch, we will open a PR targeting latest dev branch 0.3.3",
  "check the app size and window size from the example dmg in the path",
].join("\n");

const long = Array.from(
  { length: 6 },
  (_, i) =>
    `Paragraph ${i + 1}: the quick brown fox jumps over the lazy dog, and then keeps running across the field until it reaches the far fence where it finally stops to rest.`,
).join("\n\n");

const transcript = [
  user("Short prompt.", t(0)),
  text("Got it.", t(1)),
  user(multiLine, t(10)),
  text("On it.", t(11)),
  user(long, t(20)),
  text("Understood.", t(21)),
];

export const chatLongPrompt: Scenario = {
  name: "chat-long-prompt",
  description: "User bubbles from one line to past the Show-more clamp.",
  init: () => setSeedTranscript(transcript),
};
