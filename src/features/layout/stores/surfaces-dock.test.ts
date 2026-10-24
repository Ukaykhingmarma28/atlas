// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { useLayoutStore } from "./layout-store";

/**
 * Where the surfaces pane docks (beside or under the session) is a reader's
 * preference: it persists, and a stored value that is neither falls back to
 * the right.
 */

const layout = () => useLayoutStore.getState();

beforeEach(() => {
  useLayoutStore.setState({ surfacesDock: "right", surfaces: "shown" });
});

describe("surfacesDock", () => {
  it("defaults to the right and moves to the bottom and back", () => {
    expect(layout().surfacesDock).toBe("right");
    layout().actions.setSurfacesDock("bottom");
    expect(layout().surfacesDock).toBe("bottom");
    layout().actions.setSurfacesDock("right");
    expect(layout().surfacesDock).toBe("right");
  });

  it("is persisted, and a stored value it does not know reads as right", () => {
    const options = useLayoutStore.persist.getOptions();
    layout().actions.setSurfacesDock("bottom");
    const saved = options.partialize!(layout()) as { surfacesDock?: string };
    expect(saved.surfacesDock).toBe("bottom");

    const merged = options.merge!({ surfacesDock: "left" }, layout());
    expect(merged.surfacesDock).toBe("right");
    expect(options.merge!({ surfacesDock: "bottom" }, layout()).surfacesDock).toBe("bottom");
  });
});
