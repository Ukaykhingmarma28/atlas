import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/**
 * The house button (decision 32).
 *
 * Shaped like shadcn's base-style `Button` — same file, same `buttonVariants`
 * export, same `variant` / `size` prop pair, same `data-slot` — so a later
 * `shadcn add <component>` that renders a button drops in without a rewrite.
 * What differs is deliberate:
 *
 *  - **Sizes are Atlas control heights**, not shadcn's 32/36/40px. Atlas is a
 *    dense, px-based UI; `md` (26px) is the compact control the audit found
 *    everywhere, and it is the default.
 *  - **No `asChild`.** shadcn's version leans on `@radix-ui/react-slot`, and
 *    `class-variance-authority` is the only new dependency Foundations may add.
 *    Compose with `buttonVariants({ variant, size })` on the element instead:
 *    `<a className={buttonVariants({ variant: "ghost" })}>`.
 *  - **Hover uses real tokens**, not `/90` opacity modifiers, which Tailwind v4
 *    compiles to `color-mix()`.
 */
const buttonVariants = cva(
  [
    "inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap",
    "rounded border border-transparent font-medium select-none",
    "transition-colors duration-fast ease-out-strong",
    "disabled:cursor-not-allowed disabled:opacity-50",
    "[&_svg]:pointer-events-none [&_svg]:shrink-0",
  ],
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary-hover",
        destructive: "bg-destructive text-destructive-foreground hover:opacity-90",
        outline: "border-border-default bg-transparent text-text-primary hover:bg-bg-hover",
        secondary: "bg-bg-elevated text-text-primary hover:bg-bg-hover",
        ghost: "bg-transparent text-text-secondary hover:bg-bg-hover hover:text-text-primary",
        link: "bg-transparent text-text-primary underline-offset-2 hover:underline",
      },
      size: {
        xs: "h-control-xs gap-1 px-1.5 text-2xs",
        sm: "h-control-sm px-2 text-xs",
        md: "h-control-md px-2.5 text-xs",
        lg: "h-control-lg px-3 text-sm",
      },
    },
    defaultVariants: { variant: "default", size: "md" },
  },
);

export interface ButtonProps
  extends React.ComponentProps<"button">, VariantProps<typeof buttonVariants> {}

function Button({ className, variant, size, type = "button", ...props }: ButtonProps) {
  return (
    <button
      data-slot="button"
      type={type}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
}

export { Button, buttonVariants };
