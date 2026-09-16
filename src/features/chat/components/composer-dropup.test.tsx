// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ComposerDropup, useComposerDropup } from "./composer-dropup";

function Pill({ id, disabled }: { id: string; disabled?: boolean }) {
  const { open, toggle, ref, contentRef, panelHeight } = useComposerDropup(id, { disabled });
  return (
    <div ref={ref} className="relative">
      <ComposerDropup open={open} panelHeight={panelHeight} contentRef={contentRef}>
        <div data-testid={`${id}-panel`}>{open ? "open" : "closed"}</div>
      </ComposerDropup>
      <button onClick={toggle}>{id}</button>
    </div>
  );
}

describe("useComposerDropup", () => {
  afterEach(cleanup);

  it("toggles, and Escape / a click outside close it", () => {
    render(
      <>
        <Pill id="a" />
        <div data-testid="outside" />
      </>,
    );
    fireEvent.click(screen.getByText("a"));
    expect(screen.getByTestId("a-panel").textContent).toBe("open");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByTestId("a-panel").textContent).toBe("closed");

    fireEvent.click(screen.getByText("a"));
    fireEvent.mouseDown(screen.getByTestId("outside"));
    expect(screen.getByTestId("a-panel").textContent).toBe("closed");
  });

  it("opening one pill closes its siblings, and a click inside does not", () => {
    render(
      <>
        <Pill id="a" />
        <Pill id="b" />
      </>,
    );
    fireEvent.click(screen.getByText("a"));
    fireEvent.click(screen.getByText("b"));
    expect(screen.getByTestId("a-panel").textContent).toBe("closed");
    expect(screen.getByTestId("b-panel").textContent).toBe("open");
    fireEvent.mouseDown(screen.getByTestId("b-panel"));
    expect(screen.getByTestId("b-panel").textContent).toBe("open");
  });

  it("a disabled pill neither opens nor stays open", () => {
    const { rerender } = render(<Pill id="a" />);
    fireEvent.click(screen.getByText("a"));
    expect(screen.getByTestId("a-panel").textContent).toBe("open");
    act(() => rerender(<Pill id="a" disabled />));
    expect(screen.getByTestId("a-panel").textContent).toBe("closed");
    fireEvent.click(screen.getByText("a"));
    expect(screen.getByTestId("a-panel").textContent).toBe("closed");
  });
});
