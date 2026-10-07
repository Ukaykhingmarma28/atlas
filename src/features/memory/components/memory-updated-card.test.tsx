// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryUpdatedCard } from "./memory-updated-card";

function write(id: number, content: string, op = "insert", state = "active") {
  return { id, rev: id * 10, op, kind: "decision", content, state, at: id };
}

let writes: unknown[] = [];

beforeEach(() => {
  writes = [write(2, "Sign JWTs with EdDSA"), write(1, "always force-push", "insert", "candidate")];
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string) =>
    cmd === "memory_session_writes" ? writes : true,
  );
});
afterEach(cleanup);

describe("the Memory updated card", () => {
  it("counts what the session saved and lists it when opened", async () => {
    const user = userEvent.setup();
    render(<MemoryUpdatedCard projectPath="/repo" sessionId="s-a" />);
    await user.click(await screen.findByText("Memory updated: 2 saved"));
    expect(screen.getByText("Sign JWTs with EdDSA")).toBeTruthy();
    expect(screen.getByText("always force-push")).toBeTruthy();
    expect(screen.getByText("candidate")).toBeTruthy();
    expect(invoke).toHaveBeenCalledWith("memory_session_writes", {
      projectPath: "/repo",
      sessionId: "s-a",
      since: 0,
    });
  });

  it("forgets an entry after confirming", async () => {
    const user = userEvent.setup();
    render(<MemoryUpdatedCard projectPath="/repo" sessionId="s-a" />);
    await user.click(await screen.findByText("Memory updated: 2 saved"));
    await user.click(screen.getAllByRole("button", { name: "Forget" })[1]);
    const confirms = await screen.findAllByRole("button", { name: "Forget" });
    await user.click(confirms[confirms.length - 1]);
    expect(invoke).toHaveBeenCalledWith("memory_forget_entry", { projectPath: "/repo", id: 1 });
  });

  it("renders nothing when the session wrote nothing", async () => {
    writes = [];
    const { container } = render(<MemoryUpdatedCard projectPath="/repo" sessionId="s-a" />);
    await Promise.resolve();
    expect(container.textContent).toBe("");
  });
});
