// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { BoardSession } from "../types";
import { TimelineSidebar } from "./timeline-sidebar";

// vitest runs with `globals: false`, so RTL's auto-cleanup is not registered.
beforeEach(cleanup);

// The nav is virtualized, and a virtualizer asks the DOM how tall its scroller
// is. happy-dom lays nothing out, so every box is 0×0 and the window would be
// empty — give it a viewport and a ResizeObserver to hear about it, otherwise
// these tests assert against an empty list and pass for the wrong reason.
const VIEWPORT = { width: 320, height: 900 };
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    value(this: HTMLElement) {
      return {
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: VIEWPORT.width,
        bottom: VIEWPORT.height,
        ...VIEWPORT,
        toJSON: () => ({}),
      };
    },
  });
  for (const prop of ["clientHeight", "offsetHeight"] as const) {
    Object.defineProperty(HTMLElement.prototype, prop, {
      configurable: true,
      value: VIEWPORT.height,
    });
  }
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  HTMLElement.prototype.scrollTo ??= () => {};
});

function session(over: Partial<BoardSession> & { id: string }): BoardSession {
  // Keep the fixture in today's local calendar bucket. An "hour ago" crosses
  // midnight for the first hour of the day and made this test date-dependent.
  const todayAtNoon = new Date();
  todayAtNoon.setHours(12, 0, 0, 0);
  const hourAgo = todayAtNoon.toISOString();
  return {
    title: `Session ${over.id}`,
    agent: "claude",
    model: "claude-opus-5",
    source: "acp",
    startedAt: hourAgo,
    updatedAt: hourAgo,
    lastActivityAt: hourAgo,
    activeSeconds: 120,
    wallSeconds: 300,
    messageCount: 2,
    toolCallCount: 0,
    checkpointCount: 0,
    branches: [],
    insertions: 0,
    deletions: 0,
    filesTouched: 0,
    totalTokens: 1_000,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    contextUsed: 0,
    contextSize: 0,
    needsAttention: false,
    attentionReason: null,
    projectPath: "/tmp/atlas",
    projectName: "atlas",
    ...over,
  } as BoardSession;
}

describe("TimelineSidebar", () => {
  it("draws one day row per bucket and a title-only row per session", () => {
    const yesterdayDate = new Date();
    yesterdayDate.setHours(12, 0, 0, 0);
    yesterdayDate.setDate(yesterdayDate.getDate() - 1);
    const yesterday = yesterdayDate.toISOString();
    render(
      <TimelineSidebar
        sessions={[
          session({ id: "a", title: "First today" }),
          session({ id: "b", title: "Second today" }),
          session({ id: "c", title: "Old", lastActivityAt: yesterday, updatedAt: yesterday }),
        ]}
        loading={false}
        filtered={false}
        openId={null}
        period="day"
        onOpen={() => {}}
      />,
    );
    expect(screen.getByText("Today")).toBeTruthy();
    expect(screen.getByText("Yesterday")).toBeTruthy();
    expect(screen.getByText("First today")).toBeTruthy();
    expect(screen.getByText("Old")).toBeTruthy();
    // Title only: nothing else from the row's old grid leaks in.
    expect(screen.queryByText("atlas")).toBeNull();
    expect(screen.queryByText(/tok/)).toBeNull();
  });

  it("highlights the open session and opens on click", () => {
    const onOpen = vi.fn();
    render(
      <TimelineSidebar
        sessions={[session({ id: "a", title: "Alpha" }), session({ id: "b", title: "Beta" })]}
        loading={false}
        filtered={false}
        openId="b"
        period="day"
        onOpen={onOpen}
      />,
    );
    const beta = screen.getByText("Beta").closest("button")!;
    expect(beta.getAttribute("data-selected")).toBe("true");
    expect(screen.getByText("Alpha").closest("button")!.getAttribute("data-selected")).toBeNull();
    fireEvent.click(screen.getByText("Alpha"));
    expect(onOpen).toHaveBeenCalledWith("a", "/tmp/atlas");
  });

  it("folds three identical imported titles into one row that expands", () => {
    render(
      <TimelineSidebar
        sessions={["x", "y", "z"].map((id) =>
          session({ id, title: "SHARED MEMORY ---", source: "external_jsonl" }),
        )}
        loading={false}
        filtered={false}
        openId={null}
        period="day"
        onOpen={() => {}}
      />,
    );
    const fold = screen.getByText("SHARED MEMORY ---").closest("button")!;
    expect(fold.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByText("×3")).toBeTruthy();
    fireEvent.click(fold);
    expect(fold.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getAllByText("SHARED MEMORY ---")).toHaveLength(4);
  });

  it("puts an expanded cluster's children on their own lane", () => {
    render(
      <TimelineSidebar
        sessions={["x", "y", "z"].map((id) =>
          session({ id, title: "SHARED MEMORY ---", source: "external_jsonl" }),
        )}
        loading={false}
        filtered={false}
        openId={null}
        period="day"
        onOpen={() => {}}
      />,
    );
    fireEvent.click(screen.getByText("SHARED MEMORY ---").closest("button")!);
    // Lane 2 sits one lane right of the folded row on lane 1.
    const [fold, firstChild] = screen.getAllByText("SHARED MEMORY ---").map((el) => {
      const button = el.closest("button")!;
      return Number.parseFloat(button.style.paddingLeft);
    });
    expect(firstChild).toBeGreaterThan(fold);
  });

  it("says why the list is empty", () => {
    render(
      <TimelineSidebar
        sessions={[]}
        loading={false}
        filtered
        openId={null}
        period="day"
        onOpen={() => {}}
      />,
    );
    expect(screen.getByText("No sessions match this filter.")).toBeTruthy();
  });
});
