import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Icon, type IconSize } from "@/ui/icon";

/**
 * A square, icon-only button (decision 32).
 *
 * shadcn covers this with `<Button size="icon">`; Atlas gives it its own
 * component because the icon-only control is the single most common thing in
 * this UI (titlebar, every panel header, every row affordance) and it has one
 * rule the text button does not: **it must carry a label**. `label` is required,
 * becomes the `aria-label`, and is what a `Tooltip` wrapper should show.
 *
 * The square is a control height, and the glyph inside is one step down from
 * it, so the icon never crowds its box:
 *
 *     xs 20px → icon xs (10)   sm 24px → icon sm (12)
 *     md 26px → icon sm (12)   lg 32px → icon md (14)
 */
const iconButtonVariants = cva(
  [
    "inline-flex shrink-0 items-center justify-center",
    "rounded border border-transparent select-none",
    "transition-colors duration-fast ease-out-strong",
    "disabled:cursor-not-allowed disabled:opacity-50",
    "[&_svg]:pointer-events-none",
  ],
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary-hover",
        destructive: "bg-destructive text-destructive-foreground hover:opacity-90",
        outline: "border-border bg-transparent text-foreground hover:bg-element-hover",
        secondary: "bg-card text-foreground hover:bg-element-hover",
        ghost: "bg-transparent text-muted-foreground hover:bg-element-hover hover:text-foreground",
      },
      size: {
        xs: "size-control-xs",
        sm: "size-control-sm",
        md: "size-control-md",
        lg: "size-control-lg",
      },
    },
    defaultVariants: { variant: "ghost", size: "md" },
  },
);

/** The glyph step that sits inside each square. */
const GLYPH_FOR_SIZE: Record<
  NonNullable<VariantProps<typeof iconButtonVariants>["size"]>,
  IconSize
> = {
  xs: "xs",
  sm: "sm",
  md: "sm",
  lg: "md",
};

export interface IconButtonProps
  extends
    Omit<React.ComponentProps<"button">, "children">,
    VariantProps<typeof iconButtonVariants> {
  icon: LucideIcon;
  /** Required: an icon-only control has no visible name. */
  label: string;
  /** Override the glyph step. Rarely needed — the square picks a sensible one. */
  iconSize?: IconSize;
}

function IconButton({
  className,
  variant,
  size,
  icon,
  label,
  iconSize,
  type = "button",
  ...props
}: IconButtonProps) {
  return (
    <button
      data-slot="icon-button"
      type={type}
      aria-label={label}
      className={cn(iconButtonVariants({ variant, size }), className)}
      {...props}
    >
      <Icon icon={icon} size={iconSize ?? GLYPH_FOR_SIZE[size ?? "md"]} />
    </button>
  );
}

export { IconButton, iconButtonVariants };
