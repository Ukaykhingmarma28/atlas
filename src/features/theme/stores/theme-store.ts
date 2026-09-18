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
  type ThemeWarning,
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
  /** User theme files that could not be loaded at all, so the picker can say
   *  which file and why. Empty on a healthy install. */
  skipped: ThemeWarning[];
  loaded: Record<string, Theme>;
  loading: boolean;
  error: string | null;
  actions: {
    load: () => Promise<void>;
    /**
     * Fetch the full document for every catalog entry not already in `loaded`.
     *
     * `load` lists the catalog and `apply` reads one theme; a picker that
     * PREVIEWS every theme needs all of them, and needs them as objects rather
     * than summaries because only a full variant can be resolved. One batch of
     * `get_theme` calls on opening the panel, then nothing: `loaded` is the
     * cache, and the watcher already empties it when a file changes.
     */
    loadAll: () => Promise<void>;
    apply: (id: string, mode: ThemeMode, themeOverrides?: ThemeOverride) => Promise<void>;
    /** Re-run the last `apply` against freshly read theme data. */
    reapply: () => Promise<void>;
  };
}

/** Ids `loadAll` currently has in flight, so two callers make one request. */
const inFlight = new Set<string>();

/**
 * Bumped every time `loaded` is deliberately emptied.
 *
 * A `loadAll` batch and the file watcher race: the watcher drops the cache to
 * force a re-read, and a batch that started before it would merge the very
 * documents that were just thrown away — and then be skipped on the retry,
 * because its ids were still marked in flight. A batch that finishes into a
 * different generation drops its results instead.
 */
let cacheGeneration = 0;

function invalidateLoaded(): void {
  cacheGeneration += 1;
  inFlight.clear();
}

/** What `apply` was last asked for.
 *
 * Kept outside the store because it is not UI state — nothing renders it, and
 * a re-render on every theme change would be noise. It exists so that a
 * *source* change with no settings change can still repaint: editing the
 * active theme's TOML, or clicking the theme you are already on. */
let lastRequest: { id: string; mode: ThemeMode; themeOverrides: ThemeOverride } | null = null;

const baseStore = create<ThemeState>()((set, get) => ({
  themes: [],
  skipped: [],
  loaded: {},
  loading: false,
  error: null,
  actions: {
    load: async () => {
      set({ loading: true, error: null });
      try {
        const catalog = await listThemes();
        set({ themes: catalog.themes, skipped: catalog.warnings, loading: false });
      } catch (error) {
        set({ loading: false, error: String(error) });
      }
    },
    loadAll: async () => {
      const { themes, loaded } = get();
      const wanted = themes
        .map((theme) => theme.id)
        .filter((id) => !(id in loaded) && !inFlight.has(id));
      if (wanted.length === 0) return;
      const at = cacheGeneration;
      for (const id of wanted) inFlight.add(id);
      try {
        const documents = await Promise.all(wanted.map(loadTheme));
        if (at !== cacheGeneration) return;
        const fetched: Record<string, Theme> = {};
        for (const theme of documents) if (theme) fetched[theme.id] = theme;
        if (Object.keys(fetched).length === 0) return;
        set((state) => ({ loaded: { ...state.loaded, ...fetched } }));
      } finally {
        if (at === cacheGeneration) for (const id of wanted) inFlight.delete(id);
      }
    },
    apply: async (id, mode, themeOverrides = {}) => {
      lastRequest = { id, mode, themeOverrides };
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
    reapply: async () => {
      if (!lastRequest) return;
      const { id, mode, themeOverrides } = lastRequest;
      // Drop the cached copy first: the whole point is to read the file again.
      invalidateLoaded();
      set((state) => {
        const { [id]: _stale, ...rest } = state.loaded;
        return { loaded: rest };
      });
      await get().actions.apply(id, mode, themeOverrides);
    },
  },
}));

export const useThemeStore = createSelectors(baseStore);

let listening = false;

/** Keep the picker and the painted app in step with the theme files on disk.
 *
 * Rust watches `~/.config/atlas/themes` and fires `atlas:themes-changed` on
 * every write. Refreshing the catalog is only half of it: the catalog feeds
 * the picker, and nothing else re-reads the theme the app is *wearing*. So
 * saving a change to the active theme used to update the picker card's name
 * and leave every colour on screen exactly as it was — the hot reload the
 * watcher exists for did nothing visible. `reapply` closes that loop. */
export function startThemeCatalogListener(): void {
  if (listening) return;
  listening = true;
  void onThemesChanged(() => {
    invalidateLoaded();
    baseStore.setState({ loaded: {} });
    void baseStore.getState().actions.load();
    void baseStore.getState().actions.reapply();
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
