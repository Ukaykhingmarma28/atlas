// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { resetGhGateForTests } from "./pr-errors";
import {
  detailStaleTime,
  invalidatePullRequestQueries,
  pullRequestKeys,
  STALE,
  usePrDetail,
  usePrSetFilesViewedMutation,
} from "./pull-requests-queries";
import type { PrDetail, PrFilesViewed } from "./pull-requests-types";

function wrapper(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

afterEach(() => {
  invoke.mockReset();
  resetGhGateForTests();
});

describe("pull-request queries", () => {
  it("keeps a merged pull request fresh longest and one with running checks shortest", () => {
    const detail = (patch: Partial<PrDetail>) =>
      ({ state: "open", checksState: null, ...patch }) as PrDetail;
    expect(detailStaleTime(undefined)).toBe(STALE.detail);
    expect(detailStaleTime(detail({ state: "merged" }))).toBe(STALE.mergedDetail);
    expect(detailStaleTime(detail({ checksState: "pending" }))).toBe(STALE.checks);
    expect(detailStaleTime(detail({ checksState: "passing" }))).toBe(STALE.detail);
  });

  it("files every read under its checkout, so one call marks them all stale", async () => {
    const client = new QueryClient();
    client.setQueryData(pullRequestKeys.detail("/a", 1), { n: 1 });
    client.setQueryData(pullRequestKeys.list("/a", {}), { n: 2 });
    client.setQueryData(pullRequestKeys.detail("/b", 1), { n: 3 });
    await invalidatePullRequestQueries(client, "/a");
    expect(client.getQueryState(pullRequestKeys.detail("/a", 1))?.isInvalidated).toBe(true);
    expect(client.getQueryState(pullRequestKeys.list("/a", {}))?.isInvalidated).toBe(true);
    expect(client.getQueryState(pullRequestKeys.detail("/b", 1))?.isInvalidated).toBe(false);
  });

  it("does not retry a signed-out gh", async () => {
    invoke.mockRejectedValue({ kind: "notAuthenticated" });
    const client = new QueryClient();
    const { result } = renderHook(() => usePrDetail("/repo", 9), { wrapper: wrapper(client) });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toEqual({ kind: "notAuthenticated" });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("asks nothing without a checkout or a number", () => {
    const client = new QueryClient();
    renderHook(() => usePrDetail(null, 9), { wrapper: wrapper(client) });
    renderHook(() => usePrDetail("/repo", null), { wrapper: wrapper(client) });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("ticks a file viewed at once and rolls it back if GitHub refuses", async () => {
    const client = new QueryClient();
    const key = pullRequestKeys.filesViewed("/repo", 3);
    const before: PrFilesViewed = {
      files: [
        { path: "a.ts", state: "unviewed" },
        { path: "b.ts", state: "viewed" },
      ],
      truncated: false,
    };
    client.setQueryData(key, before);
    let refuse!: (error: unknown) => void;
    invoke.mockImplementation((cmd: string) =>
      cmd === "pr_set_files_viewed"
        ? new Promise((_, reject) => (refuse = reject))
        : Promise.resolve(before),
    );
    const { result } = renderHook(() => usePrSetFilesViewedMutation("/repo", 3), {
      wrapper: wrapper(client),
    });
    act(() => result.current.mutate([{ path: "a.ts", viewed: true }]));
    await waitFor(() =>
      expect(client.getQueryData<PrFilesViewed>(key)?.files[0].state).toBe("viewed"),
    );
    await act(async () => refuse({ kind: "network" }));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(client.getQueryData<PrFilesViewed>(key)?.files[0].state).toBe("unviewed");
  });
});
