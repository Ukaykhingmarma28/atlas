import { describe, expect, it } from "vitest";

import type { ChatMessage, ToolCallDisplay } from "@/types/agent";

import { buildAnchorMap, structureKey, type AnchorEntry } from "./comment-anchors";
import { projectRows } from "./turn-rows";

let n = 0;
function msg(partial: Partial<ChatMessage> & { role: ChatMessage["role"] }): ChatMessage {
  n += 1;
  return {
    id: `msg-${n}`,
    content: "",
    toolCalls: [],
    fileChanges: [],
    plan: null,
    timestamp: `2026-09-26T00:00:${String(n).padStart(2, "0")}Z`,
    ...partial,
  };
}
function tool(id: string): ToolCallDisplay {
  return {
    id,
    toolName: "Read",
    kind: null,
    arguments: {},
    result: null,
    status: "completed",
    duration: null,
  };
}
function entry(partial: Partial<AnchorEntry> & Pick<AnchorEntry, "rowId" | "kind" | "turnSeq">) {
  return { nativeId: null, toolName: null, ...partial } as AnchorEntry;
}

describe("buildAnchorMap", () => {
  it("matches live assistant ids and tool ids exactly", () => {
    const messages = [
      msg({ id: "u1", role: "user", content: "hi" }),
      msg({ id: "a1", role: "assistant", content: "hello", mode: "text" }),
      msg({ id: "a2", role: "assistant", mode: "tool", toolCalls: [tool("call-1")] }),
    ];
    const entries = [
      entry({ rowId: "am-p", kind: "prompt", turnSeq: 1, nativeId: "prompt-1-x" }),
      entry({ rowId: "am-1", kind: "response", turnSeq: 1, nativeId: "a1" }),
      entry({ rowId: "tc-1", kind: "tool_call", turnSeq: 1, nativeId: "call-1", toolName: "Read" }),
    ];
    const map = buildAnchorMap(messages, entries);
    expect(map.rowIdByChatKey.get("a1")).toEqual({ rowId: "am-1", anchorKind: "message" });
    expect(map.rowIdByChatKey.get("call-1")).toEqual({ rowId: "tc-1", anchorKind: "tool_call" });
    expect(map.rowIdByChatKey.get("u1")).toEqual({ rowId: "am-p", anchorKind: "message" });
    expect(map.chatKeyByRowId.get("tc-1")).toBe("call-1");
    expect(map.ordered.map((a) => a.id)).toEqual(["am-p", "am-1", "tc-1"]);
    expect(map.workByTurn.get("t:a1")).toEqual(["tc-1"]);
  });

  it("pins a reloaded exchange to its turn through a surviving tool id", () => {
    // Reloaded: message ids are re-minted, tool ids are not.
    const messages = [
      msg({ role: "user", content: "one" }),
      msg({ role: "assistant", content: "first answer", mode: "text" }),
      msg({ role: "user", content: "two" }),
      msg({ role: "assistant", mode: "tool", toolCalls: [tool("call-9")] }),
      msg({ role: "assistant", content: "second answer", mode: "text" }),
    ];
    const entries = [
      entry({ rowId: "p1", kind: "prompt", turnSeq: 4 }),
      entry({ rowId: "r1", kind: "response", turnSeq: 4, nativeId: "wire-1" }),
      entry({ rowId: "p2", kind: "prompt", turnSeq: 5 }),
      entry({ rowId: "t2", kind: "tool_call", turnSeq: 5, nativeId: "call-9" }),
      entry({ rowId: "r2", kind: "response", turnSeq: 5, nativeId: "wire-2" }),
    ];
    const map = buildAnchorMap(messages, entries);
    expect(map.rowIdByChatKey.get(messages[0].id)?.rowId).toBe("p1");
    expect(map.rowIdByChatKey.get(messages[1].id)?.rowId).toBe("r1");
    expect(map.rowIdByChatKey.get(messages[2].id)?.rowId).toBe("p2");
    expect(map.rowIdByChatKey.get("call-9")?.rowId).toBe("t2");
    expect(map.rowIdByChatKey.get(messages[4].id)?.rowId).toBe("r2");
  });

  it("aligns from the end when capture started mid-session", () => {
    const messages = [
      msg({ role: "user", content: "before capture" }),
      msg({ role: "assistant", content: "old", mode: "text" }),
      msg({ role: "user", content: "two" }),
      msg({ role: "assistant", content: "b", mode: "text" }),
      msg({ role: "user", content: "three" }),
      msg({ role: "assistant", content: "c", mode: "text" }),
    ];
    const entries = [
      entry({ rowId: "p2", kind: "prompt", turnSeq: 1 }),
      entry({ rowId: "r2", kind: "response", turnSeq: 1 }),
      entry({ rowId: "p3", kind: "prompt", turnSeq: 2 }),
      entry({ rowId: "r3", kind: "response", turnSeq: 2 }),
    ];
    const map = buildAnchorMap(messages, entries);
    expect(map.rowIdByChatKey.has(messages[0].id)).toBe(false);
    expect(map.rowIdByChatKey.has(messages[1].id)).toBe(false);
    expect(map.rowIdByChatKey.get(messages[2].id)?.rowId).toBe("p2");
    expect(map.rowIdByChatKey.get(messages[3].id)?.rowId).toBe("r2");
    expect(map.rowIdByChatKey.get(messages[4].id)?.rowId).toBe("p3");
    expect(map.rowIdByChatKey.get(messages[5].id)?.rowId).toBe("r3");
  });

  it("pairs thinking with thinking and skips empty text messages", () => {
    const messages = [
      msg({ role: "user", content: "q" }),
      msg({ role: "assistant", mode: "thinking", thinking: "hmm" }),
      msg({ role: "assistant", mode: "text", content: "" }),
      msg({ role: "assistant", mode: "text", content: "part one" }),
      msg({ role: "assistant", mode: "text", content: "part two" }),
    ];
    const entries = [
      entry({ rowId: "p", kind: "prompt", turnSeq: 1 }),
      entry({ rowId: "th", kind: "thinking", turnSeq: 1 }),
      entry({ rowId: "r1", kind: "response", turnSeq: 1 }),
      entry({ rowId: "r2", kind: "response", turnSeq: 1 }),
    ];
    const map = buildAnchorMap(messages, entries);
    expect(map.rowIdByChatKey.get(messages[1].id)?.rowId).toBe("th");
    expect(map.rowIdByChatKey.has(messages[2].id)).toBe(false);
    expect(map.rowIdByChatKey.get(messages[3].id)?.rowId).toBe("r1");
    expect(map.rowIdByChatKey.get(messages[4].id)?.rowId).toBe("r2");
    expect(map.workByTurn.get(`t:${messages[1].id}`)).toEqual(["th"]);
  });

  it("leaves a trailing exchange with no captured turn unmatched", () => {
    const messages = [
      msg({ role: "user", content: "one" }),
      msg({ role: "assistant", content: "a", mode: "text" }),
      msg({ role: "user", content: "just sent" }),
    ];
    const entries = [
      entry({ rowId: "p1", kind: "prompt", turnSeq: 1 }),
      entry({ rowId: "r1", kind: "response", turnSeq: 1 }),
    ];
    const map = buildAnchorMap(messages, entries);
    expect(map.rowIdByChatKey.get(messages[0].id)?.rowId).toBe("p1");
    expect(map.rowIdByChatKey.has(messages[2].id)).toBe(false);
  });

  it("names work turns the way the projection does", () => {
    const messages = [
      msg({ role: "user", content: "q" }),
      msg({ role: "assistant", mode: "tool", toolCalls: [tool("c1")] }),
      msg({ role: "assistant", mode: "text", content: "done" }),
    ];
    const entries = [
      entry({ rowId: "p", kind: "prompt", turnSeq: 1 }),
      entry({ rowId: "t", kind: "tool_call", turnSeq: 1, nativeId: "c1" }),
      entry({ rowId: "r", kind: "response", turnSeq: 1 }),
    ];
    const map = buildAnchorMap(messages, entries);
    const projection = projectRows(messages, {
      streaming: false,
      expanded: new Set(),
      expandedTurns: new Set(),
    });
    const turnIds = new Set(projection.turns.map((t) => t.id));
    for (const key of map.workByTurn.keys()) expect(turnIds.has(key)).toBe(true);
  });

  it("returns the empty map for nothing", () => {
    expect(buildAnchorMap([], []).ordered).toEqual([]);
  });
});

describe("structureKey", () => {
  it("changes on a new message or tool call, not on text growth", () => {
    const a = msg({ role: "assistant", content: "he", mode: "text" });
    const k1 = structureKey([a]);
    a.content = "hello";
    expect(structureKey([a])).toBe(k1);
    expect(structureKey([a, msg({ role: "assistant", content: "x" })])).not.toBe(k1);
    expect(structureKey(undefined)).toBe("0");
  });
});
