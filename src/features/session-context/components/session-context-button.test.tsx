// @vitest-environment happy-dom
//
// The trigger's one promise: while capture records, a steady dot says so —
// visible without opening anything, and never animated.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const invoke = vi.hoisted(() => vi.fn(async (_cmd: string, _args?: unknown) => null as unknown));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (c: string, a?: unknown) => invoke(c, a) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}));

import { resetProjectFactsCache } from "@/features/capture/lib/project-facts";
import { useProjectStore } from "@/features/projects/stores/project-store";
import { useSessionContextStore } from "../stores/session-context-store";
import { SessionContextButton } from "./session-context-button";

const PATH = "/work/acme";

function answer(enabled: boolean | null) {
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "capture_binding")
      return enabled === null
        ? null
        : { workspaceId: "p1", root: PATH, mode: "local", slug: null, enabled };
    if (cmd === "capture_health")
      return { state: enabled ? "ok" : "off", summary: "Capturing", issues: [] };
    return null;
  });
}

const dot = () => document.querySelector("[data-capture-dot]");

beforeEach(() => {
  resetProjectFactsCache();
  useProjectStore.setState({ activeProjectId: null } as never);
  useSessionContextStore.setState({ openFor: null, view: "main" });
});
afterEach(() => cleanup());

async function mount() {
  render(<SessionContextButton projectPath={PATH} />);
  // Let the binding and health reads land.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe("SessionContextButton", () => {
  it("shows a steady dot while capture records", async () => {
    answer(true);
    await mount();
    const el = dot();
    expect(el).not.toBeNull();
    expect(el?.innerHTML ?? "").not.toMatch(/animate-|pulse|ping/);
  });

  it("shows no dot when capture is paused or was never set up", async () => {
    answer(false);
    await mount();
    expect(dot()).toBeNull();
    cleanup();
    resetProjectFactsCache();
    answer(null);
    await mount();
    expect(dot()).toBeNull();
  });

  it("opens onto the grouped rows, Capture among them", async () => {
    answer(true);
    await mount();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /session context/i }));
    });
    expect(useSessionContextStore.getState().openFor).not.toBeNull();
    expect(await screen.findByText("Capture")).toBeTruthy();
    expect(screen.getByText("Recording · Local")).toBeTruthy();
  });
});
