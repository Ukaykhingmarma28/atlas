// @vitest-environment happy-dom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { TitlebarDock } from "./titlebar-dock";

afterEach(cleanup);

function dock() {
  return render(
    <TitlebarDock
      items={[
        { label: "Check for updates", icon: <span>u</span>, onClick: () => {} },
        { label: "Notifications", icon: <span>n</span>, onClick: () => {} },
      ]}
      trailing={{ label: "Account and settings", node: <button>a</button> }}
    />,
  );
}

describe("the dock's sliding label strip", () => {
  /**
   * The regression this guards is a whole-app one, and it has no other symptom
   * a test can see.
   *
   * The strip is one `w-max` row holding every label, mounted all the time and
   * clipped to the active label by `clip-path` — a paint effect that leaves the
   * layout box at its full width. Anchored `absolute` to a pill at the right end
   * of the title bar, that box ran a few hundred px past the window, and because
   * `#root` is `overflow: hidden` the browser counted it as scrollable overflow.
   * One `focus()` or `scrollIntoView()` then slid the entire app shell left —
   * Settings' nav clipped, its first column of theme cards off-screen — with no
   * scrollbar to put it back.
   *
   * `fixed` is the fix: a fixed box is laid out against the viewport and never
   * joins an ancestor's scrollable overflow.
   */
  it("is fixed to the viewport, so it never becomes scrollable overflow", () => {
    const { container } = dock();
    const anchor = container.querySelector(".pointer-events-none") as HTMLElement;

    expect(anchor).not.toBeNull();
    expect(anchor.className).toContain("fixed");
    expect(anchor.className).not.toContain("absolute");
    // `top: 100%` cannot reach the pill from a viewport-anchored box; the
    // measured value takes its place.
    expect(anchor.className).not.toContain("top-full");
    expect(anchor.style.top).toBe("0px");
  });
});
