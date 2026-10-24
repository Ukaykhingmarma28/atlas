// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
const { split } = vi.hoisted(() => ({ split: vi.fn() }));
vi.mock("../lib/pull-request-markdown", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/pull-request-markdown")>();
  split.mockImplementation(actual.splitPullRequestBody);
  return { ...actual, splitPullRequestBody: split };
});

import { PullRequestScopeContext, type PullRequestScope } from "./pull-request-context";
import PullRequestMarkdownImpl from "./pull-request-markdown-impl";

afterEach(() => {
  cleanup();
  split.mockClear();
});

const scope = (pending: string | null): PullRequestScope => ({
  repoPath: "/repo",
  number: 1,
  repositoryUrl: "https://github.com/acme/shop",
  agent: { fixFinding: null, pending },
});

function tree(value: PullRequestScope, text: string) {
  return (
    <PullRequestScopeContext.Provider value={value}>
      <PullRequestMarkdownImpl text={text} />
    </PullRequestScopeContext.Provider>
  );
}

describe("PullRequestMarkdownImpl", () => {
  it("parses a body once while only the scope around it changes", () => {
    const { rerender } = render(tree(scope(null), "Some **bold** text"));
    expect(screen.getByText("bold").tagName).toBe("STRONG");
    expect(split).toHaveBeenCalledTimes(1);

    // A new scope object: an agent action started, the panel re-rendered.
    rerender(tree(scope("explain"), "Some **bold** text"));
    rerender(tree(scope(null), "Some **bold** text"));
    expect(split).toHaveBeenCalledTimes(1);

    rerender(tree(scope(null), "Other text"));
    expect(split).toHaveBeenCalledTimes(2);
  });
});
