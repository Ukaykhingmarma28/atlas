import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  projects: [] as Array<{ path: string }>,
  orgListeners: [] as Array<(s: { activeOrganisationId: string | null }) => void>,
  org: { activeOrganisationId: "org-a" as string | null },
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@/features/projects/lib/org-scope", () => ({
  activeOrgProjectsSnapshot: () => mocks.projects,
}));
vi.mock("@/features/organisations/stores/org-store", () => ({
  useOrgStore: {
    getState: () => mocks.org,
    subscribe: (fn: (s: { activeOrganisationId: string | null }) => void) => {
      mocks.orgListeners.push(fn);
      return () => {};
    },
  },
}));

const { useUsageStore, STALE_MS } = await import("./usage-store");
const { NO_FACETS } = await import("../types");

const DASH = { daily: [], sessions: [], byokDaily: [] };

function reset() {
  useUsageStore.setState({
    data: null,
    loading: false,
    error: null,
    fetchedAt: null,
    projectSig: "",
    facets: NO_FACETS,
    search: "",
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-17T12:00:00Z"));
  mocks.invoke.mockReset();
  mocks.invoke.mockResolvedValue(DASH);
  mocks.projects = [{ path: "/w/a" }, { path: "/w/b" }];
  reset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("refresh", () => {
  it("invokes usage_dashboard with the active org's project paths", async () => {
    await useUsageStore.getState().actions.refresh();
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    expect(mocks.invoke).toHaveBeenCalledWith("usage_dashboard", {
      projectPaths: ["/w/a", "/w/b"],
    });
    const s = useUsageStore.getState();
    expect(s.data).toBe(DASH);
    expect(s.loading).toBe(false);
    expect(s.fetchedAt).toBe(Date.now());
  });

  it("skips a second fetch within the stale window for the same projects", async () => {
    const { refresh } = useUsageStore.getState().actions;
    await refresh();
    vi.advanceTimersByTime(STALE_MS - 1);
    await refresh();
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2);
    await refresh();
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
  });

  it("force refetches regardless of age", async () => {
    const { refresh } = useUsageStore.getState().actions;
    await refresh();
    await refresh({ force: true });
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
  });

  it("refetches when the project set changes", async () => {
    const { refresh } = useUsageStore.getState().actions;
    await refresh();
    mocks.projects = [{ path: "/w/a" }];
    await refresh();
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
    expect(mocks.invoke).toHaveBeenLastCalledWith("usage_dashboard", { projectPaths: ["/w/a"] });
  });

  it("ignores project order in the signature", async () => {
    const { refresh } = useUsageStore.getState().actions;
    await refresh();
    mocks.projects = [{ path: "/w/b" }, { path: "/w/a" }];
    await refresh();
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
  });

  it("records the error and clears loading on failure", async () => {
    mocks.invoke.mockRejectedValueOnce("boom");
    await useUsageStore.getState().actions.refresh();
    const s = useUsageStore.getState();
    expect(s.error).toBe("boom");
    expect(s.loading).toBe(false);
    expect(s.fetchedAt).toBeNull();
  });
});

describe("facets", () => {
  it("toggleFacet adds then removes a value on one axis", () => {
    const { toggleFacet } = useUsageStore.getState().actions;
    toggleFacet("agents", "codex");
    expect(useUsageStore.getState().facets).toEqual({
      projects: [],
      agents: ["codex"],
      models: [],
    });
    toggleFacet("models", "m1");
    toggleFacet("agents", "codex");
    expect(useUsageStore.getState().facets).toEqual({ projects: [], agents: [], models: ["m1"] });
  });

  it("clearFacets resets every axis", () => {
    const { toggleFacet, clearFacets } = useUsageStore.getState().actions;
    toggleFacet("projects", "/w/a");
    toggleFacet("agents", "codex");
    clearFacets();
    expect(useUsageStore.getState().facets).toEqual(NO_FACETS);
  });

  it("an org switch drops data and facets", async () => {
    await useUsageStore.getState().actions.refresh();
    useUsageStore.getState().actions.toggleFacet("agents", "codex");
    expect(mocks.orgListeners.length).toBeGreaterThan(0);
    for (const fn of mocks.orgListeners) fn({ activeOrganisationId: "org-b" });
    const s = useUsageStore.getState();
    expect(s.data).toBeNull();
    expect(s.fetchedAt).toBeNull();
    expect(s.facets).toEqual(NO_FACETS);
  });
});
