// Builders for agent transcript data, in the WIRE shape Rust streams
// (`SessionMessage` / `ToolCall`), so scenarios exercise the same
// delta → store → projection path a real session does.

import type { SessionMessage, ToolCall } from "@/types/agents";
import { abs } from "../project";

let n = 0;
const id = (p: string) => `${p}-${++n}`;

/** Timestamps a scenario can space out: `t(0)`, `t(12)` = 12s later. */
const T0 = Date.parse("2026-09-17T10:00:00Z");
export const t = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();

export function user(content: string, at = t(0)): SessionMessage {
  return { id: id("u"), role: "user", mode: "text", content, tool_calls: [], timestamp: at };
}

export function text(content: string, at = t(0)): SessionMessage {
  return { id: id("a"), role: "assistant", mode: "text", content, tool_calls: [], timestamp: at };
}

export function thinking(thought: string, at = t(0)): SessionMessage {
  return {
    id: id("th"),
    role: "assistant",
    mode: "thinking",
    content: "",
    thinking: thought,
    tool_calls: [],
    timestamp: at,
  };
}

/** One assistant message carrying tool calls. */
export function tools(calls: ToolCall[], at = t(0)): SessionMessage {
  return {
    id: id("tm"),
    role: "assistant",
    mode: "tool",
    content: "",
    tool_calls: calls,
    timestamp: at,
  };
}

type Opts = Partial<Pick<ToolCall, "status" | "result" | "id">>;

function call(base: Omit<ToolCall, "id" | "status" | "result" | "locations">, o: Opts): ToolCall {
  return {
    id: o.id ?? id("tc"),
    status: o.status ?? "completed",
    result: o.result ?? null,
    locations: [],
    ...base,
  };
}

export const tool = {
  read: (path: string, o: Opts = {}) =>
    call(
      {
        tool_name: `Read ${path}`,
        title: `Read ${path}`,
        kind: "read",
        arguments: { file_path: abs(path) },
      },
      o,
    ),

  search: (pattern: string, o: Opts = {}) =>
    call(
      {
        tool_name: `grep "${pattern}"`,
        title: `grep "${pattern}"`,
        kind: "search",
        arguments: { pattern },
      },
      o,
    ),

  /** A shell command. `result` is its output. */
  run: (command: string, o: Opts = {}) =>
    call({ tool_name: command, title: command, kind: "execute", arguments: { command } }, o),

  /** An edit reported as an ACP diff block. Omit `before` for a new file. */
  edit: (path: string, before: string | undefined, after: string, o: Opts = {}) =>
    call(
      {
        tool_name: "apply_patch",
        title: `Edit ${path}`,
        kind: "edit",
        arguments: {},
        content_blocks: [
          before === undefined
            ? { type: "diff", path: abs(path), newText: after }
            : { type: "diff", path: abs(path), oldText: before, newText: after },
        ],
      },
      o,
    ),

  fetch: (url: string, o: Opts = {}) =>
    call(
      { tool_name: `Fetch ${url}`, title: `Fetch ${url}`, kind: "fetch", arguments: { url } },
      o,
    ),

  /** A delegated sub-agent. ACP's `think` kind, which is what Claude Code
   *  reports a Task with — the one marker the transcript keeps a brain on. */
  delegate: (description: string, o: Opts = {}) =>
    call(
      {
        // Both fields carry the description, as this file does everywhere
        // else and as the wire does: Claude Code titles a Task with what it
        // asked for, which is the only useful thing to read on the row.
        tool_name: description,
        title: description,
        kind: "think",
        arguments: { description },
      },
      o,
    ),

  /** Anything else — an MCP tool, say. */
  other: (name: string, args: Record<string, unknown> = {}, o: Opts = {}) =>
    call({ tool_name: name, title: name, kind: "other", arguments: args }, o),
};

/** `count` lines of plausible file content. */
export function lines(count: number, prefix = "line"): string {
  return Array.from({ length: count }, (_, i) => `${prefix} ${i + 1}`).join("\n") + "\n";
}
