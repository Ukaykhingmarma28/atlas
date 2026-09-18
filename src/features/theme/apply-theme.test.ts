// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import builtinThemes from "@/dev/mock-backend/fixtures/builtin-themes.json";
import { applyTheme, appearanceForMode } from "./apply-theme";
import type { Theme } from "./lib/theme-api";

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

/**
 * `index.html` sets seven `--atlas-boot-*` INLINE properties on `<html>` from
 * the cached launch colours, and binds the root `background` and `color-scheme`
 * to them. An inline property beats the `:root{…}` block `applyTheme` writes
 * into `<head>`, so an `applyTheme` that did not refresh them left the page on
 * the PREVIOUS theme's `color-scheme` and root background for the whole
 * session — native scrollbars, form controls and the caret following an
 * appearance the user had already switched away from.
 */
describe("applyTheme and the boot variables", () => {
  const themes = builtinThemes as Theme[];
  const rosePine = themes.find((t) => t.id === "rose-pine")!;
  const boot = () => document.documentElement.style;

  it("refreshes them on every apply, appearance included", () => {
    const dark = applyTheme(rosePine, "dark");
    expect(boot().getPropertyValue("--atlas-boot-scheme")).toBe("dark");
    expect(boot().getPropertyValue("--atlas-boot-bg")).toBe(dark.base.background);
    expect(boot().getPropertyValue("--atlas-boot-card")).toBe(dark.base.card);

    const light = applyTheme(rosePine, "light");
    expect(light.appearance).toBe("light");
    expect(boot().getPropertyValue("--atlas-boot-scheme")).toBe("light");
    expect(boot().getPropertyValue("--atlas-boot-bg")).toBe(light.base.background);
    // The point of the bug: the dark value must be GONE, not merely shadowed.
    expect(boot().getPropertyValue("--atlas-boot-bg")).not.toBe(dark.base.background);
  });

  it("writes the same seven values it caches for the next cold start", () => {
    const resolved = applyTheme(rosePine, "light");
    const cached = JSON.parse(localStorage.getItem("atlas:launch-theme")!);

    expect(cached.appearance).toBe(resolved.appearance);
    expect(boot().getPropertyValue("--atlas-boot-scheme")).toBe(cached.appearance);
    expect(boot().getPropertyValue("--atlas-boot-bg")).toBe(cached.background);
    expect(boot().getPropertyValue("--atlas-boot-chrome")).toBe(cached.chrome);
    expect(boot().getPropertyValue("--atlas-boot-card")).toBe(cached.card);
    expect(boot().getPropertyValue("--atlas-boot-line")).toBe(cached.line);
    expect(boot().getPropertyValue("--atlas-boot-skeleton")).toBe(cached.skeleton);
    expect(boot().getPropertyValue("--atlas-boot-text")).toBe(cached.text);
  });
});
