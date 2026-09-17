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

/** The id every install ships with, and the last thing `apply` tries. */
const FALLBACK_THEME = "atlas";

/** `getTheme`, reduced to "the theme, or nothing". Never throws. */
async function loadTheme(id: string): Promise<Theme | null> {
  try {
    return await getTheme(id);
  } catch (error) {
    console.warn(`Theme "${id}" could not be loaded`, error);
    return null;
  }
}

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
        // Both loads are guarded. The fallback used to sit bare inside the
        // catch, so whatever made the chosen theme unavailable — an offline
        // backend, a catalog that would not build — threw a SECOND time out of
        // the handler that existed to survive the first, rejecting the promise
        // no caller awaits and leaving the app on the compiled-in `tokens.css`
        // defaults with nothing said. Failing to theme is not a reason to fail.
        const loaded =
          (await loadTheme(id)) ?? (id === FALLBACK_THEME ? null : await loadTheme(FALLBACK_THEME));
        if (!loaded) {
          set({ error: `No theme could be loaded (tried "${id}" and "${FALLBACK_THEME}")` });
          return;
        }
        theme = loaded;
        set((state) => ({ loaded: { ...state.loaded, [loaded.id]: loaded } }));
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
