// @vitest-environment happy-dom
//
// The store half of force-stopping a wedged agent (ATL-232).
//
// A cancel the agent ignores is now resolved by the backend after a grace
// period, which unfreezes the turn. An agent that is wedged outright would
// hang the next turn too, so a second press of Stop kills the process — and
// killing drops the connection along with the exit-watch task that would have
// sent `agent_disconnected`. Nothing arrives to end the turn, so the store has
// to record it. What this pins is that it records ALL of it: a session left
// `running` under a Restart banner offers the user a Stop button for a process
// that no longer exists.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}));

import { isBusyAgentStatus } from "@/types/agent";
import { useChatStore } from "./chat-store";

const TAB = "tab-1";
const ACP_SESSION = "acp-session-1";

function boundSession() {
  const { actions } = useChatStore.getState();
  actions.createSession(TAB, "claude-code");
  actions.setAcpBinding(TAB, "agent-1", ACP_SESSION, "/tmp");
  return () => useChatStore.getState().sessions[TAB];
}

describe("force-stopping a wedged agent", () => {
  beforeEach(() => {
    localStorage.clear();
    useChatStore.setState({ sessions: {}, activeSessionId: null });
  });

  it("leaves the composer idle and the session restartable", () => {
    const session = boundSession();
    const { actions } = useChatStore.getState();

    actions.updateSessionStatus(TAB, "running");
    actions.setStopping(TAB, true);
    expect(isBusyAgentStatus(session().status)).toBe(true);

    actions.noteAgentKilled(TAB);

    expect(session().disconnected).toBe(true);
    expect(session().stopping).toBeUndefined();
    expect(session().inflightToolIds).toBeUndefined();
    expect(isBusyAgentStatus(session().status)).toBe(false);
  });

  it("keeps the transcript and the binding a restart resumes from", () => {
    const session = boundSession();
    const { actions } = useChatStore.getState();

    actions.addMessage(TAB, "user", "do the thing");
    const before = session().messages.length;
    expect(before).toBeGreaterThan(0);

    actions.noteAgentKilled(TAB);

    expect(session().messages.length).toBe(before);
    expect(session().acpSessionId).toBe(ACP_SESSION);
    expect(session().acpAgentId).toBe("agent-1");
  });

  it("is harmless for a session that is not there", () => {
    expect(() => useChatStore.getState().actions.noteAgentKilled("no-such-tab")).not.toThrow();
  });
});
