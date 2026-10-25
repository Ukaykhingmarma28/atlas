// The durable key a local comment hangs off: the same across a history
// reload that re-mints every message id, distinct for two identical prompts,
// and absent for a row nothing can attach to.

import { describe, expect, it } from "vitest";

import type { ChatMessage } from "@/types/agent";

import { buildLocalAnchorMap, textHash } from "./local-comment-anchors";

function message(
  id: string,
  role: "user" | "assistant",
  content: string,
  extra: Partial<ChatMessage> = {},
): ChatMessage {
  return {
    id,
    role,
    content,
    toolCalls: [],
    fileChanges: [],
    plan: null,
    timestamp: "2026-10-26T00:00:00.000Z",
    ...extra,
  } as ChatMessage;
}

describe("buildLocalAnchorMap", () => {
  it("keys a message by its role and shown text, not its id", () => {
    const before = buildLocalAnchorMap([
      message("msg-1", "user", "continue"),
      message("msg-2", "assistant", "Done.", { mode: "text" }),
    ]);
    const after = buildLocalAnchorMap([
      message("msg-9", "user", "continue", { timestamp: "2026-10-27T00:00:00.000Z" }),
      message("msg-10", "assistant", "Done.", { mode: "text" }),
    ]);
    expect(before.rowIdByChatKey.get("msg-1")?.rowId).toBe(
      after.rowIdByChatKey.get("msg-9")?.rowId,
    );
    expect(before.rowIdByChatKey.get("msg-2")?.rowId).toBe(
      after.rowIdByChatKey.get("msg-10")?.rowId,
    );
    expect(after.rowIdByChatKey.get("msg-9")?.anchorKind).toBe("message");
    expect(after.chatKeyByRowId.get(after.rowIdByChatKey.get("msg-9")!.rowId)).toBe("msg-9");
  });

  it("tells two identical prompts apart by their order", () => {
    const map = buildLocalAnchorMap([
      message("a", "user", "continue"),
      message("b", "assistant", "ok", { mode: "text" }),
      message("c", "user", "continue"),
    ]);
    const first = map.rowIdByChatKey.get("a")!.rowId;
    const second = map.rowIdByChatKey.get("c")!.rowId;
    expect(first).not.toBe(second);
    expect(first.endsWith(":0")).toBe(true);
    expect(second.endsWith(":1")).toBe(true);
  });

  it("keys tool calls by their wire id and skips tool-only messages", () => {
    const map = buildLocalAnchorMap([
      message("u", "user", "run it"),
      message("t", "assistant", "", {
        mode: "tool",
        toolCalls: [{ id: "call-1", toolName: "Bash" } as ChatMessage["toolCalls"][number]],
      }),
    ]);
    expect(map.rowIdByChatKey.get("t")).toBeUndefined();
    expect(map.rowIdByChatKey.get("call-1")).toEqual({
      rowId: "tc:call-1",
      anchorKind: "tool_call",
    });
    expect(map.ordered.map((o) => o.kind)).toEqual(["prompt", "tool_call"]);
    expect(map.ordered[1].toolName).toBe("Bash");
  });

  it("keys a thinking step by its thought", () => {
    const map = buildLocalAnchorMap([
      message("th", "assistant", "", { mode: "thinking", thinking: "Checking the cache key" }),
      message("empty", "assistant", "", { mode: "thinking", thinking: "  " }),
    ]);
    expect(map.rowIdByChatKey.get("th")?.rowId).toBe(`th:${textHash("Checking the cache key")}:0`);
    expect(map.rowIdByChatKey.get("empty")).toBeUndefined();
  });

  it("is empty for no messages", () => {
    expect(buildLocalAnchorMap([]).ordered).toEqual([]);
  });
});
