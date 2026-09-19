// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Hint } from "./tooltip";
import { markTooltipClosed, markTooltipOpen, resetTooltipTiming } from "./tooltip-timing";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  resetTooltipTiming();
});

const content = () => document.querySelector("[data-slot='tooltip-content']");
// Base UI opens on a native `mouseenter` listener (Radix watched `pointermove`),
// so the synthetic event the test fires changed with the library. What is being
// asserted — the shared delay, the warm window, the entrance — did not.
const point = (el: Element) => {
  fireEvent.pointerEnter(el, { pointerType: "mouse" });
  fireEvent.mouseEnter(el);
  act(() => vi.advanceTimersByTime(0));
};

describe("Hint", () => {
  it("names an icon-only control and drops its native title", () => {
    render(
      <Hint label="Refresh">
        <button title="Refresh">r</button>
      </Hint>,
    );
    const button = screen.getByLabelText("Refresh");
    expect(button.tagName).toBe("BUTTON");
    expect(button.getAttribute("title")).toBeNull();
  });

  it("keeps a name the control already has", () => {
    render(
      <Hint label="Stop">
        <button aria-label="Stop the running command">s</button>
      </Hint>,
    );
    expect(screen.getByLabelText("Stop the running command")).toBeTruthy();
  });

  it("does not invent a name from a non-string label", () => {
    render(
      <Hint label={<b>Bold</b>}>
        <button>b</button>
      </Hint>,
    );
    expect(screen.getByRole("button").getAttribute("aria-label")).toBeNull();
  });

  it("puts the trigger on a wrapper when the control can be disabled", () => {
    const { rerender } = render(
      <Hint label="Push">
        <button disabled={false}>p</button>
      </Hint>,
    );
    const wrapper = screen.getByLabelText("Push").parentElement!;
    expect(wrapper.tagName).toBe("SPAN");

    // Toggling `disabled` must not change the DOM shape.
    rerender(
      <Hint label="Push">
        <button disabled>p</button>
      </Hint>,
    );
    expect(screen.getByLabelText("Push").parentElement).toBe(wrapper);
  });

  it("does not wrap a control with no disabled prop", () => {
    render(
      <div data-testid="row">
        <Hint label="Copy">
          <button>c</button>
        </Hint>
      </div>,
    );
    expect(screen.getByLabelText("Copy").parentElement).toBe(screen.getByTestId("row"));
  });

  it("waits for the shared open delay, then scales in", () => {
    vi.useFakeTimers();
    render(
      <Hint label="Refresh">
        <button>r</button>
      </Hint>,
    );
    point(screen.getByLabelText("Refresh"));
    expect(content()).toBeNull();
    act(() => vi.advanceTimersByTime(300));
    expect(content()?.className).toContain("animate-scale-in");
    expect(content()?.className).not.toContain("animate-none");
  });

  it("opens at once, without the entrance, right after another tooltip closed", () => {
    vi.useFakeTimers();
    render(
      <Hint label="Refresh">
        <button>r</button>
      </Hint>,
    );
    // Any tooltip kind closing warms the shared state — e.g. a HintGroup.
    markTooltipOpen();
    markTooltipClosed();
    point(screen.getByLabelText("Refresh"));
    expect(content()?.className).toContain("animate-none");
  });

  it("does not open when the pointer leaves before the delay", () => {
    vi.useFakeTimers();
    render(
      <Hint label="Refresh">
        <button>r</button>
      </Hint>,
    );
    const button = screen.getByLabelText("Refresh");
    point(button);
    fireEvent.pointerLeave(button, { pointerType: "mouse" });
    act(() => vi.advanceTimersByTime(1000));
    expect(content()).toBeNull();
  });

  it("does not open when the trigger is pressed before the delay", () => {
    vi.useFakeTimers();
    render(
      <Hint label="Refresh">
        <button>r</button>
      </Hint>,
    );
    const button = screen.getByLabelText("Refresh");
    point(button);
    fireEvent.pointerDown(button, { pointerType: "mouse" });
    act(() => vi.advanceTimersByTime(1000));
    expect(content()).toBeNull();
  });
});
