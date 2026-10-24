// @vitest-environment happy-dom
//
// The docked card's one promise: opening or closing it moves nothing. The
// transcript row, the column centred in it and the composer stack are laid out
// from the panel's width alone; the card is a layer drawn into room they
// already leave. This mounts the real hook and card the way `chat-panel.tsx`
// wires them and checks every box the column is laid out from, open and closed.

import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}));
// The body is every section's rows; this suite is about the frame around it.
vi.mock("./session-context-popover", () => ({
  SessionContextBody: () => <div data-testid="body" />,
}));

import { resolveContextDock } from "../lib/context-dock";
import { useSessionContextStore } from "../stores/session-context-store";
import { DockedSessionContext, useContextDock } from "./session-context-dock";

const TAB = "tab-1";
let panelWidth = 1000;

/** `chat-panel.tsx`'s wiring: the row's padding, the composer's margin, and
 *  the card, all from one `useContextDock`. */
function Panel({ enabled = true }: { enabled?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const dock = useContextDock(TAB, ref, enabled);
  return (
    <div ref={ref} data-panel>
      <div
        data-chat-row
        style={dock.docked ? { paddingLeft: dock.inset, paddingRight: dock.reserve } : undefined}
      >
        <div data-chat-column />
      </div>
      <div
        data-composer
        style={dock.docked ? { marginLeft: dock.inset, marginRight: dock.reserve } : undefined}
      />
      <DockedSessionContext tabId={TAB} docked={dock.docked} />
    </div>
  );
}

/** Everything the column's position and width are computed from. */
function layout() {
  const box = (sel: string) => {
    const el = document.querySelector<HTMLElement>(sel)!;
    return { style: el.getAttribute("style"), className: el.className };
  };
  return {
    row: box("[data-chat-row]"),
    column: box("[data-chat-column]"),
    composer: box("[data-composer]"),
  };
}

const card = () => document.querySelector("[data-session-context-dock]");

beforeEach(() => {
  panelWidth = 1000;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(
    function (this: HTMLElement) {
      return this.hasAttribute("data-panel") ? panelWidth : 0;
    },
  );
  useSessionContextStore.setState({ openFor: null, dockable: {}, dockOpen: {}, view: "main" });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("the docked session context card", () => {
  it("reserves its room from the width, and toggling it moves nothing", () => {
    render(<Panel />);
    const { reserve } = resolveContextDock(1000, Number.POSITIVE_INFINITY);
    expect(reserve).toBeGreaterThan(0);
    expect(useSessionContextStore.getState().dockable[TAB]).toBe(true);

    const closed = layout();
    expect(closed.row.style).toContain(`padding-right: ${reserve}px`);
    expect(closed.composer.style).toContain(`margin-right: ${reserve}px`);
    expect(card()).toBeNull();

    // The header button, docked: a toggle.
    act(() => useSessionContextStore.getState().actions.toggle(TAB));
    expect(card()).not.toBeNull();
    expect(layout()).toEqual(closed);

    act(() => useSessionContextStore.getState().actions.toggle(TAB));
    expect(card()).toBeNull();
    expect(layout()).toEqual(closed);
  });

  it("does not dock, or reserve, where the panel is too narrow", () => {
    panelWidth = 700;
    render(<Panel />);
    expect(useSessionContextStore.getState().dockable[TAB]).toBeUndefined();
    expect(layout().row.style).toBeNull();
    // The button falls back to the popover; the docked card never shows.
    act(() => useSessionContextStore.getState().actions.toggle(TAB));
    expect(useSessionContextStore.getState().openFor).toBe(TAB);
    expect(card()).toBeNull();
  });

  it("reserves nothing while disabled (the overview rail holds the right side)", () => {
    render(<Panel enabled={false} />);
    expect(useSessionContextStore.getState().dockable[TAB]).toBeUndefined();
    expect(layout().row.style).toBeNull();
  });

  it("clears the tab's dockable flag when the panel unmounts", () => {
    const { unmount } = render(<Panel />);
    expect(useSessionContextStore.getState().dockable[TAB]).toBe(true);
    unmount();
    expect(useSessionContextStore.getState().dockable[TAB]).toBeUndefined();
  });
});
