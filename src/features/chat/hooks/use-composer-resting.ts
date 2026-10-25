// The composer's resting form: when the reader scrolls back through a
// session, an empty composer folds to a single-line pill with its toolbar
// tucked underneath, so the transcript gets the room. It opens again the
// moment the reader comes back to it — a focus, a click in it, an edit.
//
// What folds it is a scroll GESTURE over the transcript, not a scroll
// position: a few wheel ticks in a direction the transcript can actually
// move, accumulated within one gesture. A wheel toward the end while already
// at the end moves nothing and folds nothing. The caller decides whether the
// composer may rest at all (empty, nothing staged, no picker open); while it
// may not, it stays open.

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

/** Wheel travel within one gesture before the composer folds. */
const COLLAPSE_THRESHOLD_PX = 24;
/** A pause this long between wheel events ends the gesture. */
const GESTURE_RESET_MS = 120;

/** The transcript's scroller, found from the composer: both live under the
 *  chat panel's drop zone. */
function transcriptScroller(composer: HTMLElement | null): HTMLElement | null {
  return (
    composer
      ?.closest<HTMLElement>("[data-chat-drop-zone]")
      ?.querySelector<HTMLElement>("[data-chat-transcript-scroll]") ?? null
  );
}

export function useComposerResting(
  composerRef: RefObject<HTMLElement | null>,
  eligible: boolean,
): {
  resting: boolean;
  expand: () => void;
  onPointerDownCapture: (event: React.PointerEvent) => void;
  onFocusCapture: () => void;
} {
  const [collapsed, setCollapsed] = useState(false);
  const eligibleRef = useRef(eligible);
  eligibleRef.current = eligible;

  // Not allowed to rest: open, and stay open until the next gesture.
  useEffect(() => {
    if (!eligible) setCollapsed(false);
  }, [eligible]);

  useEffect(() => {
    let accumulated = 0;
    let suppressed = false;
    let lastAt = Number.NEGATIVE_INFINITY;
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || !(event.target instanceof Node)) return;
      const scroller = transcriptScroller(composerRef.current);
      if (!scroller || !scroller.contains(event.target)) return;
      const now = performance.now();
      if (now - lastAt > GESTURE_RESET_MS) {
        accumulated = 0;
        suppressed = false;
      }
      lastAt = now;
      const atEnd = scroller.scrollTop >= scroller.scrollHeight - scroller.clientHeight - 1;
      const canMove = event.deltaY < 0 ? scroller.scrollTop > 0 : !atEnd;
      if (suppressed || !eligibleRef.current || !canMove) {
        accumulated = 0;
        return;
      }
      const unit =
        event.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? 16
          : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? scroller.clientHeight
            : 1;
      accumulated += Math.abs(event.deltaY) * unit;
      if (accumulated < COLLAPSE_THRESHOLD_PX) return;
      accumulated = 0;
      // One fold per gesture: the rest of this flick only scrolls.
      suppressed = true;
      setCollapsed(true);
    };
    document.addEventListener("wheel", onWheel, { capture: true, passive: true });
    return () => document.removeEventListener("wheel", onWheel, true);
  }, [composerRef]);

  // Returning to the window re-focuses the element that last held focus. That
  // focus is not the reader coming back to the composer, so for the frame
  // after a window focus the composer's own focus handler ignores it.
  const windowRefocus = useRef(false);
  useEffect(() => {
    if (!collapsed) return;
    let frame = 0;
    const onWindowFocus = () => {
      windowRefocus.current = true;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        windowRefocus.current = false;
      });
    };
    window.addEventListener("focus", onWindowFocus);
    return () => {
      window.removeEventListener("focus", onWindowFocus);
      cancelAnimationFrame(frame);
      windowRefocus.current = false;
    };
  }, [collapsed]);

  const expand = useCallback(() => setCollapsed(false), []);
  const onFocusCapture = useCallback(() => {
    if (!windowRefocus.current) setCollapsed(false);
  }, []);
  const onPointerDownCapture = useCallback((event: React.PointerEvent) => {
    // The tray's own controls (pickers, +) work in place; a press anywhere
    // else in the composer opens it.
    const target = event.target;
    if (target instanceof Element && target.closest("button, a, input, [role='button']")) return;
    setCollapsed(false);
  }, []);

  return { resting: collapsed && eligible, expand, onPointerDownCapture, onFocusCapture };
}
