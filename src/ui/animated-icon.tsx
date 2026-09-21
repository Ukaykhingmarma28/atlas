import { cn } from "@/lib/utils";
import { ICON_SIZES, ICON_STROKE_WIDTH, type IconSize } from "@/ui/icon";

/**
 * Icon glyphs that animate on a state change (decision 33).
 *
 * `Icon` (decision 30) renders a Lucide glyph and nothing else, which is right
 * for the ~900 static call sites. A handful of controls want the glyph itself to
 * carry the state change — the copy button that confirms, the trash whose lid
 * tips, the send arrow that leaves. Those need per-path control, so they are
 * hand-written SVG here rather than Lucide components.
 *
 * Ported from Skiper UI's `skiper42` set, with framer-motion removed. Atlas has
 * no JS animation runtime and does not want one: every animation below is CSS,
 * so it runs on the compositor thread rather than competing with React and the
 * IPC channel on the main thread. Three changes came out of that port:
 *
 *  - **`scaleX`, not `width`.** The original animates the width of the sidebar
 *    rail and the menu bars. Width is a layout property — it reflows the
 *    subtree on every frame. `scaleX` against a `transform-origin` is
 *    composited, and these are bare bars with no content to squash; the only
 *    thing it distorts is a cap or corner radius under a pixel wide.
 *  - **No `AnimatePresence`.** The copy→check swap keeps both glyphs mounted and
 *    crossfades them. Two 14px SVGs cost less than an exit-animation runtime,
 *    and it removes the unmount race the original has if you click twice fast.
 *  - **`pathLength="1"`.** framer-motion's `pathLength` is reimplemented as
 *    `stroke-dasharray`/`stroke-dashoffset` in normalised units, so the keyframe
 *    never has to know the real path length.
 *
 * Everything hover-driven is a plain `transition-*` at `duration-fast`. Only the
 * three one-shot, click-driven animations need a keyframe; those live in
 * `globals.css` next to the rest of the motion scale, with their reduced-motion
 * handling. Durations and easings come from decision 29 — there are four and
 * three of them, and these add none.
 *
 * All glyphs are **controlled**: they take the state, they don't own it. The
 * caller already has it (`copied`, `expanded`, `open`), and a glyph that kept
 * its own copy would drift from the button it sits in.
 *
 * Nothing here is positioned in CSS pixels. The original overlays a `<span>` on
 * the SVG for the rail, the menu bars and the mute slash, which fixes their
 * geometry in px while the glyph around them scales with `size` — so they line
 * up at exactly one size and are wrong at the other four. Every moving part is
 * drawn in viewBox units instead.
 */

interface GlyphProps {
  size?: IconSize;
  className?: string;
}

/** Shared SVG attributes so every glyph matches `Icon`'s weight and hinting. */
function svgProps(size: IconSize) {
  return {
    width: ICON_SIZES[size],
    height: ICON_SIZES[size],
    viewBox: "0 0 24 24",
    fill: "none" as const,
    stroke: "currentColor",
    strokeWidth: ICON_STROKE_WIDTH,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
}

/**
 * Copy → check. The check draws itself on rather than appearing, which is the
 * only part of the gesture that confirms the clipboard actually took it.
 *
 * Both glyphs stay mounted; `copied` crossfades between them. The check's draw
 * is keyed off the same flag, so re-copying replays it.
 *
 * The transition list names `scale`, not `transform`. Tailwind v4 compiles
 * `scale-75` to the standalone `scale` property rather than into `transform`,
 * and an arbitrary `transition-[…]` is passed through verbatim — so
 * `transition-[opacity,transform]` reads as correct, type-checks, lints, and
 * silently drops the scale half of the crossfade. (The bare `transition-transform`
 * utility is safe: v4 expands it to `transform, translate, scale, rotate`.)
 */
export function CopyGlyph({ copied, size = "md", className }: GlyphProps & { copied: boolean }) {
  return (
    <span
      className={cn("relative inline-grid shrink-0 place-items-center", className)}
      style={{ width: ICON_SIZES[size], height: ICON_SIZES[size] }}
    >
      <svg
        {...svgProps(size)}
        className={cn(
          "absolute transition-[opacity,scale] duration-fast ease-out-strong",
          copied ? "scale-75 opacity-0" : "scale-100 opacity-100",
        )}
      >
        <rect x="8" y="8" width="14" height="14" rx="2" ry="2" />
        <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
      </svg>
      <svg
        {...svgProps(size)}
        className={cn(
          "absolute transition-[opacity,scale] duration-fast ease-out-strong",
          copied ? "scale-100 opacity-100" : "scale-75 opacity-0",
        )}
      >
        <path
          d="M20 6 9 17l-5-5"
          pathLength={1}
          strokeDasharray={1}
          className={copied ? "animate-icon-check-draw" : "[stroke-dashoffset:1]"}
        />
      </svg>
    </span>
  );
}

/**
 * Trash whose lid tips off to the right. `armed` is for a destructive control
 * that confirms in place — the lid opening is the "are you sure" beat. On a
 * plain delete button, drive it from hover instead and the lid lifts as the
 * pointer arrives.
 *
 * The lid rotates about its right edge so it hinges rather than spinning.
 */
export function TrashGlyph({ armed, size = "md", className }: GlyphProps & { armed: boolean }) {
  return (
    <svg {...svgProps(size)} overflow="visible" className={cn("shrink-0", className)}>
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      {/* `transform-box: fill-box` is load-bearing, not tidying. An SVG child
          defaults to `view-box`, which resolves `origin-right` against the 24×24
          viewBox — (24, 12) — while the lid's own bounding box is x:3–21, y:2–6.
          The lid then hinges about a point outside itself and swings across the
          can. `fill-box` re-resolves it to the lid's own right edge, (21, 4),
          which is the hinge the drawing implies.

          The sign is load-bearing too, and POSITIVE: CSS rotation is clockwise,
          so about a right-edge hinge it is +22° that lifts the lid's far end
          clear of the can — (3, 6) → (3.6, -0.9). The negative angle buries it
          6.6 units INTO the body, which spans y:6–22. Clearing the top of the
          viewBox is also why this `<svg>` carries `overflow="visible"`. */}
      <g
        className={cn(
          "origin-right [transform-box:fill-box] transition-transform duration-base ease-in-out-strong",
          armed && "rotate-[22deg]",
        )}
      >
        <path d="M3 6h18" />
        <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      </g>
    </svg>
  );
}

/**
 * Send arrow that leaves and is replaced by the next one. `sending` is a pulse,
 * not a state: set it true on submit and false when the keyframe ends, which is
 * what `onAnimationEnd` is for. The caller owning that flag is deliberate —
 * the animation should track the actual send, not a timer that guesses at it.
 */
export function SendGlyph({
  sending,
  size = "md",
  className,
  onAnimationEnd,
}: GlyphProps & { sending: boolean; onAnimationEnd?: () => void }) {
  return (
    <span className={cn("inline-grid shrink-0 place-items-center overflow-hidden", className)}>
      <svg
        {...svgProps(size)}
        className={cn("shrink-0", sending && "animate-icon-send")}
        onAnimationEnd={onAnimationEnd}
      >
        <path d="M3.714 3.048a.498.498 0 0 0-.683.627l2.843 7.627a2 2 0 0 1 0 1.396l-2.842 7.627a.498.498 0 0 0 .682.627l18-8.5a.5.5 0 0 0 0-.904z" />
        <path d="M6 12h16" />
      </svg>
    </span>
  );
}

/**
 * Sidebar rail that thickens — the panel-toggle glyph. `open` thickens the rail
 * to read as "the panel is showing".
 *
 * `scaleX` from the left edge, so no reflow. The rail is a plain rounded bar,
 * and at these widths the radius distortion from scaling is sub-pixel.
 *
 * The rail is drawn **inside the viewBox**, not as a positioned `<span>` over
 * it. An overlaid span has to be placed in CSS pixels, but the box it sits in
 * is placed in viewBox units that scale with `size` — the two only agree at one
 * size, and at `xs` a 9px bar is taller than the 7.5px box. In viewBox units
 * both scale together, so the glyph is correct at all five.
 *
 * It is a filled `<rect>` rather than a stroked line because `scaleX` scales a
 * stroke's caps with it; a fill has no caps to distort.
 */
export function RailGlyph({ open, size = "md", className }: GlyphProps & { open: boolean }) {
  return (
    <svg {...svgProps(size)} className={cn("shrink-0", className)}>
      <rect x="2" y="3" width="20" height="18" rx="2" />
      <rect
        x="5"
        y="5.5"
        width="2"
        height="13"
        rx="1"
        fill="currentColor"
        stroke="none"
        className={cn(
          "origin-left [transform-box:fill-box] transition-transform duration-fast ease-out-strong",
          open ? "scale-x-[3]" : "scale-x-100",
        )}
      />
    </svg>
  );
}

/**
 * Three bars that shuffle their widths — the "more" / overflow glyph. The
 * original toggles this on click; hover is the better trigger for a menu
 * affordance, so `active` is left to the caller and `group-hover` works too.
 *
 * Bars are viewBox paths for the same reason `RailGlyph`'s rail is: the flex
 * version fixed the bar height and gap in CSS pixels while taking its width
 * from `size`, so the glyph went from square at `xs` to squat at `xl`. All
 * three are right-aligned to x=21 at full, half and three-quarter width.
 */
export function MenuGlyph({ active, size = "md", className }: GlyphProps & { active: boolean }) {
  const bar =
    "origin-right [transform-box:fill-box] transition-transform duration-fast ease-out-strong";
  return (
    <svg {...svgProps(size)} className={cn("shrink-0", className)}>
      <path d="M3 6h18" className={cn(bar, active ? "scale-x-50" : "scale-x-100")} />
      <path d="M12 12h9" className={cn(bar, active ? "scale-x-[2]" : "scale-x-100")} />
      <path d="M7.5 18h13.5" className={cn(bar, active ? "scale-x-[0.667]" : "scale-x-100")} />
    </svg>
  );
}

/**
 * Plus ↔ minus, rotating through each other.
 *
 * Two bars, not two Lucide glyphs: one horizontal bar stays put and a second
 * rotates 90° down onto it, so the plus *becomes* the minus. The first port
 * crossfaded Lucide's `Plus` and `Minus` and rotated the plus 90° — but a plus
 * has four-fold symmetry, so that rotation is a visual no-op and the effect
 * degraded to a plain crossfade. Rotating one arm is the gesture the original
 * actually makes.
 *
 * `transform-origin` is left at the default `view-box` here, unlike the other
 * glyphs. It resolves `origin-center` to (12, 12), which is already the bar's
 * own midpoint — the bar spans x:5–19 at y=12. There is nothing to override, so
 * the `fill-box` the rail and the menu bars need would only add noise.
 *
 * Atlas's 13 chevron expand/collapse sites already rotate a single `ChevronDown`
 * and need nothing from this file. Use this where the control adds rather than
 * reveals — a "new item" button that becomes "cancel".
 */
export function PlusMinusGlyph({ open, size = "md", className }: GlyphProps & { open: boolean }) {
  return (
    <svg {...svgProps(size)} className={cn("shrink-0", className)}>
      <path d="M5 12h14" />
      <path
        d="M5 12h14"
        className={cn(
          "origin-center transition-transform duration-base ease-in-out-strong",
          open ? "rotate-0" : "rotate-90",
        )}
      />
    </svg>
  );
}

/**
 * Bell that rings once, and carries a mute slash. `ringing` is a pulse like
 * `SendGlyph`'s `sending` — raise it when a notification actually arrives, not
 * on a timer.
 *
 * The slash wipes across the bell rather than fading in, which is what
 * distinguishes "muted" from "the icon is just dim". It is a `stroke-dashoffset`
 * transition on a `pathLength="1"` path — the same normalised trick as the copy
 * check, and paint-bound for the same reason and at the same negligible cost.
 *
 * It sits in its own `<svg>` so the ring does not swing it: a slash welded to
 * the bell would rock with it and read as part of the drawing. Drawing it in
 * viewBox units rather than as an overlaid `<span>` keeps it on the bell's own
 * stroke width at every `size`.
 */
export function BellGlyph({
  ringing = false,
  muted = false,
  size = "md",
  className,
  onAnimationEnd,
}: GlyphProps & { ringing?: boolean; muted?: boolean; onAnimationEnd?: () => void }) {
  return (
    <span
      className={cn("relative inline-grid shrink-0 place-items-center", className)}
      style={{ width: ICON_SIZES[size], height: ICON_SIZES[size] }}
    >
      <svg
        {...svgProps(size)}
        className={cn("absolute origin-top", ringing && "animate-icon-bell-ring")}
        onAnimationEnd={onAnimationEnd}
      >
        <path d="M10.268 21a2 2 0 0 0 3.464 0" />
        <path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326" />
      </svg>
      <svg {...svgProps(size)} className="absolute">
        <path
          d="m3 3 18 18"
          pathLength={1}
          strokeDasharray={1}
          className={cn(
            "transition-[stroke-dashoffset] duration-fast ease-out-strong",
            muted ? "[stroke-dashoffset:0]" : "[stroke-dashoffset:1]",
          )}
        />
      </svg>
    </span>
  );
}
