// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { LIGHT_APPEARANCE_ENABLED, appearanceForMode } from "./apply-theme";

/** Pretend the OS is asking for a light appearance. */
function osPrefersLight(light: boolean): void {
  vi.stubGlobal(
    "matchMedia",
    (query: string) =>
      ({
        matches: light && query.includes("light"),
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * The light appearance is finished in the theme files and unfinished in the
 * app around them, so it ships behind one flag. Hiding the Light button was
 * only half of that: `system` asks the OS, and a light Mac answers "light" —
 * so a user who never chose light was booted into the unfinished UI, with no
 * visible control to leave it. Whichever way `LIGHT_APPEARANCE_ENABLED` is
 * set, the button and the resolved appearance must agree; one of the two
 * cases below is live at any time, and both must keep passing across the
 * flip that turns light on.
 */
describe("appearanceForMode", () => {
  it("always honours an explicit dark", () => {
    osPrefersLight(true);
    expect(appearanceForMode("dark")).toBe("dark");
  });

  it.skipIf(LIGHT_APPEARANCE_ENABLED)("resolves everything to dark while light is off", () => {
    osPrefersLight(true);

    expect(appearanceForMode("system")).toBe("dark");
    expect(appearanceForMode("light")).toBe("dark");
  });

  it.skipIf(!LIGHT_APPEARANCE_ENABLED)(
    "follows the OS and the explicit choice once light is on",
    () => {
      osPrefersLight(true);
      expect(appearanceForMode("system")).toBe("light");
      expect(appearanceForMode("light")).toBe("light");

      osPrefersLight(false);
      expect(appearanceForMode("system")).toBe("dark");
    },
  );
});
