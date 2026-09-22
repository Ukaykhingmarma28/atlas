// @vitest-environment happy-dom
//
// Resuming a session must put the AGENT into the mode the user picked, not
// just the picker. Both halves of issue 289's second bug live here: the mode being
// silently reset to Ask after a crash, and the picker showing one mode while
// the engine enforced another.

import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn(async (..._args: unknown[]): Promise<unknown> => undefined);
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}));

import type { SessionKey, SessionModeInfo, SessionSnapshot } from "@/types/agents";
import { useChatStore } from "../stores/chat-store";
import { saveLastModePref } from "./last-mode-pref";
import { applyModeOnResume, resolveEffectiveMode } from "./resume-mode";

const TAB = "tab-1";
const KEY: SessionKey = { agent_id: "agent-1", session_id: "acp-1" };

const MODES: SessionModeInfo[] = [
  { id: "default", name: "Ask", description: "Prompt before edits and commands" },
  { id: "bypass", name: "Bypass", description: "Run everything without prompting" },
] as SessionModeInfo[];

function snapshot(over: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    agent_id: "agent-1",
    session_id: "acp-1",
    cwd: "/tmp/project",
    plugin_id: "codex",
    status: "idle",
    current_mode: "default",
    current_model: null,
    available_modes: MODES,
    available_models: [],
    available_commands: [],
    ...over,
  } as unknown as SessionSnapshot;
}

/** A tab on `codex`, seeded the way a real resume seeds it. */
function tabWithPref(pref: string | null) {
  if (pref) saveLastModePref("codex", pref);
  useChatStore.getState().actions.createSession(TAB, "codex");
}

function setModeCalls() {
  return invoke.mock.calls.filter((c) => c[0] === "agents_set_mode");
}

beforeEach(() => {
  localStorage.clear();
  invoke.mockClear();
  invoke.mockImplementation(async () => undefined);
  useChatStore.setState({
    sessions: {},
    pendingPermissions: {},
    queues: {},
    activeSessionId: null,
  });
});

describe("resolveEffectiveMode", () => {
  it("keeps an explicit pick the agent advertises", () => {
    expect(resolveEffectiveMode("bypass", "default", MODES)).toBe("bypass");
  });

  it("drops a pick the agent does not advertise, rather than sticking the picker on it", () => {
    expect(resolveEffectiveMode("yolo", "default", MODES)).toBe("default");
  });

  it("falls back to the agent's own mode when the user never picked one", () => {
    expect(resolveEffectiveMode(undefined, "default", MODES)).toBe("default");
  });

  it("trusts the pick when the agent advertises no modes at all", () => {
    expect(resolveEffectiveMode("bypass", null, [])).toBe("bypass");
  });
});

describe("applyModeOnResume", () => {
  it("restores the mode the user explicitly picked, Bypass included", async () => {
    tabWithPref("bypass");
    await applyModeOnResume(TAB, KEY, snapshot());

    expect(setModeCalls()).toHaveLength(1);
    expect(setModeCalls()[0]?.[1]).toMatchObject({ modeId: "bypass" });
    expect(useChatStore.getState().sessions[TAB]?.acpCurrentMode).toBe("bypass");
  });

  it("leaves the agent alone when the user never picked a mode", async () => {
    tabWithPref(null);
    await applyModeOnResume(TAB, KEY, snapshot());

    expect(setModeCalls()).toHaveLength(0);
    expect(useChatStore.getState().sessions[TAB]?.acpCurrentMode).toBe("default");
  });

  it("does not push a mode the agent already reports", async () => {
    tabWithPref("default");
    await applyModeOnResume(TAB, KEY, snapshot({ current_mode: "default" }));

    expect(setModeCalls()).toHaveLength(0);
  });

  it("drops a pick the agent no longer advertises and shows what it does have", async () => {
    tabWithPref("retired-mode");
    await applyModeOnResume(TAB, KEY, snapshot());

    expect(setModeCalls()).toHaveLength(0);
    expect(useChatStore.getState().sessions[TAB]?.acpCurrentMode).toBe("default");
  });

  it("shows the agent's mode, not the wanted one, when the agent refuses", async () => {
    tabWithPref("bypass");
    invoke.mockImplementation(async (...args: unknown[]) => {
      if (args[0] === "agents_set_mode") throw new Error("busy");
      return undefined;
    });

    await applyModeOnResume(TAB, KEY, snapshot());

    expect(setModeCalls()).toHaveLength(1);
    expect(useChatStore.getState().sessions[TAB]?.acpCurrentMode).toBe("default");
  });
});

describe("applyModeOnResume: an agent that advertises no modes", () => {
  it("leaves the picker alone rather than blanking it", async () => {
    tabWithPref("bypass");
    const before = useChatStore.getState().sessions[TAB]?.acpCurrentMode;
    await applyModeOnResume(TAB, KEY, snapshot({ available_modes: [], current_mode: null }));

    // Nothing was advertised, so there was nothing to validate against and
    // nothing to seed from. The stored pick still stands.
    expect(useChatStore.getState().sessions[TAB]?.acpCurrentMode).toBe(before);
  });
});
