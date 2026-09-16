// Scenario registry. Add a file next to this one and list it here; it is then
// reachable at `localhost:1420/?scenario=<name>`.

import type { Scenario } from "../types";
import { chatTools } from "./chat-tools";
import { gitConflict } from "./git-conflict";

const all: Scenario[] = [
  {
    name: "default",
    description: "Base startup data only.",
  },
  chatTools,
  gitConflict,
];

export const scenarios: Record<string, Scenario> = Object.fromEntries(all.map((s) => [s.name, s]));
