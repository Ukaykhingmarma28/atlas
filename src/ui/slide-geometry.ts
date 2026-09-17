// The arithmetic behind a sliding tooltip: one strip holding every label of a
// row of controls, translated so the active label centres under its control
// and clipped so only that label shows. Shared by the titlebar dock and
// `HintGroup`.

export interface SlideGeometry {
  /** Strip offset, in px, that centres the active label on its control. */
  tx: number;
  /** Percentages hiding everything either side of the active label. */
  left: number;
  right: number;
}

/**
 * `widths` are the strip's label widths in strip order, `stripLeft` is where
 * the untranslated strip starts. Returns null when nothing is laid out yet.
 */
export function slideGeometry({
  index,
  widths,
  controlCentre,
  stripLeft,
  viewportWidth,
  margin,
}: {
  index: number;
  widths: number[];
  controlCentre: number;
  stripLeft: number;
  viewportWidth: number;
  margin: number;
}): SlideGeometry | null {
  const width = widths[index] ?? 0;
  let before = 0;
  for (let i = 0; i < index; i++) before += widths[i] ?? 0;
  let after = 0;
  for (let i = index + 1; i < widths.length; i++) after += widths[i] ?? 0;
  const total = before + width + after;
  if (total <= 0) return null;

  let tx = controlCentre - (stripLeft + before + width / 2);

  // After the shift the active label spans [centre - w/2, centre + w/2].
  // Push it back inside the viewport if either edge escapes.
  const overflowRight = controlCentre + width / 2 - (viewportWidth - margin);
  if (overflowRight > 0) tx -= overflowRight;
  const overflowLeft = margin - (controlCentre - width / 2);
  if (overflowLeft > 0) tx += overflowLeft;

  return { tx, left: (before / total) * 100, right: (after / total) * 100 };
}
