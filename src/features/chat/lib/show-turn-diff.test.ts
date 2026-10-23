// @vitest-environment happy-dom
//
// Clicking a file in a turn's changed-files card (or its "Open diff"): the
// review panel opens beside the session, in that turn's scope, at the file.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}));

const openSessionChanges = vi.fn();
vi.mock("@/features/git/lib/open-session-changes", () => ({
  openSessionChanges: (...a: unknown[]) => openSessionChanges(...a),
}));

import type { ChatMessage, ChatSession, ToolCallDisplay } from "@/types/agent";
import { useAppStore } from "@/features/app/stores/app-store";
import { useChatStore } from "../stores/chat-store";
import { showTurnDiff } from "./show-turn-diff";

const edit = (id: string, path: string): ToolCallDisplay =>
  ({
    id,
    toolName: "Edit",
    kind: "edit",
    status: "completed",
    arguments: { file_path: `/repo/${path}`, old_string: "a", new_string: "b" },
    result: null,
    duration: null,
    locations: [],
  }) as ToolCallDisplay;

const message = (id: string, role: "user" | "assistant", toolCalls: ToolCallDisplay[] = []) =>
  ({
    id,
    role,
    content: "",
    toolCalls,
    fileChanges: [],
    plan: null,
    timestamp: "2026-10-01T09:00:00Z",
    mode: "text",
  }) as ChatMessage;

function seed(acpSessionId: string | undefined) {
  useChatStore.setState((s) => ({
    ...s,
    sessions: {
      "tab-1": {
        id: "tab-1",
        acpSessionId,
        messages: [
          message("u1", "user"),
          message("a2", "assistant", [edit("c1", "src/a.ts"), edit("c2", "src/b.ts")]),
          message("u3", "user"),
          message("a4", "assistant"),
        ],
      } as unknown as ChatSession,
    },
  }));
}

beforeEach(() => {
  openSessionChanges.mockReset();
  useAppStore.setState({ currentProject: { path: "/repo" } } as never);
  seed("acp-1");
});

describe("showTurnDiff", () => {
  it("opens the session's changes on the turn, at the file that was clicked", () => {
    expect(showTurnDiff("tab-1", { turnId: "t:a2", file: "/repo/src/b.ts" })).toBe(true);
    expect(openSessionChanges).toHaveBeenCalledWith(
      expect.objectContaining({
        projectPath: "/repo",
        sessionId: "acp-1",
        file: "src/b.ts",
        turnId: "t:a2",
      }),
    );
  });

  it("lands on the turn's first file for the card's Open diff", () => {
    showTurnDiff("tab-1", { turnId: "t:a2" });
    expect(openSessionChanges.mock.calls[0][0].file).toBe("src/a.ts");
  });

  it("opens nothing for a turn with no edits, or one another chat holds", () => {
    expect(showTurnDiff("tab-1", { turnId: "t:a4" })).toBe(false);
    expect(showTurnDiff("tab-2", { turnId: "t:a2" })).toBe(false);
    expect(openSessionChanges).not.toHaveBeenCalled();
  });

  it("opens nothing before the session is bound: the panel is keyed by it", () => {
    seed(undefined);
    expect(showTurnDiff("tab-1", { turnId: "t:a2" })).toBe(false);
    expect(openSessionChanges).not.toHaveBeenCalled();
  });
});
