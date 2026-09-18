// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { appearanceForMode } from "./apply-theme";

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
 * The light appearance shipped behind `LIGHT_APPEARANCE_ENABLED` while the
 * app-wide light pass was unfinished, and hiding the Light button was only
 * half of it: `system` asks the OS, and a light Mac answers "light", so a user
 * who never chose light was booted into the unfinished UI with no visible
 * control to leave it. The pass is done and the flag is gone; what these pin
 * is that `system` and the explicit modes agree with the picker again.
 */
describe("appearanceForMode", () => {
  it("always honours an explicit dark", () => {
    osPrefersLight(true);
    expect(appearanceForMode("dark")).toBe("dark");
  });

  it("always honours an explicit light", () => {
    osPrefersLight(false);
    expect(appearanceForMode("light")).toBe("light");
  });

  it("follows the OS under `system`", () => {
    osPrefersLight(true);
    expect(appearanceForMode("system")).toBe("light");

    osPrefersLight(false);
    expect(appearanceForMode("system")).toBe("dark");
  });

  it("falls back to dark where there is no `matchMedia` to ask", () => {
    // A non-DOM context — a test, or a module evaluated before the webview.
    vi.stubGlobal("matchMedia", undefined);
    expect(appearanceForMode("system")).toBe("dark");
  });
});
