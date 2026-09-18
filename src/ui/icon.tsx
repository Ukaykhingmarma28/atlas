import type { LucideIcon, LucideProps } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The one way to render an icon (decision 30).
 *
 * The audit found Lucide sized with a raw `size=` at 903 call sites across six
 * values — 11 (289), 12 (223), 10 (106), 13 (94), 14 (44) and a tail — with ten
 * distinct `strokeWidth`s on top. Two of those sizes are half-steps of the
 * others and exist only because someone nudged a row by a pixel.
 *
 * So there are five sizes, and one default stroke width. When the sweep moves a
 * call site, it maps the old number to the nearest step:
 *
 *     9 → 10 (xs) · 10 → 10 (xs) · 11 → 12 (sm) · 12 → 12 (sm)
 *     13 → 14 (md) · 14 → 14 (md) · 16 → 16 (lg) · 20 → 20 (xl)
 *
 * Deliberately NOT migrated in Foundations: the primitives in `src/ui` use it,
 * and everything else moves in the colour-and-scale sweep.
 */
export const ICON_SIZES = {
  xs: 10,
  sm: 12,
  md: 14,
  lg: 16,
  xl: 20,
} as const;

export type IconSize = keyof typeof ICON_SIZES;

/** The one stroke width. Lucide's own default is 2, which reads heavy at 10–14px. */
export const ICON_STROKE_WIDTH = 1.75;

export interface IconProps extends Omit<LucideProps, "size" | "ref"> {
  /** The Lucide component, passed as a value: `<Icon icon={Search} />`. */
  icon: LucideIcon;
  size?: IconSize;
}

export function Icon({
  icon: Glyph,
  size = "md",
  strokeWidth = ICON_STROKE_WIDTH,
  className,
  ...props
}: IconProps) {
  return (
    <Glyph
      size={ICON_SIZES[size]}
      strokeWidth={strokeWidth}
      className={cn("shrink-0", className)}
      aria-hidden={props["aria-label"] ? undefined : true}
      {...props}
    />
  );
}
