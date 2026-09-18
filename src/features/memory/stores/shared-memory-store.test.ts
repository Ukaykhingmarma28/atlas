// The Shared tab keeps up with the record on its own: every write to shared
// memory emits `atlas:memory-changed`, and the store re-pulls the state and
// the event list when it hears one — no click on Refresh needed.

import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

type Handler = (event: { payload: unknown }) => void;
const listeners = new Map<string, Handler[]>();
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: Handler) => {
    listeners.set(name, [...(listeners.get(name) ?? []), handler]);
    return () =>
      listeners.set(
        name,
        (listeners.get(name) ?? []).filter((h) => h !== handler),
      );
  }),
}));

import { useSharedMemoryStore } from "./shared-memory-store";

function stateWithPlan(text: string | null) {
  return {
    lastSeq: text ? 1 : 0,
    activePlan: text ? { seq: 1, agent: "claude-code", text, status: "active" } : null,
    decisions: [],
    recentChanges: [],
    facts: [],
    failures: [],
    architecture: [],
    sessionAgents: {},
    updatedAt: 0,
  };
}

let plan: string | null = null;

function fire(name: string, payload: unknown) {
  for (const handler of listeners.get(name) ?? []) handler({ payload });
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("the Shared memory store", () => {
  beforeEach(() => {
    plan = null;
    invoke.mockReset();
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "memory_get_state") return stateWithPlan(plan);
      if (cmd === "memory_list_events") return [];
      return null;
    });
    useSharedMemoryStore.setState({ projectPath: null, loaded: false });
  });

  it("re-pulls the record when shared memory changes", async () => {
    await useSharedMemoryStore.getState().actions.load("/repo");
    expect(useSharedMemoryStore.getState().state.activePlan).toBeNull();

    // An agent updates its plan; the backend writes it and says so.
    plan = "Ship the record store";
    fire("atlas:memory-changed", { root: "/repo", kinds: ["plan"] });
    await flush();

    expect(useSharedMemoryStore.getState().state.activePlan?.text).toBe("Ship the record store");
  });

  it("re-pulls the project it is showing now, once per change", async () => {
    await useSharedMemoryStore.getState().actions.load("/repo-a");
    await useSharedMemoryStore.getState().actions.load("/repo-b");

    invoke.mockClear();
    fire("atlas:memory-changed", { root: "/repo-b", kinds: ["decision"] });
    await flush();

    const pulled = invoke.mock.calls.filter(([cmd]) => cmd === "memory_get_state");
    expect(pulled).toEqual([["memory_get_state", { projectPath: "/repo-b" }]]);
  });
});
