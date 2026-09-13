import { beforeEach, describe, expect, it } from "vitest";
import { useRemoveAgentConfirmStore } from "./remove-agent-confirm";

describe("useRemoveAgentConfirmStore", () => {
  beforeEach(() => useRemoveAgentConfirmStore.setState({ pending: null }));

  it("resolves the asker with the answer and clears the prompt", async () => {
    const { ask, settle } = useRemoveAgentConfirmStore.getState().actions;
    const answer = ask({ name: "Amp" });
    expect(useRemoveAgentConfirmStore.getState().pending?.name).toBe("Amp");
    settle(true);
    await expect(answer).resolves.toBe(true);
    expect(useRemoveAgentConfirmStore.getState().pending).toBeNull();
  });

  it("declines a superseded ask so its promise never dangles", async () => {
    const { ask, settle } = useRemoveAgentConfirmStore.getState().actions;
    const first = ask({ name: "Amp" });
    const second = ask({ name: "Codex" });
    await expect(first).resolves.toBe(false);
    settle(false);
    await expect(second).resolves.toBe(false);
  });

  it("settling with nothing pending is a no-op", () => {
    expect(() => useRemoveAgentConfirmStore.getState().actions.settle(true)).not.toThrow();
  });
});
