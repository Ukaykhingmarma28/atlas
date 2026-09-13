// @vitest-environment happy-dom
//
// The in-tab switch rule for a chat that is "busy" only because its first
// message is waiting on a bind that never landed. ⌥/ used to open a NEW tab
// for any `running` status, which left the stuck tab stuck; a start with no
// session has nothing streaming to orphan, so it is switched in place and the
// held message carries over to the new agent's bind.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => undefined),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}));
const openNewAgentChat = vi.fn();
vi.mock("./open-agent-session", () => ({
  openNewAgentChat: (...a: unknown[]) => openNewAgentChat(...a),
}));

import { useChatStore } from "../stores/chat-store";
import { isStartingOnly, switchAgentForTab } from "./switch-agent";

const TAB = "tab-1";

describe("switchAgentForTab while starting", () => {
  beforeEach(() => {
    localStorage.clear();
    openNewAgentChat.mockClear();
    useChatStore.setState({ sessions: {}, queues: {}, activeSessionId: null });
    useChatStore.getState().actions.createSession(TAB, "claude-code");
  });

  it("a genuinely busy chat (session bound, turn running) still opens a new tab", () => {
    const { actions } = useChatStore.getState();
    actions.setAcpBinding(TAB, "agent-1", "acp-1", "/tmp");
    actions.updateSessionStatus(TAB, "running");
    switchAgentForTab(TAB, "codex");
    expect(openNewAgentChat).toHaveBeenCalledWith("codex");
    expect(useChatStore.getState().sessions[TAB].agentType).toBe("claude-code");
  });

  it("a chat holding a first message on an unfinished bind switches in place and carries it", () => {
    const { actions } = useChatStore.getState();
    actions.addMessage(TAB, "user", "hello there");
    actions.updateSessionStatus(TAB, "running");
    actions.setPendingSend(TAB, {
      content: "hello there",
      mentions: [],
      attachments: [],
    });
    expect(isStartingOnly(useChatStore.getState().sessions[TAB])).toBe(true);

    switchAgentForTab(TAB, "codex");

    expect(openNewAgentChat).not.toHaveBeenCalled();
    const sess = useChatStore.getState().sessions[TAB];
    expect(sess.agentType).toBe("codex");
    expect(sess.acpSessionId).toBeUndefined();
    expect(sess.status).toBe("running");
    expect(sess.pendingSend?.content).toBe("hello there");
    // Re-recorded as the new session's first bubble, once.
    expect(sess.messages.filter((m) => m.role === "user").map((m) => m.content)).toEqual([
      "hello there",
    ]);
    expect(useChatStore.getState().queues[TAB] ?? []).toEqual([]);
  });

  it("isStartingOnly is false once a session id exists", () => {
    expect(
      isStartingOnly({
        status: "running",
        pendingSend: { content: "x" },
        acpSessionId: "s",
      }),
    ).toBe(false);
    expect(isStartingOnly({ status: "idle", pendingSend: { content: "x" } })).toBe(false);
    expect(isStartingOnly(undefined)).toBe(false);
  });
});
