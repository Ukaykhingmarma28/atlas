import * as React from "react";
import { ContextMenu as ContextMenuPrimitive } from "@base-ui/react/context-menu";
import { Check, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Atlas-themed shadcn base-style context menu built on
 * `@base-ui/react/context-menu`. Used by the file-tree row menu, the
 * keybindings table and any future surface that needs right-click actions.
 *
 * Anatomy is Base UI's: `Portal > Positioner > Popup`. The positioning props
 * are declared on `ContextMenuContent` and forwarded to the Positioner — left
 * in `...props` they would land on the Popup, which is the wrong node, and
 * nothing would type-error.
 *
 * Styling is the house scale: `rounded-lg` (menus), `shadow-md`
 * (`--elevation-menu`), the `z-popover` layer — which sits *above* `z-modal` on
 * purpose, so a menu opened inside a dialog escapes it — and `duration-base`
 * with `ease-out-strong` for the entrance.
 */

const ContextMenu = ContextMenuPrimitive.Root;
const ContextMenuTrigger = ContextMenuPrimitive.Trigger;
const ContextMenuGroup = ContextMenuPrimitive.Group;
const ContextMenuPortal = ContextMenuPrimitive.Portal;
const ContextMenuSub = ContextMenuPrimitive.SubmenuRoot;
const ContextMenuRadioGroup = ContextMenuPrimitive.RadioGroup;

/** The shared popup surface, so Content and SubContent cannot drift apart. */
const POPUP = [
  "min-w-[11rem] overflow-hidden rounded-lg p-0.5",
  "bg-popover border border-border text-foreground shadow-md",
  "origin-[var(--transform-origin)] animate-scale-in",
];

type PositionerProps = Pick<
  ContextMenuPrimitive.Positioner.Props,
  "align" | "alignOffset" | "side" | "sideOffset"
>;

function ContextMenuContent({
  className,
  align,
  alignOffset,
  side,
  sideOffset,
  ...props
}: ContextMenuPrimitive.Popup.Props & PositionerProps) {
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Positioner
        className="isolate z-popover outline-none"
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
      >
        <ContextMenuPrimitive.Popup
          data-slot="context-menu-content"
          className={cn(POPUP, className)}
          {...props}
        />
      </ContextMenuPrimitive.Positioner>
    </ContextMenuPrimitive.Portal>
  );
}

function ContextMenuItem({
  className,
  inset,
  variant = "default",
  ...props
}: ContextMenuPrimitive.Item.Props & {
  inset?: boolean;
  variant?: "default" | "destructive";
}) {
  return (
    <ContextMenuPrimitive.Item
      data-slot="context-menu-item"
      data-inset={inset ? "" : undefined}
      data-variant={variant}
      className={cn(
        "group/context-menu-item relative flex items-center gap-2 rounded px-2 py-1",
        "text-xs cursor-pointer select-none outline-none",
        "text-secondary-foreground",
        "focus:bg-element-hover focus:text-foreground",
        "data-[inset]:pl-6",
        // `destructive` variant kept for completeness but rendered the
        // same as default — per UX feedback, file-tree Delete reads as
        // a regular item; the confirm dialog is where the destructive
        // affordance lives.
        "data-disabled:pointer-events-none data-disabled:opacity-50",
        "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
        className,
      )}
      {...props}
    />
  );
}

function ContextMenuSubTrigger({
  className,
  inset,
  children,
  ...props
}: ContextMenuPrimitive.SubmenuTrigger.Props & {
  inset?: boolean;
}) {
  return (
    <ContextMenuPrimitive.SubmenuTrigger
      data-slot="context-menu-sub-trigger"
      data-inset={inset ? "" : undefined}
      className={cn(
        "flex items-center gap-2 rounded px-2 py-1 text-xs",
        "cursor-pointer select-none outline-none",
        "text-secondary-foreground",
        "focus:bg-element-hover focus:text-foreground",
        "data-popup-open:bg-element-hover data-popup-open:text-foreground",
        "data-[inset]:pl-6",
        "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
        className,
      )}
      {...props}
    >
      {children}
      <ChevronRight className="ml-auto" />
    </ContextMenuPrimitive.SubmenuTrigger>
  );
}

/**
 * Composes the public Content wrapper rather than rebuilding from primitives.
 * The `align`/`alignOffset`/`side`/`sideOffset` quartet is the submenu's
 * visual alignment with its parent item and is load-bearing — Radix's
 * SubContent implied them, Base UI's Positioner does not.
 */
function ContextMenuSubContent({
  className,
  align = "start",
  alignOffset = 4,
  side = "right",
  sideOffset = 0,
  ...props
}: React.ComponentProps<typeof ContextMenuContent>) {
  return (
    <ContextMenuContent
      data-slot="context-menu-sub-content"
      align={align}
      alignOffset={alignOffset}
      side={side}
      sideOffset={sideOffset}
      className={cn("min-w-[10rem]", className)}
      {...props}
    />
  );
}

function ContextMenuCheckboxItem({
  className,
  children,
  checked,
  inset,
  ...props
}: ContextMenuPrimitive.CheckboxItem.Props & {
  inset?: boolean;
}) {
  return (
    <ContextMenuPrimitive.CheckboxItem
      data-slot="context-menu-checkbox-item"
      data-inset={inset ? "" : undefined}
      className={cn(
        "relative flex items-center gap-2 rounded-md py-1.5 pr-8 pl-7 text-sm",
        "cursor-default select-none outline-none",
        "text-secondary-foreground",
        "focus:bg-element-hover focus:text-foreground",
        "data-disabled:pointer-events-none data-disabled:opacity-50",
        className,
      )}
      checked={checked}
      {...props}
    >
      <span className="pointer-events-none absolute left-2 inline-flex h-3 w-3 items-center justify-center">
        <ContextMenuPrimitive.CheckboxItemIndicator>
          <Check size={12} />
        </ContextMenuPrimitive.CheckboxItemIndicator>
      </span>
      {children}
    </ContextMenuPrimitive.CheckboxItem>
  );
}

function ContextMenuLabel({
  className,
  inset,
  ...props
}: ContextMenuPrimitive.GroupLabel.Props & {
  inset?: boolean;
}) {
  return (
    <ContextMenuPrimitive.GroupLabel
      data-slot="context-menu-label"
      data-inset={inset ? "" : undefined}
      className={cn("eyebrow px-2 py-1 text-muted-foreground", "data-[inset]:pl-7", className)}
      {...props}
    />
  );
}

function ContextMenuSeparator({
  className,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Separator>) {
  return (
    <ContextMenuPrimitive.Separator
      data-slot="context-menu-separator"
      className={cn("-mx-1 my-1 h-px bg-border", className)}
      {...props}
    />
  );
}

function ContextMenuShortcut({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="context-menu-shortcut"
      className={cn(
        "ml-auto pl-3 text-3xs text-disabled",
        "group-focus/context-menu-item:text-secondary-foreground",
        className,
      )}
      {...props}
    />
  );
}

export {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuGroup,
  ContextMenuPortal,
  ContextMenuSub,
  ContextMenuRadioGroup,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSubTrigger,
  ContextMenuSubContent,
  ContextMenuCheckboxItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuShortcut,
};
