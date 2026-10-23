// A session whose turns change files in every shape the turn diff knows:
//
// - fragments, the way Claude Code's `Edit` reports them (the replaced text
//   and its replacement, never the whole file) — the turn scope labels these
//   as excerpts;
// - whole files from `Write`, which read as created;
// - ACP `diff` blocks carrying the whole file either side;
// - a turn that only read, which gets no changed-files card;
// - a turn deep in one directory chain, which the card's tree folds into one
//   row (`src/server/api/v2/routes`).
//
// `chat-turn-changes-long` repeats the exchange until the session is long
// enough to measure scrolling against, and both carry a `streamTurn` action:
// a live turn that edits and then streams a long answer, for the cost of a
// streaming frame with settled cards above it.

import type { Scenario } from "../types";
import type { SessionMessage, ToolCall } from "@/types/agents";
import { ended, lines, text, thinking, tool, tools, user, t } from "../fixtures/chat";
import { abs } from "../project";
import { appendWithTools, closeTurn, openTurn, playTurns, streamText } from "../fake-agent";

let n = 0;
const nextId = () => `ttc-${++n}`;

/** Claude Code's `Edit`: a fragment, the text replaced and its replacement. */
function replace(path: string, oldString: string, newString: string): ToolCall {
  return {
    id: nextId(),
    tool_name: "Edit",
    title: `Edit ${path}`,
    kind: "edit",
    status: "completed",
    result: null,
    locations: [],
    arguments: { file_path: abs(path), old_string: oldString, new_string: newString },
  };
}

/** Claude Code's `Write`: the whole file, as created. */
function write(path: string, content: string): ToolCall {
  return {
    id: nextId(),
    tool_name: "Write",
    title: `Write ${path}`,
    kind: "edit",
    status: "completed",
    result: null,
    locations: [],
    arguments: { file_path: abs(path), content },
  };
}

/** An ACP `diff` block (the whole file either side), with the location the
 *  agent names it by — which is what puts it in the turn's file summary. */
function patch(path: string, before: string, after: string): ToolCall {
  return {
    ...tool.edit(path, before, after),
    // `turnFileOfToolCall` finds the path here, and counts the arguments.
    arguments: { file_path: abs(path), old_string: before, new_string: after },
  };
}

const sessionBefore = `export interface Session {
  userId: string;
  expiresAt: number;
}

export function isExpired(session: Session, now = Date.now()): boolean {
  return session.expiresAt < now;
}
`;

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

const inputBefore = lines(40, "// input");
const inputAfter = inputBefore.replace("// input 12\n", "// input 12\nexport const SIZE = 'sm';\n");

/** One exchange of four turns, offset so a repeat keeps its timestamps apart. */
function exchange(round: number, base: number): SessionMessage[][] {
  const at = (s: number) => t(base + s);
  const tag = round === 0 ? "" : ` (round ${round + 1})`;
  const all = [
    user(`Make sessions refresh before they expire, and cover it with a test${tag}.`, at(0)),
    thinking("The session module owns expiry; the login form reads it.", at(2)),
    tools(
      [
        tool.read("src/features/auth/session.ts"),
        replace(
          "src/features/auth/session.ts",
          "export function isExpired(session: Session, now = Date.now()): boolean {\n  return session.expiresAt < now;\n}\n",
          "export function isExpired(session: Session, now = Date.now()): boolean {\n  return session.expiresAt < now;\n}\n\n/** Refresh a minute early, so a request never races the expiry. */\nexport function needsRefresh(session: Session, now = Date.now()): boolean {\n  return session.expiresAt - 60_000 < now;\n}\n",
        ),
        replace(
          "src/features/auth/login-form.tsx",
          "if (isExpired(session)) signOut();",
          "if (isExpired(session)) signOut();\n    else if (needsRefresh(session)) void refresh();",
        ),
        write(
          "src/features/auth/session.test.ts",
          `import { describe, expect, it } from "vitest";\nimport { needsRefresh } from "./session";\n\ndescribe("needsRefresh", () => {\n  it("is true inside the last minute", () => {\n    expect(needsRefresh({ userId: "u", expiresAt: 30_000 }, 0)).toBe(true);\n  });\n});\n`,
        ),
      ],
      at(4),
    ),
    ended(
      text(
        "Sessions now refresh a minute before they expire. `needsRefresh` lives beside `isExpired`, the login form calls it, and a test covers the boundary.",
        at(30),
      ),
      26,
    ),

    user(`Give Button a disabled state and tidy the input sizes${tag}.`, at(60)),
    tools(
      [
        patch("src/components/ui/button.tsx", buttonBefore, buttonAfter),
        patch("src/components/ui/input.tsx", inputBefore, inputAfter),
        patch(
          "README.md",
          "# acme-app\n\nThe Acme web app.\n",
          "# acme-app\n\nThe Acme web app.\n\n## Components\n\n`Button` takes `disabled`.\n",
        ),
        patch(
          "package.json",
          `{\n  "name": "acme-app",\n  "version": "1.4.0"\n}\n`,
          `{\n  "name": "acme-app",\n  "version": "1.4.1"\n}\n`,
        ),
      ],
      at(62),
    ),
    ended(text("Button takes `disabled`, and the input exports its size.", at(80)), 18),

    user(`Where is the session cookie set${tag}?`, at(120)),
    tools([tool.read("src/server/cookies.ts"), tool.search("Set-Cookie", { took: 0.8 })], at(121)),
    ended(text("In `src/server/cookies.ts`, by `writeSessionCookie`.", at(126)), 6),

    user(`Add a users route to the v2 API${tag}.`, at(180)),
    tools(
      [
        write(
          "src/server/api/v2/routes/users.ts",
          `import { router } from "../router";\n\nrouter.get("/users", async (_req, res) => {\n  res.json(await listUsers());\n});\n`,
        ),
        replace(
          "src/server/api/v2/routes/index.ts",
          `import "./health";\n`,
          `import "./health";\nimport "./users";\n`,
        ),
      ],
      at(182),
    ),
    ended(text("`GET /v2/users` is registered and lists users.", at(195)), 13),
  ];
  // Split at each prompt: a turn is the prompt and what answers it.
  const turns: SessionMessage[][] = [];
  for (const message of all) {
    if (message.role === "user") turns.push([]);
    turns[turns.length - 1].push(message);
  }
  return turns;
}

/** A live turn: edits a file, then streams a long answer word by word. */
async function streamTurn(): Promise<void> {
  const startedAt = Date.now();
  await appendWithTools([
    user("Explain how the refresh works, in detail.", new Date().toISOString()),
  ]);
  const seq = await openTurn();
  await appendWithTools([
    tools(
      [replace("src/features/auth/session.ts", sessionBefore, `${sessionBefore}// refreshed\n`)],
      new Date().toISOString(),
    ),
  ]);
  const paragraph =
    "The session carries its expiry as an epoch millisecond, and every request checks it before it is sent. A minute before that moment the client asks for a new token, so a slow request never arrives with one that lapsed in flight. ";
  await streamText(paragraph.repeat(12), { chunkMs: 16 });
  await closeTurn(seq, { startedAt, endedAt: Date.now() });
}

/** The chat tab binds its session shortly after mount; the turns play then. */
const BIND_WAIT_MS = 1500;

export const chatTurnChanges: Scenario = {
  name: "chat-turn-changes",
  description: "Turns that change files: fragments, whole files, diff blocks, a nested chain.",
  setup: async () => {
    await new Promise((r) => setTimeout(r, BIND_WAIT_MS));
    await playTurns(exchange(0, 0));
  },
  actions: { streamTurn },
};

export const chatTurnChangesLong: Scenario = {
  name: "chat-turn-changes-long",
  description: "Thirty rounds of file-changing turns, for scroll and streaming measurements.",
  setup: async () => {
    await new Promise((r) => setTimeout(r, BIND_WAIT_MS));
    await playTurns(Array.from({ length: 30 }, (_, i) => exchange(i, i * 300)).flat());
  },
  actions: { streamTurn },
};
