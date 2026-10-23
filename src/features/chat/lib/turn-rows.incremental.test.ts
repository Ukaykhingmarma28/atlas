import { describe, expect, it } from "vitest";
import { projectRows, type ProjectOptions, type Projection } from "./turn-rows";
import type { ChatMessage, ToolCallDisplay } from "@/types/agent";

// `projectRows` re-uses the previous projection's turns when their inputs are
// unchanged. These tests hold it to one contract: the incremental projection
// is indistinguishable from projecting the same thread from scratch, and the
// turns that did not change come back as the same objects.

let clock = Date.parse("2026-10-01T09:00:00Z");
function at(minutes = 1): string {
  clock += minutes * 60_000;
  return new Date(clock).toISOString();
}

function user(id: string, content: string, minutes = 1): ChatMessage {
  return {
    id,
    role: "user",
    content,
    toolCalls: [],
    fileChanges: [],
    plan: null,
    timestamp: at(minutes),
    mode: "text",
  } as ChatMessage;
}

function call(id: string, status: ToolCallDisplay["status"] = "completed"): ToolCallDisplay {
  return {
    id,
    toolName: "read_file",
    kind: "read",
    status,
    arguments: { path: `/repo/src/${id}.ts` },
    result: null,
    duration: null,
    locations: [],
    contentBlocks: [],
  } as ToolCallDisplay;
}

function assistant(id: string, patch: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id,
    role: "assistant",
    content: "",
    toolCalls: [],
    fileChanges: [],
    plan: null,
    timestamp: at(),
    mode: "text",
    ...patch,
  } as ChatMessage;
}

/** A settled exchange: prompt, thinking, two reads, an answer. */
function exchange(n: number): ChatMessage[] {
  return [
    user(`u${n}`, `question ${n}`),
    assistant(`a${n}t`, { thinking: `thinking about ${n}` }),
    assistant(`a${n}c`, { toolCalls: [call(`c${n}a`), call(`c${n}b`)], mode: "tool" }),
    assistant(`a${n}p`, { content: `answer ${n}`, workedMs: 4_000 }),
  ];
}

function opts(patch: Partial<ProjectOptions> = {}): ProjectOptions {
  return { expanded: new Set(), expandedTurns: new Set(), streaming: false, ...patch };
}

/** What a reader can observe: rows and turns, not the reuse bookkeeping. */
function visible(p: Projection) {
  return { rows: p.rows, turns: p.turns };
}

/** Project incrementally from `prev` and check it against a fresh projection. */
function step(messages: ChatMessage[], o: ProjectOptions, prev: Projection | null): Projection {
  const next = projectRows(messages, o, prev);
  expect(visible(next)).toEqual(visible(projectRows(messages, o)));
  return next;
}

describe("incremental projection", () => {
  it("re-projects only the streaming turn and matches a fresh projection", () => {
    const history = [1, 2, 3, 4, 5].flatMap(exchange);
    let messages = [...history, user("u6", "go"), assistant("a6", { content: "" })];
    const o = opts({ streaming: true, turnInProgress: true });
    let prev = step(messages, o, null);
    const settledRows = prev.rows.filter((r) => !r.turnId.endsWith("a6"));
    const settledSegments = prev.segments.slice(0, -1);

    let text = "";
    for (let k = 0; k < 20; k++) {
      text += `chunk ${k} `;
      messages = [...messages.slice(0, -1), { ...messages[messages.length - 1], content: text }];
      prev = step(messages, o, prev);
    }
    // Every row of the settled turns is the very object the first projection
    // made: nothing above the live turn re-rendered.
    for (const row of settledRows) {
      expect(prev.rows.find((r) => r.id === row.id)).toBe(row);
    }
    // And they were not projected again to get there: the turns themselves
    // came back untouched.
    expect(prev.segments.slice(0, -1)).toEqual(settledSegments);
    prev.segments.slice(0, -1).forEach((s, k) => expect(s).toBe(settledSegments[k]));
  });

  it("follows a tool call through pending, running and done", () => {
    let messages = [...exchange(1), user("u2", "go"), assistant("a2", { mode: "tool" })];
    const o = opts({ streaming: true, turnInProgress: true });
    let prev = step(messages, o, null);
    for (const status of ["pending", "running", "completed"] as const) {
      const tail = messages[messages.length - 1];
      messages = [...messages.slice(0, -1), { ...tail, toolCalls: [call("live", status)] }];
      prev = step(messages, o, prev);
    }
  });

  it("settles the live turn when the stream ends", () => {
    const messages = [...exchange(1), user("u2", "go"), assistant("a2", { content: "done" })];
    const prev = step(messages, opts({ streaming: true, turnInProgress: true }), null);
    step(messages, opts(), prev);
  });

  it("starts a new turn, with its gap separator, after a long pause", () => {
    const messages = exchange(1);
    const prev = step(messages, opts(), null);
    const next = step([...messages, user("u2", "back again", 45)], opts(), prev);
    expect(next.rows.some((r) => r.id === "gs:u2")).toBe(true);
  });

  it("re-indexes reused turns when older history loads above them", () => {
    const older = exchange(1);
    const newer = [...exchange(2), ...exchange(3)];
    const prev = step(newer, opts(), null);
    const next = step([...older, ...newer], opts(), prev);
    expect(next.turns.map((t) => t.messageIndex)).toEqual(
      projectRows([...older, ...newer], opts()).turns.map((t) => t.messageIndex),
    );
  });

  it("re-projects when the reader opens a turn's work", () => {
    const messages = [...exchange(1), ...exchange(2)];
    const prev = step(messages, opts(), null);
    step(messages, opts({ expandedTurns: new Set(["wk:t:a1t"]) }), prev);
  });

  it("handles a rewind that drops the last turn", () => {
    const messages = [...exchange(1), ...exchange(2)];
    const prev = step(messages, opts(), null);
    step(messages.slice(0, 4), opts(), prev);
  });
});
