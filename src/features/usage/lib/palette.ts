/**
 * The series palette: low-saturation grays with a whisper of hue, so adjacent series stay
 * distinguishable without breaking the AMOLED monochrome theme. NO bright / saturated hues.
 * Cycles. (Moved from the old Console's chart-theme.ts; the ordering is unchanged.)
 */
const SERIES_PALETTE = [
  "#cfcfd4", // light gray
  "#9aa3ad", // slate
  "#a8b0a3", // sage-gray
  "#b3aa9e", // warm gray
  "#a39fb0", // mauve-gray
  "#8f96a0", // cool gray
  "#bdb6ab", // sand-gray
  "#9bb0aa", // muted teal-gray
  "#b0a6b3", // dusty lilac-gray
  "#878d92", // graphite
] as const;

export function seriesColor(index: number): string {
  return SERIES_PALETTE[index % SERIES_PALETTE.length];
}

/** The tint the "Other" bucket draws in — quieter than any named series. */
export const OTHER_COLOR = "#4a4d52";
