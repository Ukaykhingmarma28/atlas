/**
 * The Usage tab's series palette, from the active theme.
 *
 * Every colour here is handed to a `style` prop as a VALUE — the glyph chart's
 * stacked segments, the inline bars in the top list and the tables — so none
 * of it can be a `var(--…)` and all of it is resolved (decision 14).
 *
 * The palette is the theme's `chart-1..5`, which is exactly what those five
 * shadcn base tokens are for: a theme author picks five colours that read as a
 * set against their own background, and every chart in Atlas follows. This
 * file used to hold ten hand-picked greys chosen for one AMOLED-black theme;
 * on Rosé Pine Dawn they were invisible.
 *
 * Five tokens, more series than that: `seriesColor` cycles them and dims each
 * further lap toward the background, so an eleventh project is still separable
 * without inventing an eleventh token (decision 18 — role tokens only).
 *
 * Read it through `useSeriesPalette()`. The hook subscribes to
 * `atlas:theme-applied`, so a chart repaints on a theme switch; the
 * module-level constants this replaced could not.
 */
import { useMemo } from "react";
import { mix } from "@/features/theme/color";
import { themeBase, themeColor, useThemeVersion } from "@/features/theme/theme-values";

/** The five series tokens, in the order a theme author sees them. */
const SERIES_TOKENS = ["chart-1", "chart-2", "chart-3", "chart-4", "chart-5"] as const;

/** How far each extra lap of the cycle is pulled toward the background. */
const LAP_FADE = 0.25;
const MAX_LAP_FADE = 0.6;

export interface SeriesPalette {
  /** Stable colour for the nth series, cycling `chart-1..5`. */
  seriesColor: (index: number) => string;
  /** The tint the "Other" bucket draws in — quieter than any named series. */
  otherColor: string;
}

function buildSeriesPalette(): SeriesPalette {
  const background = themeBase("background");
  const series = SERIES_TOKENS.map((token) => themeBase(token));

  return {
    seriesColor: (index) => {
      const color = series[index % series.length];
      const lap = Math.floor(index / series.length);
      return lap === 0 ? color : mix(color, background, Math.min(lap * LAP_FADE, MAX_LAP_FADE));
    },
    // "Other" is the bucket the reader is meant to look past, which is the
    // same instruction `text.disabled` carries everywhere else.
    otherColor: themeColor("text.disabled"),
  };
}

export function useSeriesPalette(): SeriesPalette {
  // `version` is the whole dependency: it changes on `atlas:theme-applied` and
  // on nothing else, which is exactly when the resolved values move.
  const version = useThemeVersion();
  return useMemo(buildSeriesPalette, [version]);
}
