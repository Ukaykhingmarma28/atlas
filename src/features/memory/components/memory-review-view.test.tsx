// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryReviewView } from "./memory-review-view";

function entry(id: number, content: string, over: Record<string, unknown> = {}) {
  return {
    id,
    kind: "fact",
    key: "",
    content,
    status: "",
    source: "capture",
    agent: "claude-code",
    sessionId: "s1",
    confidence: 0.3,
    createdAt: 1,
    updatedAt: 2,
    lastUsedAt: null,
    uses: 0,
    revision: 1,
    state: "candidate",
    ...over,
  };
}

beforeEach(() => {
  const queue = {
    candidates: [entry(1, "Prefers small PRs"), entry(2, "always force-push")],
    merges: [
      {
        keep: entry(5, "Keep PRs small", { state: "active" }),
        drop: [
          entry(6, "Prefer small PRs", { state: "active" }),
          entry(7, "Small PRs are preferred", { state: "active" }),
        ],
      },
    ],
    conflicts: [
      {
        a: entry(8, "main needs Java 21", { state: "active" }),
        b: entry(9, "main needs Java 17", { state: "active" }),
      },
    ],
    dreams: [
      {
        id: 41,
        op: { op: "archive", id: 10, reason: "transient" },
        why: "task state",
        entries: [entry(10, "PR 412 is in review", { state: "active" })],
      },
    ],
  };
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string) => (cmd === "memory_review" ? queue : true));
});
afterEach(cleanup);

describe("the review queue", () => {
  it("approves a candidate and dismisses another", async () => {
    const user = userEvent.setup();
    render(<MemoryReviewView projectPath="/repo" />);
    await user.click((await screen.findAllByRole("button", { name: "Approve" }))[0]);
    expect(invoke).toHaveBeenCalledWith("memory_promote", { projectPath: "/repo", id: 1 });
    // The nightly review's Dismiss comes first, then one per candidate.
    await user.click(screen.getAllByRole("button", { name: "Dismiss" })[2]);
    expect(invoke).toHaveBeenCalledWith("memory_archive", { projectPath: "/repo", ids: [2] });
  });

  it("merges a proposal into its survivor", async () => {
    const user = userEvent.setup();
    render(<MemoryReviewView projectPath="/repo" />);
    await user.click(await screen.findByRole("button", { name: "Merge" }));
    expect(invoke).toHaveBeenCalledWith("memory_merge", {
      projectPath: "/repo",
      keep: 5,
      drop: [6, 7],
    });
  });

  it("keeps both sides of a conflict when told they both hold", async () => {
    const user = userEvent.setup();
    render(<MemoryReviewView projectPath="/repo" />);
    await user.click(await screen.findByRole("button", { name: "Both hold" }));
    expect(invoke).toHaveBeenCalledWith("memory_resolve_conflict", {
      projectPath: "/repo",
      a: 8,
      b: 9,
      keep: "both",
    });
  });

  it("accepts a nightly-review proposal", async () => {
    const user = userEvent.setup();
    render(<MemoryReviewView projectPath="/repo" />);
    await user.click(await screen.findByRole("button", { name: "Accept" }));
    expect(invoke).toHaveBeenCalledWith("memory_dream_accept", { projectPath: "/repo", id: 41 });
  });

  it("says when there is nothing to review", async () => {
    invoke.mockImplementation(async () => ({
      candidates: [],
      merges: [],
      conflicts: [],
      dreams: [],
    }));
    render(<MemoryReviewView projectPath="/repo" />);
    expect(await screen.findByText("Nothing to review")).toBeTruthy();
  });
});
