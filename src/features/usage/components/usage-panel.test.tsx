// @vitest-environment happy-dom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fixture } from "../lib/__fixtures__/dashboard";
import { modelDisplay } from "../lib/derive";
import { useUsageStore } from "../stores/usage-store";
import { UsagePanel } from "./usage-panel";

/**
 * happy-dom lays nothing out, so every rect is 0×0 and ResizeObserver does not exist —
 * the same stubs `timeline-sidebar.test.tsx` uses for its virtualized list. These tests
 * assert on what is IN the document, not where it is. Every stub is undone after each
 * case, so none of them outlives this file.
 */
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string) => Promise.reject(new Error(`unexpected invoke ${cmd}`))),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
  emit: vi.fn(() => Promise.resolve()),
}));

const VIEWPORT = { width: 1200, height: 900 };
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    () =>
      ({
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: VIEWPORT.width,
        bottom: VIEWPORT.height,
        ...VIEWPORT,
        toJSON() {},
      }) as DOMRect,
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("matchMedia", () => ({
    matches: true,
    addEventListener() {},
    removeEventListener() {},
  }));
  useUsageStore.setState({
    data: null,
    loading: false,
    error: null,
    fetchedAt: null,
    range: { preset: "30d" },
    facets: { projects: [], agents: [], models: [] },
    groupBy: "project",
    metric: "tokens",
    table: "sessions",
    search: "",
  } as never);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function seed(data = fixture(40)) {
  // `fetchedAt` now + a matching signature makes the mount-time refresh a no-op.
  useUsageStore.setState({ data, fetchedAt: Date.now(), projectSig: "" } as never);
  return data;
}

describe("UsagePanel", () => {
  it("shows the empty state when the org has recorded nothing", () => {
    const d = fixture(5);
    seed({ ...d, daily: [], byokDaily: [], sessions: [], sessionsTotal: 0 });
    render(<UsagePanel />);
    expect(screen.getByText("Nothing yet")).toBeInTheDocument();
    expect(screen.queryByText("Token efficiency")).not.toBeInTheDocument();
  });

  it("renders every section for a populated org", () => {
    seed();
    render(<UsagePanel />);
    // No "top" section: the ranked list was removed — the Projects / Agents /
    // Models tables say the same thing with real numbers.
    for (const section of ["stats", "classes", "chart", "insights", "efficiency"]) {
      expect(document.querySelector(`[data-section="${section}"]`), section).not.toBeNull();
    }
    expect(screen.getByRole("tab", { name: /Sessions/ })).toHaveAttribute("aria-selected", "true");
  });

  it("switches tables through the chip tabs", () => {
    const d = seed();
    render(<UsagePanel />);
    fireEvent.click(screen.getByRole("tab", { name: /Models/ }));
    expect(useUsageStore.getState().table).toBe("models");
    // One row per model the fixture recorded, under the name the table shows.
    for (const model of new Set(d.daily.map((r) => r.model))) {
      expect(screen.getByTitle(modelDisplay(model))).toBeInTheDocument();
    }
  });

  it("narrows the sessions table with the search box", () => {
    seed();
    render(<UsagePanel />);
    const tab = screen.getByRole("tab", { name: /Sessions/ });
    const shown = () =>
      Number(
        within(tab)
          .getByText(/^[\d,]+$/)
          .textContent!.replace(/,/g, ""),
      );
    const before = shown();
    fireEvent.change(screen.getByPlaceholderText("Search sessions"), {
      target: { value: "ledger" },
    });
    expect(useUsageStore.getState().search).toBe("ledger");
    // The fixture has a "ledger" project, so the search keeps some sessions and drops the rest.
    expect(shown()).toBeGreaterThan(0);
    expect(shown()).toBeLessThan(before);
  });
});
