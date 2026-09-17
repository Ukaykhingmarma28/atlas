// Scenario registry. Add a file next to this one and list it here; it is then
// reachable at `localhost:1420/?scenario=<name>`.

import type { Scenario } from "../types";
import { commsIncomingMessage } from "../fixtures/comms";
import { chatTools } from "./chat-tools";
import { gitConflict } from "./git-conflict";
import { knowledge } from "./knowledge";

const all: Scenario[] = [
  {
    name: "default",
    description: "Every surface, populated. The one to review a theme against.",
    // The only thing the default scenario cannot show by sitting still: a
    // message arriving while you are looking at something else.
    actions: { commsIncomingMessage },
  },
  chatTools,
  gitConflict,
  knowledge,
];

export const scenarios: Record<string, Scenario> = Object.fromEntries(all.map((s) => [s.name, s]));
