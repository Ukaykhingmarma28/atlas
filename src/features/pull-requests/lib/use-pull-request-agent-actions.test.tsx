// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

const { writeGuide } = vi.hoisted(() => ({ writeGuide: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("./pr-agent-session", () => ({
  actionAgent: () => ({ agent: "claude", label: "Claude" }),
  currentSessionTab: () => null,
  openHandoffSession: vi.fn(),
}));
vi.mock("./pull-request-guide-queries", () => ({
  guideQueryKey: () => ["guide"],
  usePrGuide: () => ({ data: null, isPending: false }),
}));
vi.mock("../stores/guide-run-store", () => ({
  guideRunKey: () => "key",
  useGuideRunStore: () => null,
  writeGuide,
}));

import type { PrDetail } from "./pull-requests-types";
import { usePullRequestAgentActions } from "./use-pull-request-agent-actions";

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>;
}

const detail = (isCrossRepository: boolean) =>
  ({
    number: 5,
    repository: "acme/shop",
    headSha: "abc",
    state: "open",
    isCrossRepository,
    checks: [],
    capabilities: { review: {} },
    viewerPermissions: {},
  }) as unknown as PrDetail;

function guideFor(isCrossRepository: boolean) {
  return renderHook(
    () =>
      usePullRequestAgentActions({
        repoPath: "/repo",
        number: 5,
        detail: detail(isCrossRepository),
        activity: null,
      }).guide,
    { wrapper },
  );
}

afterEach(() => writeGuide.mockClear());

describe("Write guide", () => {
  it("starts at once for a pull request from the repository itself", () => {
    const { result } = guideFor(false);
    act(() => result.current.write());
    expect(writeGuide).toHaveBeenCalledTimes(1);
    expect(result.current.forkConfirm).toBeNull();
  });

  it("asks first for a pull request from a fork, and starts only on yes", () => {
    const { result } = guideFor(true);
    act(() => result.current.write());
    expect(writeGuide).not.toHaveBeenCalled();
    expect(result.current.forkConfirm).not.toBeNull();

    act(() => result.current.forkConfirm!.cancel());
    expect(result.current.forkConfirm).toBeNull();
    expect(writeGuide).not.toHaveBeenCalled();

    act(() => result.current.write());
    act(() => result.current.forkConfirm!.confirm());
    expect(writeGuide).toHaveBeenCalledTimes(1);
    expect(result.current.forkConfirm).toBeNull();
  });
});
