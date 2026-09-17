// @vitest-environment happy-dom
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { useBrowserOverlayStore } from "../stores/browser-overlay-store";
import { BrowserOverlayWatcher } from "./browser-overlay-watcher";

const overlayOpen = () => useBrowserOverlayStore.getState().overlayOpen;

function mount(html: string) {
  const host = document.createElement("div");
  host.innerHTML = html;
  document.body.appendChild(host);
  return host;
}

beforeEach(() => {
  useBrowserOverlayStore.getState().actions.registerEmbed();
});
afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  useBrowserOverlayStore.getState().actions.unregisterEmbed();
});

describe("BrowserOverlayWatcher", () => {
  it("hides the browser for a Radix popper that is not a tooltip", () => {
    mount('<div data-radix-popper-content-wrapper><div role="listbox"></div></div>');
    render(<BrowserOverlayWatcher />);
    expect(overlayOpen()).toBe(true);
  });

  it("ignores a Radix tooltip", () => {
    mount(
      '<div data-radix-popper-content-wrapper><div data-slot="tooltip-content" data-state="delayed-open" data-side="bottom">Refresh<span role="tooltip">Refresh</span></div></div>',
    );
    render(<BrowserOverlayWatcher />);
    expect(overlayOpen()).toBe(false);
  });

  it("still counts a real overlay open alongside a tooltip", () => {
    mount(
      '<div data-radix-popper-content-wrapper><div data-slot="tooltip-content"></div></div><div role="dialog"></div>',
    );
    render(<BrowserOverlayWatcher />);
    expect(overlayOpen()).toBe(true);
  });
});
