// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The `git_repo_pull_requests` seam and its availability policy: a missing
 * or signed-out `gh` holds every repository back for a bounded time (or
 * until the window is focused), never for the whole session; a transient
 * failure is asked again soon.
 */
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

const {
  fetchRepoPullRequests,
  repoPullRequestsRefetchInterval,
  repoPullRequestsStaleTime,
  resetGhAvailabilityForTests,
} = await import("./git-pr-api");

beforeEach(() => {
  invoke.mockReset();
  resetGhAvailabilityForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("fetchRepoPullRequests", () => {
  it("asks gh once per repository", async () => {
    invoke.mockResolvedValue({ kind: "ok", byBranch: {} });
    await fetchRepoPullRequests("/repo");
    expect(invoke).toHaveBeenCalledExactlyOnceWith("git_repo_pull_requests", { path: "/repo" });
  });

  it("holds other repositories back while gh is signed out, but not forever", async () => {
    vi.useFakeTimers();
    invoke.mockResolvedValue({ kind: "unavailable", reason: "notAuthenticated" });
    await fetchRepoPullRequests("/a");
    expect(await fetchRepoPullRequests("/b")).toEqual({
      kind: "unavailable",
      reason: "notAuthenticated",
    });
    expect(invoke).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(5 * 60_000);
    invoke.mockResolvedValue({ kind: "ok", byBranch: {} });
    expect(await fetchRepoPullRequests("/b")).toEqual({ kind: "ok", byBranch: {} });
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("lets a focused window ask again at once", async () => {
    invoke.mockResolvedValue({ kind: "unavailable", reason: "notInstalled" });
    await fetchRepoPullRequests("/a");
    window.dispatchEvent(new Event("focus"));
    invoke.mockResolvedValue({ kind: "ok", byBranch: {} });
    await fetchRepoPullRequests("/b");
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("does not let one repository's failure hold the others back", async () => {
    invoke.mockResolvedValue({ kind: "failed", reason: "unsupported" });
    await fetchRepoPullRequests("/a");
    await fetchRepoPullRequests("/b");
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});

describe("when to ask again", () => {
  it("keeps an answer fresh, a dead end long, and a transient failure short", () => {
    expect(repoPullRequestsStaleTime({ kind: "ok", byBranch: {} })).toBe(5 * 60_000);
    expect(repoPullRequestsStaleTime({ kind: "failed", reason: "unsupported" })).toBe(30 * 60_000);
    expect(repoPullRequestsStaleTime({ kind: "failed", reason: "network" })).toBe(0);
    expect(repoPullRequestsRefetchInterval({ kind: "failed", reason: "network" })).toBe(30_000);
    expect(repoPullRequestsRefetchInterval({ kind: "failed", reason: "rateLimited" })).toBe(
      2 * 60_000,
    );
    expect(repoPullRequestsRefetchInterval({ kind: "ok", byBranch: {} })).toBe(false);
    expect(repoPullRequestsRefetchInterval({ kind: "unavailable", reason: "notInstalled" })).toBe(
      false,
    );
  });
});
