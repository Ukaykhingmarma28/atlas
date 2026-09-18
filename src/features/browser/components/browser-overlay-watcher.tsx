import { useEffect } from "react";
import { useBrowserOverlayStore } from "../stores/browser-overlay-store";

/**
 * Centralized "is any DOM overlay open?" detector. A native child webview (the
 * embedded browser) paints above the entire HTML layer, so when a popup opens
 * we must hide the webview — no z-index can put the popup on top.
 *
 * One MutationObserver on document.body, active ONLY while a browser embed is
 * live (gated on embedCount), rAF-coalesced. Catches:
 *   [role="dialog"]        — all Dialogs + Popovers (palettes, modals…)
 *   [role="menu"]          — all dropdown and context menus
 *   [data-open][data-side] — any Base UI Positioner/Popup that is anchored
 *   [data-hint-overlay]    — the hint-nav overlay
 *   [data-browser-suppress]— opt-in marker for custom overlays
 * Deliberately NOT tooltips, so hovering a control doesn't flash the browser.
 * A tooltip is anchored too, so its Positioner matches `[data-open][data-side]`
 * — elements that ARE, CONTAIN or sit INSIDE a tooltip popup are skipped. The
 * inside case is the tooltip's Arrow, which carries both attributes itself. (Filtered in JS:
 * `:has()` is missing from older WKWebViews, and an unsupported selector would
 * make querySelector throw.)
 */
const TOOLTIP_SELECTOR =
  '[role="tooltip"], [data-slot="tooltip-content"], [data-slot="tooltip-arrow"]';

const OVERLAY_SELECTOR =
  '[role="dialog"], [role="menu"], [role="listbox"], [data-hint-overlay], [data-browser-suppress], [data-overlay], [data-modal], [data-open][data-side]';

export function BrowserOverlayWatcher() {
  const embedCount = useBrowserOverlayStore.use.embedCount();
  const { setOverlayOpen } = useBrowserOverlayStore.use.actions();

  useEffect(() => {
    if (embedCount <= 0) return;

    let raf = 0;
    const evaluate = () => {
      raf = 0;
      const overlays = document.querySelectorAll(OVERLAY_SELECTOR);
      setOverlayOpen(
        Array.from(overlays).some(
          (el) => !el.closest(TOOLTIP_SELECTOR) && !el.querySelector(TOOLTIP_SELECTOR),
        ),
      );
    };
    const schedule = () => {
      if (raf) return;
      raf = requestAnimationFrame(evaluate);
    };

    // Initial read (an overlay may already be open when a browser tab opens).
    evaluate();

    const observer = new MutationObserver(schedule);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [
        "role",
        "data-open",
        "style",
        "data-browser-suppress",
        "data-overlay",
        "data-modal",
      ],
    });

    return () => {
      if (raf) cancelAnimationFrame(raf);
      observer.disconnect();
    };
  }, [embedCount, setOverlayOpen]);

  return null;
}
