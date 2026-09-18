import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedIcon } from "../lib/icon-theme-api";

const resolveIcons = vi.fn();
const getIconThemeAssets = vi.fn();
const getIconThemeFonts = vi.fn();

vi.mock("../lib/icon-theme-api", () => ({
  MINIMAL_ICON_THEME_ID: "minimal",
  resolveIcons: (...args: unknown[]) => resolveIcons(...args),
  getIconThemeAssets: (...args: unknown[]) => getIconThemeAssets(...args),
  getIconThemeFonts: (...args: unknown[]) => getIconThemeFonts(...args),
  listIconThemes: async () => [],
  onIconThemesChanged: () => Promise.resolve(() => {}),
}));
vi.mock("../lib/icon-preview", () => ({ clearIconThemePreviews: () => {} }));

const { useIconThemeStore } = await import("./icon-theme-store");

const REQUEST = { path: "src/main.ts", kind: "file" as const };
const ANSWER: ResolvedIcon = { kind: "glyph", definition: "ts", character: "x" };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("icon theme store, a stale answer", () => {
  /**
   * An appearance switch keeps the theme id and empties every cache. The
   * discard check compared the id alone, so an answer resolved for the OLD
   * appearance landed in the new appearance's cache and stayed there.
   */
  it("is dropped when the appearance changed under it, though the id did not", async () => {
    let answer!: (icons: (ResolvedIcon | null)[]) => void;
    resolveIcons.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    const { actions } = useIconThemeStore.getState();
    actions.setTheme("seti", "dark");
    actions.want(REQUEST);
    await vi.waitFor(() => expect(resolveIcons).toHaveBeenCalledTimes(1));
    expect(resolveIcons.mock.calls[0][1]).toBe("dark");

    actions.setTheme("seti", "light");
    answer([ANSWER]);
    await Promise.resolve();
    await Promise.resolve();

    expect(useIconThemeStore.getState().resolved).toEqual({});
    expect(getIconThemeFonts).not.toHaveBeenCalled();
  });

  it("is kept when nothing changed", async () => {
    resolveIcons.mockResolvedValue([ANSWER]);
    getIconThemeFonts.mockResolvedValue([]);
    const { actions } = useIconThemeStore.getState();
    actions.setTheme("seti", "highContrast");
    actions.want(REQUEST);

    await vi.waitFor(() =>
      expect(Object.values(useIconThemeStore.getState().resolved)).toEqual([ANSWER]),
    );
  });
});
