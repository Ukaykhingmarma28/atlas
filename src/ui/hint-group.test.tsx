// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HintGroup, HintItem } from "./hint-group";
import { slideGeometry } from "./slide-geometry";
import { isTooltipWarm, resetTooltipTiming } from "./tooltip-timing";

beforeEach(() => {
  vi.useFakeTimers();
  resetTooltipTiming();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const strip = () =>
  document.querySelector("[data-slot='hint-group-tooltip'] > div") as HTMLElement | null;

function Row({ disabled = false }: { disabled?: boolean }) {
  return (
    <HintGroup>
      <HintItem label="Undo">
        <button title="Undo (native)">u</button>
      </HintItem>
      <HintItem label="Redo">
        <button aria-label="Redo last change" disabled={disabled}>
          r
        </button>
      </HintItem>
    </HintGroup>
  );
}

describe("HintItem", () => {
  it("names the control and drops its native title", () => {
    render(<Row />);
    const undo = screen.getByLabelText("Undo");
    expect(undo.getAttribute("title")).toBeNull();
    // An existing name wins over the tooltip text.
    expect(screen.getByLabelText("Redo last change")).toBeTruthy();
  });

  it("renders the bare control outside a group", () => {
    const { container } = render(
      <HintItem label="Close">
        <button>x</button>
      </HintItem>,
    );
    expect(container.firstElementChild?.tagName).toBe("BUTTON");
    expect(screen.getByLabelText("Close")).toBeTruthy();
  });
});

describe("HintGroup", () => {
  it("mounts nothing until hovered, then opens after the delay", () => {
    render(<Row />);
    expect(strip()).toBeNull();

    fireEvent.mouseEnter(screen.getByLabelText("Undo").parentElement!);
    expect(strip()?.style.opacity).toBe("0");
    act(() => vi.advanceTimersByTime(300));
    expect(strip()?.textContent).toBe("UndoRedo");
  });

  it("does not open when the pointer leaves before the delay", () => {
    render(<Row />);
    const item = screen.getByLabelText("Undo").parentElement!;
    fireEvent.mouseEnter(item);
    fireEvent.mouseLeave(item);
    act(() => vi.advanceTimersByTime(1000));
    expect(strip()).toBeNull();
  });

  it("stays open across the gap between two items", () => {
    render(<Row />);
    const undo = screen.getByLabelText("Undo").parentElement!;
    const redo = screen.getByLabelText("Redo last change").parentElement!;
    fireEvent.mouseEnter(undo);
    act(() => vi.advanceTimersByTime(300));
    fireEvent.mouseLeave(undo);
    act(() => vi.advanceTimersByTime(40));
    fireEvent.mouseEnter(redo);
    act(() => vi.advanceTimersByTime(200));
    expect(strip()).not.toBeNull();
  });

  it("wraps disabled controls so hovering them still reaches the group", () => {
    render(<Row disabled />);
    const wrapper = screen.getByLabelText("Redo last change").parentElement!;
    expect(wrapper.tagName).toBe("SPAN");
    fireEvent.mouseEnter(wrapper);
    act(() => vi.advanceTimersByTime(300));
    expect(strip()).not.toBeNull();
  });
});

describe("HintGroup unmounting items", () => {
  function Toggleable({ show }: { show: boolean }) {
    return (
      <HintGroup>
        <HintItem label="Keep">
          <button>k</button>
        </HintItem>
        {show && (
          <HintItem label="Clear">
            <button>c</button>
          </HintItem>
        )}
      </HintGroup>
    );
  }

  it("drops a pending open when its item unmounts", () => {
    const { rerender } = render(<Toggleable show />);
    fireEvent.mouseEnter(screen.getByLabelText("Clear").parentElement!);
    rerender(<Toggleable show={false} />);
    act(() => vi.advanceTimersByTime(1000));
    // Had the stale timer fired, the shared open count would be stuck at 1.
    expect(isTooltipWarm()).toBe(false);
  });

  it("hides the tooltip when the shown item unmounts", () => {
    const { rerender } = render(<Toggleable show />);
    fireEvent.mouseEnter(screen.getByLabelText("Clear").parentElement!);
    act(() => vi.advanceTimersByTime(300));
    // happy-dom lays nothing out, so the strip stays transparent; the shared
    // open count is what shows the tooltip counts as open.
    expect(isTooltipWarm()).toBe(true);

    rerender(<Toggleable show={false} />);
    act(() => vi.advanceTimersByTime(1000));
    expect(isTooltipWarm()).toBe(false);
  });
});

describe("slideGeometry", () => {
  const base = { widths: [40, 60, 80], stripLeft: 100, viewportWidth: 1000, margin: 8 };

  it("centres the active label on its control and clips the others", () => {
    const g = slideGeometry({ ...base, index: 1, controlCentre: 200 })!;
    // Label 1 starts 40px into the strip; its centre is at 100 + 40 + 30.
    expect(g.tx).toBe(30);
    expect(g.left).toBeCloseTo((40 / 180) * 100);
    expect(g.right).toBeCloseTo((80 / 180) * 100);
  });

  it("keeps the label inside the viewport", () => {
    const g = slideGeometry({ ...base, index: 2, controlCentre: 990 })!;
    // Unclamped the label would end at 990 + 40 = 1030; the limit is 992.
    expect(g.tx).toBe(990 - (100 + 100 + 40) - 38);
  });

  it("returns null before anything is laid out", () => {
    expect(slideGeometry({ ...base, widths: [0, 0], index: 0, controlCentre: 0 })).toBeNull();
  });
});
