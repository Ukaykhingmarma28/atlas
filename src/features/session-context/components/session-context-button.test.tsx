// @vitest-environment happy-dom
//
// The trigger's one promise: while capture records, a steady dot says so —
// visible without opening anything, and never animated.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

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
  useSessionContextStore.setState({ openFor: null, dockable: {}, dockOpen: {}, view: "main" });
});
afterEach(() => cleanup());

async function mount(tabId: string | null = null) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <SessionContextButton tabId={tabId} projectPath={PATH} />
    </QueryClientProvider>,
  );
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

  it("is a toggle for the docked card where the chat panel can dock it", async () => {
    answer(false);
    useSessionContextStore.setState({ dockable: { "tab-1": true } });
    await mount("tab-1");
    const button = screen.getByRole("button", { name: /session context/i });
    expect(button.getAttribute("aria-pressed")).toBe("false");
    await act(async () => fireEvent.click(button));
    expect(useSessionContextStore.getState().dockOpen["tab-1"]).toBe(true);
    // The card is the panel's, not a popover: nothing opened here.
    expect(useSessionContextStore.getState().openFor).toBeNull();
    expect(button.getAttribute("aria-pressed")).toBe("true");
    await act(async () => fireEvent.click(button));
    expect(useSessionContextStore.getState().dockOpen["tab-1"]).toBe(false);
  });
});
