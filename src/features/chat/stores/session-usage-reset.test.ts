// @vitest-environment happy-dom
// Usage is per backend session. Every way a tab stops pointing at the session
// that produced the numbers has to drop them, or the next session wears the
// previous one's context gauge, split and cost until its own first turn.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}));

import { useChatStore } from "./chat-store";

const TAB = "tab-1";

const seedUsage = () =>
  useChatStore.setState((s) => ({
    sessions: {
      ...s.sessions,
      [TAB]: {
        ...s.sessions[TAB],
        acpAgentId: "agent-1",
        acpSessionId: "acp-1",
        usage: {
          input_tokens: 2,
          output_tokens: 146,
          cache_creation_tokens: 31_300,
          cache_read_tokens: 11_600,
          cost: 0.32,
        },
        contextUsage: { used: 43_100, size: 1_000_000, cost: 0 },
        compacting: true,
        pendingSavedTokens: 9,
        rateLimits: { primary: null, secondary: null, planType: "plus" },
      },
    },
  }));

const usageOf = () => {
  const s = useChatStore.getState().sessions[TAB];
  return {
    usage: s.usage,
    contextUsage: s.contextUsage,
    compacting: s.compacting,
    pendingSavedTokens: s.pendingSavedTokens,
    rateLimits: s.rateLimits,
  };
};

const NOTHING = {
  usage: undefined,
  contextUsage: undefined,
  compacting: undefined,
  pendingSavedTokens: undefined,
  rateLimits: undefined,
};

beforeEach(() => {
  localStorage.clear();
  useChatStore.setState({ sessions: {}, activeSessionId: null });
  useChatStore.getState().actions.createSession(TAB, "claude-code");
  seedUsage();
  expect(usageOf().usage?.output_tokens).toBe(146);
});

describe("session usage does not outlive its session", () => {
  it("a New Chat reset in place drops it", () => {
    useChatStore.getState().actions.clearSession(TAB);
    expect(usageOf()).toEqual(NOTHING);
  });

  it("switching the tab to another agent drops it", () => {
    useChatStore.getState().actions.switchChatAgent(TAB, "codex");
    expect(usageOf()).toEqual(NOTHING);
  });

  it("binding the tab to a different backend session drops it; the same one keeps it", () => {
    useChatStore.getState().actions.setAcpBinding(TAB, "agent-1", "acp-1", "/proj");
    expect(usageOf().usage?.output_tokens).toBe(146);
    useChatStore.getState().actions.setAcpBinding(TAB, "agent-1", "acp-2", "/proj");
    expect(usageOf()).toEqual(NOTHING);
  });
});
