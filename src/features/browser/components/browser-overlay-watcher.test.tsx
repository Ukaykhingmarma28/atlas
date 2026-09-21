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
  it("hides the browser for an anchored popup that is not a tooltip", () => {
    mount('<div data-open data-side="bottom"><div role="listbox"></div></div>');
    render(<BrowserOverlayWatcher />);
    expect(overlayOpen()).toBe(true);
  });

  it("ignores a tooltip", () => {
    mount(
      '<div data-open data-side="bottom"><div data-slot="tooltip-content" data-open data-side="bottom">Refresh<span role="tooltip">Refresh</span></div></div>',
    );
    render(<BrowserOverlayWatcher />);
    expect(overlayOpen()).toBe(false);
  });

  // Base UI's Tooltip.Arrow carries `data-open` and `data-side` itself, so it
  // matches the anchored-popup selector from INSIDE the tooltip popup.
  it("ignores the arrow inside a tooltip", () => {
    mount(
      '<div data-open data-side="top"><div data-slot="tooltip-content" data-open data-side="top">Refresh<span data-open data-side="top"><svg></svg></span></div></div>',
    );
    render(<BrowserOverlayWatcher />);
    expect(overlayOpen()).toBe(false);
  });

  it("still counts a real overlay open alongside a tooltip", () => {
    mount(
      '<div data-open data-side="bottom"><div data-slot="tooltip-content"></div></div><div role="dialog"></div>',
    );
    render(<BrowserOverlayWatcher />);
    expect(overlayOpen()).toBe(true);
  });
});
