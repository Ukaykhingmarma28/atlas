// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

const getTheme = vi.fn();
const listThemes = vi.fn();
const applyTheme = vi.fn();

vi.mock("../lib/theme-api", () => ({
  getTheme: (id: string) => getTheme(id),
  listThemes: () => listThemes(),
  onThemesChanged: () => Promise.resolve(() => {}),
}));
vi.mock("../apply-theme", () => ({ applyTheme: (...args: unknown[]) => applyTheme(...args) }));

const { useThemeStore } = await import("./theme-store");

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
