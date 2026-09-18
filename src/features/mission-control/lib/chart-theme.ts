/**
 * Recharts theming, from the active theme.
 *
 * Recharts takes colour PROPS, not CSS classes — `stroke`, `fill`, and a `tick`
 * object that becomes SVG attributes — so nothing here can be a `var(--…)` and
 * every value is resolved (decision 14).
 *
 * The series palette is the theme's `chart-1..5`, which is exactly what those
 * five shadcn base tokens are for: a theme author picks five colours that read
 * as a set against their background, and every chart in Atlas follows. The file
 * used to hold sixteen hand-picked greys chosen for one AMOLED-black theme;
 * on Rosé Pine Dawn they were invisible.
 *
 * Five tokens, more series than that: `projectColor` cycles them and dims each
 * further lap toward the background, so an eleventh project is still separable
 * without inventing an eleventh token (decision 18 — role tokens only).
 *
 * Read it through `useChartPalette()`. The hook subscribes to
 * `atlas:theme-applied`, so a chart repaints on a theme switch; a module-level
 * constant, which is what this was, could not.
 */
import { useMemo } from "react";
import { mix } from "@/features/theme/color";
import { themeBase, themeColor, useThemeVersion } from "@/features/theme/theme-values";

/** The five series tokens, in the order a theme author sees them. */
const SERIES_TOKENS = ["chart-1", "chart-2", "chart-3", "chart-4", "chart-5"] as const;

/** How far each extra lap of the cycle is pulled toward the background. */
const LAP_FADE = 0.25;
const MAX_LAP_FADE = 0.6;

export interface ChartAxes {
  /** Gridlines and axis lines. */
  grid: string;
  /** Tick labels. */
  axis: string;
  tickFont: number;
  /** The band recharts paints under the hovered category. */
  cursor: string;
}

/**
 * One colour per named series. There are six names and five tokens, so `output`
 * shares `chart-2` with `gpt`; the two never appear in the same chart.
 */
export interface SeriesColors {
  agents: string;
  gpt: string;
  gemini: string;
  byok: string;
  input: string;
  output: string;
}

export interface ChartPalette {
  axes: ChartAxes;
  agent: SeriesColors;
  /** Stable colour for the nth project, cycling `chart-1..5`. */
  projectColor: (index: number) => string;
  /** `projectColor` as a path→colour map, preserving project order. */
  projectColorMap: (paths: string[]) => Record<string, string>;
}

function buildChartPalette(): ChartPalette {
  const background = themeBase("background");
  const series = SERIES_TOKENS.map((token) => themeBase(token));

  const projectColor = (index: number): string => {
    const color = series[index % series.length];
    const lap = Math.floor(index / series.length);
    return lap === 0 ? color : mix(color, background, Math.min(lap * LAP_FADE, MAX_LAP_FADE));
  };

  return {
    axes: {
      grid: themeBase("border"),
      axis: themeBase("muted-foreground"),
      tickFont: 11,
      cursor: themeColor("element.hover"),
    },
    agent: {
      agents: series[0],
      gpt: series[1],
      gemini: series[2],
      byok: series[3],
      input: series[4],
      output: series[1],
    },
    projectColor,
    projectColorMap: (paths) =>
      Object.fromEntries(paths.map((path, index) => [path, projectColor(index)])),
  };
}

export function useChartPalette(): ChartPalette {
  // `version` is the whole dependency: it changes on `atlas:theme-applied` and
  // on nothing else, which is exactly when the resolved values move.
  const version = useThemeVersion();
  return useMemo(buildChartPalette, [version]);
}
