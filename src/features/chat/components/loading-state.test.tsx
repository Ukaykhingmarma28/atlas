// @vitest-environment happy-dom
//
// The working indicator is only ever on screen BEFORE the model has produced
// anything: a streaming assistant turn exists as soon as it emits a row, and
// the indicator is gone by then. So what it says during that window is a claim
// about a request in flight, not about a model thinking (issue 291).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { LoadingState, SHOW_ELAPSED_AFTER_MS, WAITING_LABEL } from "./loading-state";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

/** The elapsed clock is written straight to the DOM, bypassing React. */
function elapsedText(container: HTMLElement): string {
  return container.querySelector(".tabular-nums")?.textContent ?? "";
}

describe("LoadingState", () => {
  it("says it is waiting, not thinking", () => {
    render(<LoadingState />);
    expect(screen.getByRole("status").getAttribute("aria-label")).toBe(WAITING_LABEL);
    expect(screen.getByText(WAITING_LABEL)).toBeTruthy();
    expect(screen.queryByText("Thinking")).toBeNull();
  });

  it("still lets a caller name a different wait", () => {
    render(<LoadingState label="Starting Claude Code" />);
    expect(screen.getByText("Starting Claude Code")).toBeTruthy();
  });

  it("shows no clock while the wait is too short to be worth counting", () => {
    const { container } = render(<LoadingState />);
    expect(elapsedText(container)).toBe("");

    vi.advanceTimersByTime(SHOW_ELAPSED_AFTER_MS - 500);
    expect(elapsedText(container)).toBe("");
  });

  it("starts counting once the wait is long enough to ask about", () => {
    const { container } = render(<LoadingState />);
    vi.advanceTimersByTime(SHOW_ELAPSED_AFTER_MS + 500);
    expect(elapsedText(container)).toMatch(/^\d+\.\ds$/);
  });
});
