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
  useThemeStore.setState({ themes: [], skipped: [], loaded: {}, loading: false, error: null });
});

describe("theme store load()", () => {
  /** A file Rust could not parse is skipped so the rest of the catalog
   *  survives. That used to end at a `tracing::warn!`, where the person who
   *  can fix the file will never see it. */
  it("keeps the files that could not be loaded, for the picker to show", async () => {
    const skipped = [{ key: "half-written.toml", message: "invalid TOML in half-written.toml" }];
    listThemes.mockResolvedValue({ themes: [], warnings: skipped });

    await useThemeStore.getState().actions.load();

    expect(useThemeStore.getState().skipped).toEqual(skipped);
  });
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
    listThemes.mockResolvedValue({ themes: [], warnings: [] });
    await useThemeStore
      .getState()
      .actions.apply("atlas", "dark", { base: { background: "black" } });
    expect(applyTheme).toHaveBeenCalledTimes(1);

    startThemeCatalogListener();
    getTheme.mockResolvedValue(EDITED);
    onChange?.();
    await vi.waitFor(() => expect(applyTheme).toHaveBeenCalledTimes(2));

    // Re-read from Rust rather than served from the cache, and with the same
    // mode and overrides the original apply carried.
    expect(applyTheme).toHaveBeenLastCalledWith(EDITED, "dark", { base: { background: "black" } });
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

/** A cache-miss `apply` awaits a load, and a newer `apply` can land in that
 *  gap. The older one used to paint anyway when its load finished — putting
 *  back the theme the user had just switched away from. */
describe("overlapping applies", () => {
  it("lets the newest request win even when the older load finishes last", async () => {
    vi.resetModules();
    const fresh = await import("./theme-store");
    let finishSlow!: (theme: typeof ATLAS) => void;
    const SLOW = { ...ATLAS, id: "slow" };
    const FAST = { ...ATLAS, id: "fast" };
    getTheme.mockImplementation((id: string) =>
      id === "slow"
        ? new Promise((resolve) => {
            finishSlow = resolve;
          })
        : Promise.resolve(FAST),
    );

    const older = fresh.useThemeStore.getState().actions.apply("slow", "dark");
    await fresh.useThemeStore.getState().actions.apply("fast", "dark");
    finishSlow(SLOW);
    await older;

    expect(applyTheme).toHaveBeenCalledTimes(1);
    expect(applyTheme).toHaveBeenLastCalledWith(FAST, "dark", {});
  });
});

/** `system` used to read the OS once per apply, so Atlas stayed on whatever
 *  the OS said at launch until something else happened to re-apply. */
describe("system mode", () => {
  function fakeOs() {
    const listeners = new Set<() => void>();
    vi.stubGlobal("matchMedia", () => ({
      matches: false,
      addEventListener: (_: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
    }));
    return { listeners, flip: () => listeners.forEach((listener) => listener()) };
  }

  it("re-applies when the OS appearance changes, and stops once the mode is not system", async () => {
    vi.resetModules();
    const fresh = await import("./theme-store");
    const os = fakeOs();
    getTheme.mockResolvedValue(ATLAS);

    await fresh.useThemeStore.getState().actions.apply("atlas", "system");
    expect(applyTheme).toHaveBeenCalledTimes(1);
    expect(os.listeners.size).toBe(1);

    os.flip();
    await vi.waitFor(() => expect(applyTheme).toHaveBeenCalledTimes(2));
    expect(applyTheme).toHaveBeenLastCalledWith(ATLAS, "system", {});
    // Served from the cache: only the variant changed, not the file.
    expect(getTheme).toHaveBeenCalledTimes(1);

    await fresh.useThemeStore.getState().actions.apply("atlas", "dark");
    expect(os.listeners.size).toBe(0);
    vi.unstubAllGlobals();
  });
});
