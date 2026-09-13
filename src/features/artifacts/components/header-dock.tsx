/**
 * The Timeline header's action dock.
 *
 * One pill holding every icon control, in the shape the titlebar dock uses
 * (`components/titlebar-dock.tsx`): a hairline round-ended track, icons as
 * round hover targets inside it, no dividers between them. The controls used to
 * be two bordered segments and a loose button, which drew three boxes in a 32px
 * bar to say one thing — "here are the tab's actions".
 *
 * No shared morphing tooltip here. The dock's tooltip machinery exists because
 * the titlebar has no room for labels; this bar does, and each control carries
 * its own `title`.
 *
 * Its own module rather than living in the panel, because the checkpoints picker
 * needs the trigger class too — and importing it from the panel, which imports
 * the picker, is a cycle that happens to work until someone moves a top-level
 * constant.
 */

import { cn } from "@/lib/utils";

/**
 * The pill that gathers the header's icon controls.
 *
 * **The geometry is concentric, and it has to stay that way.** Round inside
 * round only looks right when the inner radius equals the outer radius minus
 * the padding, and the padding is the same on all four sides: 28px tall, 4px of
 * inset, 20px buttons — so 14 − 4 = 10, the button's own radius. The first pass
 * used 22px buttons with 6px of side padding, which left them tangent to the
 * pill's end caps: a hovered button's fill ran into the border at the ends and
 * the two curves visibly disagreed.
 */
export function HeaderDock({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-7 items-center gap-1.5 rounded-full border border-white/[0.07] bg-[#121212] p-1">
      {children}
    </div>
  );
}

/**
 * The class an icon control wears inside a {@link HeaderDock}.
 *
 * Exported rather than wrapped in a component because Radix owns the popover
 * triggers via `asChild` and hands them the class directly — including the
 * `data-[state=open]` styling that keeps a button lit while its menu is up.
 */
export const DOCK_TRIGGER =
  "relative flex size-5 cursor-pointer items-center justify-center rounded-full outline-none " +
  "text-[var(--text-tertiary)] transition-colors duration-150 hover:bg-white/[0.08] hover:text-[var(--text-primary)] " +
  "data-[state=open]:bg-white/[0.12] data-[state=open]:text-[var(--text-primary)]";

/** Applied on top of {@link DOCK_TRIGGER} when the control's mode is on. */
export const DOCK_ACTIVE = "bg-white/[0.12] text-[var(--text-primary)]";

/** A plain button inside the dock. */
export function DockButton({
  label,
  onClick,
  active,
  children,
}: {
  label: string;
  onClick: () => void;
  active?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      title={label}
      onClick={onClick}
      className={cn(DOCK_TRIGGER, active && DOCK_ACTIVE)}
    >
      {children}
    </button>
  );
}
