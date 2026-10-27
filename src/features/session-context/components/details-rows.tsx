// The Details card's row kit. Every row in the card is one of four shapes:
//
//   DetailsSection     a group; a hairline above it, an optional heading
//   DetailsRow         one action, or a plain fact without `onClick`
//   DetailsSelect      one button that opens a picker: label, divider, ⌄
//   DetailsSplit       an action, a divider, and a ⌄ menu beside it
//
// One box for all of them: a 32px row (two lines when `multiline`), a 14px
// muted glyph, medium secondary ink that steps to the foreground on hover,
// and a background-only hover (`element-hover`). The ⌄ menus are as wide as
// their row.

import { useRef, type ComponentProps, type MouseEventHandler, type ReactNode } from "react";
import { ChevronDown, type LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/ui/dropdown-menu";

const ROW =
  "flex w-full min-w-0 items-center gap-2.5 rounded-md px-2 text-left text-sm font-medium text-secondary-foreground outline-none transition-colors duration-fast ease-out-strong";
const ROW_SINGLE = "h-8";
const ROW_MULTI = "min-h-8 py-1.5";
const INTERACTIVE =
  "cursor-pointer hover:bg-element-hover hover:text-foreground focus-visible:bg-element-hover data-popup-open:bg-element-hover data-popup-open:text-foreground";
const DISABLED = "cursor-default opacity-60";

/** The glyph at a row's start. */
export function RowIcon({ icon: Icon, className }: { icon: LucideIcon; className?: string }) {
  return <Icon size={14} className={cn("shrink-0 text-muted-foreground", className)} aria-hidden />;
}

/** The label: takes the room, truncates. */
export function RowLabel({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("min-w-0 flex-1 truncate", className)}>{children}</span>;
}

/** Quiet trailing text: a count, a number, a state. */
export function RowMeta({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn("shrink-0 text-2xs font-normal text-muted-foreground tabular-nums", className)}
    >
      {children}
    </span>
  );
}

/** `+N −N` in the diff inks. */
export function DiffStat({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span className="flex shrink-0 items-center gap-1.5 font-mono text-2xs font-normal tabular-nums">
      <span className="text-success">+{additions.toLocaleString()}</span>
      <span className="text-error">−{deletions.toLocaleString()}</span>
    </span>
  );
}

/**
 * A group of rows. Without `title` it has no heading (the Workspace and
 * Version control groups read as plain rows); `label` names it for screen
 * readers either way. Every group after the first draws a hairline above.
 */
export function DetailsSection({
  label,
  title,
  actions,
  children,
}: {
  label: string;
  title?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-label={label} className="border-t border-border p-1.5 first:border-t-0">
      {title && (
        <div className="flex min-h-7 min-w-0 items-center justify-between gap-2 px-2">
          <h3 className="min-w-0 truncate text-2xs font-medium text-muted-foreground select-none">
            {title}
          </h3>
          {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
        </div>
      )}
      {children}
    </section>
  );
}

/** One full-width action. Without `onClick` it is a plain fact row. */
export function DetailsRow({
  onClick,
  onContextMenu,
  disabled,
  title,
  multiline,
  className,
  children,
}: {
  onClick?: () => void;
  onContextMenu?: MouseEventHandler<HTMLElement>;
  disabled?: boolean;
  /** Native tooltip: the full value when the label truncates, or why the
   *  row is off. */
  title?: string;
  multiline?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const box = cn(ROW, multiline ? ROW_MULTI : ROW_SINGLE);
  if (!onClick) {
    return (
      <div title={title} onContextMenu={onContextMenu} className={cn(box, className)}>
        {children}
      </div>
    );
  }
  return (
    <button
      type="button"
      title={title}
      // `aria-disabled`, not `disabled`: a disabled button takes no hover, and
      // its title is the only place that says why it is off.
      aria-disabled={disabled || undefined}
      onClick={disabled ? undefined : onClick}
      onContextMenu={onContextMenu}
      className={cn(box, disabled ? DISABLED : INTERACTIVE, className)}
    >
      {children}
    </button>
  );
}

/** The ⌄ cell at a select row's end, behind a divider. */
function ChevronCell() {
  return (
    <span className="-me-2 flex h-4 w-8 shrink-0 items-center justify-center border-s border-border text-muted-foreground">
      <ChevronDown size={14} aria-hidden />
    </span>
  );
}

/**
 * A row that opens a picker: one button, its label, then a divided ⌄ cell.
 * A popover or menu trigger renders it through `render`, which hands it the
 * trigger's props (handlers, aria, ref).
 */
export function DetailsSelect({
  muted,
  children,
  ...props
}: Omit<ComponentProps<"button">, "className"> & {
  /** A row that adds something ("Attach project"), quieter than a value. */
  muted?: boolean;
}) {
  return (
    <button
      type="button"
      {...props}
      className={cn(ROW, ROW_SINGLE, INTERACTIVE, muted && "text-muted-foreground")}
    >
      {children}
      <ChevronCell />
    </button>
  );
}

/**
 * An action with a ⌄ beside it for the alternatives ("Open in VS Code ⌄",
 * "Commit ⌄"). The menu is anchored to the whole row and as wide as it; its
 * items are the caller's `DropdownMenuItem`s. `onMenuOpen` runs as the menu
 * opens (the Commit row reads the checkout again then).
 */
export function DetailsSplit({
  onClick,
  disabled,
  title,
  multiline,
  menuLabel,
  menu,
  trailing,
  onMenuOpen,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  multiline?: boolean;
  /** The ⌄'s accessible name. */
  menuLabel: string;
  menu: ReactNode;
  /** Replaces the ⌄ (the Commit row's elapsed time while it runs). */
  trailing?: ReactNode;
  onMenuOpen?: () => void;
  children: ReactNode;
}) {
  const groupRef = useRef<HTMLDivElement>(null);
  return (
    <div
      ref={groupRef}
      role="group"
      className="flex w-full items-center rounded-md has-data-popup-open:bg-element-hover"
    >
      <button
        type="button"
        title={title}
        aria-disabled={disabled || undefined}
        onClick={disabled ? undefined : onClick}
        className={cn(
          ROW,
          multiline ? ROW_MULTI : ROW_SINGLE,
          "flex-1 rounded-e-none",
          disabled ? DISABLED : INTERACTIVE,
        )}
      >
        {children}
      </button>
      <span aria-hidden className="h-4 w-px shrink-0 bg-border" />
      {trailing ?? (
        <DropdownMenu onOpenChange={(open) => open && onMenuOpen?.()}>
          <DropdownMenuTrigger render={<SplitMenuButton aria-label={menuLabel} />} />
          <DropdownMenuContent anchor={groupRef} align="end" className="w-(--anchor-width)">
            {menu}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

/** A split's ⌄: the trailing cell, its own hover. */
function SplitMenuButton(props: ComponentProps<"button">) {
  return (
    <button
      type="button"
      {...props}
      className={cn(
        "flex h-8 w-8 shrink-0 items-center justify-center self-stretch rounded-md rounded-s-none text-muted-foreground outline-none transition-colors duration-fast ease-out-strong",
        INTERACTIVE,
      )}
    >
      <ChevronDown size={14} aria-hidden />
    </button>
  );
}
