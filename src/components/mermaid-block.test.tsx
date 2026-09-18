// @vitest-environment happy-dom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/** Each `render` call takes the next queued SVG; a test decides when it lands. */
const queue: Array<{ promise: Promise<{ svg: string }>; resolve: (svg: string) => void }> = [];
function nextRender() {
  let resolve!: (svg: string) => void;
  const promise = new Promise<{ svg: string }>((done) => {
    resolve = (svg) => done({ svg });
  });
  queue.push({ promise, resolve });
  return queue[queue.length - 1];
}

vi.mock("mermaid", () => ({
  default: {
    initialize: () => {},
    parse: async () => true,
    render: () => queue.shift()!.promise,
  },
}));

const { MermaidBlock } = await import("./mermaid-block");

afterEach(() => {
  cleanup();
  queue.length = 0;
});

const themeApplied = () => window.dispatchEvent(new CustomEvent("atlas:theme-applied"));

describe("MermaidBlock across a theme switch", () => {
  /**
   * The regression: the render effect cleared the SVG on every theme version,
   * so each apply collapsed the diagram to "Rendering diagram…" — and, with
   * `controls`, unmounted the viewer and closed a full-screen diagram under
   * the user.
   */
  it("keeps the old diagram on screen while the new one renders", async () => {
    const first = nextRender();
    render(<MermaidBlock code="graph TD; A-->B" controls />);
    await act(async () => first.resolve('<svg data-testid="diagram-1"></svg>'));
    expect(await screen.findAllByTestId("diagram-1")).not.toHaveLength(0);

    const second = nextRender();
    await act(async () => themeApplied());
    expect(screen.queryByText("Rendering diagram…")).toBeNull();
    expect(screen.getAllByTestId("diagram-1")).not.toHaveLength(0);

    await act(async () => second.resolve('<svg data-testid="diagram-2"></svg>'));
    expect(await screen.findAllByTestId("diagram-2")).not.toHaveLength(0);
  });

  it("does clear when the source itself changes", async () => {
    const first = nextRender();
    const { rerender } = render(<MermaidBlock code="graph TD; A-->B" />);
    await act(async () => first.resolve('<svg data-testid="diagram-1"></svg>'));
    await screen.findByTestId("diagram-1");

    nextRender();
    await act(async () => rerender(<MermaidBlock code="graph TD; A-->C" />));
    expect(screen.queryByTestId("diagram-1")).toBeNull();
    expect(screen.getByText("Rendering diagram…")).toBeTruthy();
  });

  it("drops a superseded run's result", async () => {
    const first = nextRender();
    render(<MermaidBlock code="graph TD; A-->B" />);
    await act(async () => first.resolve('<svg data-testid="diagram-1"></svg>'));
    await screen.findByTestId("diagram-1");

    const stale = nextRender();
    await act(async () => themeApplied());
    const fresh = nextRender();
    await act(async () => themeApplied());
    await act(async () => fresh.resolve('<svg data-testid="fresh"></svg>'));
    await act(async () => stale.resolve('<svg data-testid="stale"></svg>'));

    expect(screen.getByTestId("fresh")).toBeTruthy();
    expect(screen.queryByTestId("stale")).toBeNull();
  });
});
