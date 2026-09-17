// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

const getTheme = vi.fn();
const listThemes = vi.fn();
const applyTheme = vi.fn();

/** The `atlas:themes-changed` handler the store registers, once it has. */
let onChange: (() => void) | undefined;

vi.mock("../lib/theme-api", () => ({
  getTheme: (id: string) => getTheme(id),
  listThemes: () => listThemes(),
  onThemesChanged: (callback: () => void) => {
    onChange = callback;
    return Promise.resolve(() => {});
  },
}));
vi.mock("../apply-theme", () => ({ applyTheme: (...args: unknown[]) => applyTheme(...args) }));

const { useThemeStore, startThemeCatalogListener } = await import("./theme-store");

const ATLAS = { schema: 1, id: "atlas", name: "Atlas", author: "a", license: "MIT" };

beforeEach(() => {
  vi.clearAllMocks();
  useThemeStore.setState({ themes: [], loaded: {}, loading: false, error: null });
});

describe("theme store apply()", () => {
  it("falls back to Atlas when the chosen theme cannot be loaded", async () => {
    getTheme.mockImplementation((id: string) =>
      id === "atlas" ? Promise.resolve(ATLAS) : Promise.reject(new Error("gone")),
    );

    await useThemeStore.getState().actions.apply("half-written", "dark");

    expect(applyTheme).toHaveBeenCalledWith(ATLAS, "dark", {});
    expect(useThemeStore.getState().loaded.atlas).toEqual(ATLAS);
  });

  /** The regression: the fallback used to throw out of its own catch. */
  it("reports an error instead of rejecting when even the fallback fails", async () => {
    getTheme.mockRejectedValue(new Error("backend is down"));

    await expect(
      useThemeStore.getState().actions.apply("rose-pine", "dark"),
    ).resolves.toBeUndefined();

    expect(applyTheme).not.toHaveBeenCalled();
    expect(useThemeStore.getState().error).toContain("rose-pine");
  });

  it("does not ask for the fallback twice when the fallback is what failed", async () => {
    getTheme.mockRejectedValue(new Error("backend is down"));

    await useThemeStore.getState().actions.apply("atlas", "dark");

    expect(getTheme).toHaveBeenCalledTimes(1);
  });
});

/** Both of these are "the theme file on disk changed, but nothing the app
 *  keys off changed with it". The catalog listener refreshed the picker and
 *  stopped there, and re-picking the theme you are already on writes an
 *  identical settings value that `applySettingsSideEffects` correctly skips —
 *  so the app kept painting the version it had read at boot. */
describe("re-applying the active theme", () => {
  const EDITED = { ...ATLAS, name: "Atlas (edited)" };

  it("repaints when the theme catalog changes underneath it", async () => {
    getTheme.mockResolvedValue(ATLAS);
    listThemes.mockResolvedValue([]);
    await useThemeStore.getState().actions.apply("atlas", "dark", { base: { background: "#000" } });
    expect(applyTheme).toHaveBeenCalledTimes(1);

    startThemeCatalogListener();
    getTheme.mockResolvedValue(EDITED);
    onChange?.();
    await vi.waitFor(() => expect(applyTheme).toHaveBeenCalledTimes(2));

    // Re-read from Rust rather than served from the cache, and with the same
    // mode and overrides the original apply carried.
    expect(applyTheme).toHaveBeenLastCalledWith(EDITED, "dark", { base: { background: "#000" } });
  });

  it("re-reads the file when the active theme is picked again", async () => {
    getTheme.mockResolvedValue(ATLAS);
    await useThemeStore.getState().actions.apply("atlas", "dark");
    getTheme.mockResolvedValue(EDITED);

    await useThemeStore.getState().actions.reapply();

    expect(getTheme).toHaveBeenCalledTimes(2);
    expect(applyTheme).toHaveBeenLastCalledWith(EDITED, "dark", {});
  });

  it("does nothing before anything has been applied", async () => {
    vi.resetModules();
    const fresh = await import("./theme-store");

    await fresh.useThemeStore.getState().actions.reapply();

    expect(getTheme).not.toHaveBeenCalled();
    expect(applyTheme).not.toHaveBeenCalled();
  });
});
