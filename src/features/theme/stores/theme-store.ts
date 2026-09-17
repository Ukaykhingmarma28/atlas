import { create } from "zustand";
import { createSelectors } from "@/lib/create-selectors";
import { applyTheme } from "../apply-theme";
import {
  getTheme,
  listThemes,
  onThemesChanged,
  type Theme,
  type ThemeMode,
  type ThemeSummary,
} from "../lib/theme-api";
import type { ThemeOverride } from "../resolve-theme";

interface ThemeState {
  themes: ThemeSummary[];
  loaded: Record<string, Theme>;
  loading: boolean;
  error: string | null;
  actions: {
    load: () => Promise<void>;
    apply: (id: string, mode: ThemeMode, themeOverrides?: ThemeOverride) => Promise<void>;
  };
}

const baseStore = create<ThemeState>()((set, get) => ({
  themes: [],
  loaded: {},
  loading: false,
  error: null,
  actions: {
    load: async () => {
      set({ loading: true, error: null });
      try {
        set({ themes: await listThemes(), loading: false });
      } catch (error) {
        set({ loading: false, error: String(error) });
      }
    },
    apply: async (id, mode, themeOverrides = {}) => {
      let theme = get().loaded[id];
      if (!theme) {
        try {
          theme = await getTheme(id);
        } catch (error) {
          console.warn(`Theme "${id}" is unavailable; falling back to Atlas`, error);
          theme = await getTheme("atlas");
        }
        set((state) => ({ loaded: { ...state.loaded, [theme.id]: theme } }));
      }
      applyTheme(theme, mode, themeOverrides);
    },
  },
}));

export const useThemeStore = createSelectors(baseStore);

let listening = false;

export function startThemeCatalogListener(): void {
  if (listening) return;
  listening = true;
  void onThemesChanged(() => {
    baseStore.setState({ loaded: {} });
    void baseStore.getState().actions.load();
  }).catch((error) => {
    listening = false;
    console.warn("Theme watcher listener failed", error);
  });
}

export function applyConfiguredTheme(
  id: string,
  mode: ThemeMode,
  themeOverrides: ThemeOverride,
): void {
  startThemeCatalogListener();
  void baseStore.getState().actions.apply(id, mode, themeOverrides);
}
