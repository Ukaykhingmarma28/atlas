import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import * as React from "react";

import { cn } from "@/lib/utils";
import {
  isTooltipWarm,
  markTooltipClosed,
  markTooltipOpen,
  TOOLTIP_OPEN_DELAY,
} from "@/ui/tooltip-timing";

/**
 * Border-arrow tooltip (user-supplied Skiper design, adapted to Atlas):
 * shadcn-style token classes swapped for house tokens, `animate-in` (a
 * tailwindcss-animate utility this repo does not ship) swapped for the house
 * `animate-scale-in`, and the arrow SVG's `--color-*` vars bound inline so
 * the notch matches the panel fill and hairline exactly.
 */
const HasProvider = React.createContext(false);

function TooltipProvider({
  delayDuration = TOOLTIP_OPEN_DELAY,
  skipDelayDuration = TOOLTIP_OPEN_DELAY,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return (
    <HasProvider.Provider value={true}>
      <TooltipPrimitive.Provider
        data-slot="tooltip-provider"
        delayDuration={delayDuration}
        skipDelayDuration={skipDelayDuration}
        {...props}
      />
    </HasProvider.Provider>
  );
}

interface TimingContext {
  /** True when this tooltip opened straight after another: skip the entrance. */
  instant: boolean;
  /** Drop an open that is still waiting out the delay. */
  cancelPending: () => void;
}
const Timing = React.createContext<TimingContext>({ instant: false, cancelPending: () => {} });

/**
 * Wraps itself in a provider only when none is mounted above, so a
 * `<Tooltip>` works anywhere without setup. Radix reads the NEAREST
 * provider, so wrapping unconditionally would give every tooltip a skip-delay
 * group of its own.
 *
 * Uncontrolled tooltips take their timing from `tooltip-timing.ts` instead of
 * Radix's provider: Radix is told to open at once (`delayDuration={0}`) and
 * this component applies the shared delay, so the skip-delay window also
 * spans `HintGroup` and the titlebar dock. A controlled tooltip (`open`
 * passed) is left entirely to its owner.
 */
function Tooltip({
  open: openProp,
  defaultOpen,
  onOpenChange,
  delayDuration,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  const controlled = openProp !== undefined;
  const [open, setOpen] = React.useState(defaultOpen ?? false);
  const [instant, setInstant] = React.useState(false);
  const openRef = React.useRef(open);
  openRef.current = open;
  const timer = React.useRef<ReturnType<typeof setTimeout>>(undefined);

  // An unmount while open must not leave the shared state warm forever.
  React.useEffect(
    () => () => {
      clearTimeout(timer.current);
      if (openRef.current) markTooltipClosed();
    },
    [],
  );

  const handleOpenChange = React.useCallback(
    (next: boolean) => {
      clearTimeout(timer.current);
      if (!next) {
        if (openRef.current) markTooltipClosed();
        setOpen(false);
        onOpenChange?.(false);
        return;
      }
      if (openRef.current) return;
      const show = (warm: boolean) => {
        markTooltipOpen();
        setInstant(warm);
        setOpen(true);
        onOpenChange?.(true);
      };
      const delay = delayDuration ?? TOOLTIP_OPEN_DELAY;
      if (isTooltipWarm() || delay === 0) show(isTooltipWarm());
      else timer.current = setTimeout(() => show(false), delay);
    },
    [delayDuration, onOpenChange],
  );

  const cancelPending = React.useCallback(() => clearTimeout(timer.current), []);
  const timing = React.useMemo(() => ({ instant, cancelPending }), [instant, cancelPending]);

  const root = controlled ? (
    <TooltipPrimitive.Root
      data-slot="tooltip"
      open={openProp}
      onOpenChange={onOpenChange}
      delayDuration={delayDuration}
      {...props}
    />
  ) : (
    <Timing.Provider value={timing}>
      <TooltipPrimitive.Root
        data-slot="tooltip"
        open={open}
        onOpenChange={handleOpenChange}
        delayDuration={0}
        {...props}
      />
    </Timing.Provider>
  );
  return React.useContext(HasProvider) ? root : <TooltipProvider>{root}</TooltipProvider>;
}

/**
 * While the delay runs, Radix is held at `open={false}`, so leaving the
 * trigger changes nothing Radix knows about and it never reports a close.
 * The trigger cancels the pending open itself on leave, blur and press.
 */
function TooltipTrigger({
  onPointerLeave,
  onBlur,
  onPointerDown,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  const { cancelPending } = React.useContext(Timing);
  return (
    <TooltipPrimitive.Trigger
      data-slot="tooltip-trigger"
      onPointerLeave={(e) => {
        cancelPending();
        onPointerLeave?.(e);
      }}
      onBlur={(e) => {
        cancelPending();
        onBlur?.(e);
      }}
      onPointerDown={(e) => {
        cancelPending();
        onPointerDown?.(e);
      }}
      {...props}
    />
  );
}

function TooltipContent({
  className,
  sideOffset = 0,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  const { instant } = React.useContext(Timing);
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        style={
          {
            "--color-background": "var(--bg-overlay)",
            "--color-border": "var(--border-default)",
            zIndex: 9999,
          } as React.CSSProperties
        }
        className={cn(
          "group z-50 w-fit text-balance rounded-md px-2.5 py-1 text-[11px]",
          "bg-[var(--bg-overlay)] text-text-primary",
          "outline outline-1 outline-[var(--border-default)]",
          "animate-scale-in origin-[var(--radix-tooltip-content-transform-origin)]",
          instant && "animate-none",
          className,
        )}
        {...props}
      >
        {children}
        <TooltipPrimitive.Arrow asChild>
          <span>
            <ArrowSvg />
          </span>
        </TooltipPrimitive.Arrow>
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  );
}

type TriggerProps = Record<string, unknown> & {
  "aria-label"?: string;
  "aria-labelledby"?: string;
  disabled?: boolean;
};

/**
 * Radix opens a tooltip on any focus, including the programmatic focus a
 * dialog gives its first control when it opens. Only keyboard focus should
 * show a hint; cancelling the event makes Radix skip its own handler.
 */
function openOnKeyboardFocusOnly(e: React.FocusEvent) {
  // `target`, not `currentTarget`: the trigger may be the wrapping span.
  if (!isFocusVisible(e.target)) e.preventDefault();
}

export function isFocusVisible(el: EventTarget) {
  try {
    return el instanceof Element && el.matches(":focus-visible");
  } catch {
    // Engines without the selector: treat every focus as keyboard focus.
    return true;
  }
}

/**
 * Props for the element a hint wraps. The tooltip does not name its trigger
 * (Radix only adds `aria-describedby` while it is open), so a string label
 * becomes the `aria-label` unless the element already has a name. The native
 * `title` is dropped: it would open a second, unstyled tooltip on top.
 *
 * A `title` set on an inner element (e.g. a button inside a Radix
 * `DropdownMenu.Trigger asChild`) is out of reach here — remove it at the
 * source.
 */
export function hintTriggerProps(props: TriggerProps, label: React.ReactNode) {
  const named = props["aria-label"] !== undefined || props["aria-labelledby"] !== undefined;
  return {
    title: undefined,
    "aria-label": named || typeof label !== "string" ? props["aria-label"] : label,
  };
}

/**
 * The tooltip for one icon-only control:
 *
 *   <Hint label="Refresh"><button onClick={refresh}><RefreshCw /></button></Hint>
 *
 * A disabled control fires no pointer events, so its tooltip could never
 * open. When the child has a `disabled` prop at all, the trigger is a wrapping
 * span instead. The check is on the prop being present rather than true so
 * the DOM shape does not change (and focus is not lost) when it toggles.
 * Pass `wrap={false}` where the extra span would break the layout.
 */
function Hint({
  label,
  shortcut,
  side = "bottom",
  align,
  sideOffset = 4,
  wrap,
  children,
}: {
  label: React.ReactNode;
  /** Keys shown dimmed after the label, e.g. "⌘K". */
  shortcut?: React.ReactNode;
  side?: React.ComponentProps<typeof TooltipPrimitive.Content>["side"];
  align?: React.ComponentProps<typeof TooltipPrimitive.Content>["align"];
  sideOffset?: number;
  wrap?: boolean;
  children: React.ReactElement;
}) {
  const child = React.Children.only(children) as React.ReactElement<TriggerProps>;
  const trigger = React.cloneElement(child, hintTriggerProps(child.props, label));
  const shouldWrap = wrap ?? child.props.disabled !== undefined;

  return (
    <Tooltip>
      <TooltipTrigger asChild onFocus={openOnKeyboardFocusOnly}>
        {shouldWrap ? (
          <span className="inline-flex [&>:disabled]:pointer-events-none">{trigger}</span>
        ) : (
          trigger
        )}
      </TooltipTrigger>
      <TooltipContent side={side} align={align} sideOffset={sideOffset}>
        {label}
        {shortcut != null && <span className="ml-1.5 text-text-tertiary">{shortcut}</span>}
      </TooltipContent>
    </Tooltip>
  );
}

export { Hint, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger };

const ArrowSvg = (props: React.ComponentProps<"svg">) => (
  <svg
    width="20"
    height="10"
    viewBox="0 0 20 10"
    fill="none"
    className="ml-[1px] mt-[-1px]"
    xmlns="http://www.w3.org/2000/svg"
    {...props}
  >
    <path
      d="M10.3356 7.39793L15.1924 3.02682C15.9269 2.36577 16.8801 2 17.8683 2H20V0H0V2H1.4651C2.4532 2 3.4064 2.36577 4.1409 3.02682L8.9977 7.39793C9.378 7.7402 9.9553 7.74021 10.3356 7.39793Z"
      fill="var(--color-background)"
    />
    <path d="M11.1363 8.14124C10.3757 8.82575 9.22111 8.82578 8.46041 8.14122L3.60361 3.77011C3.05281 3.27432 2.33791 2.99999 1.59681 2.99999L4.24171 3L9.12941 7.39793C9.50971 7.7402 10.087 7.7402 10.4674 7.39793L15.3544 3L18 2.99999C17.2589 2.99999 16.544 3.27432 15.9931 3.77011L11.1363 8.14124Z" />
    <path
      d="M9.6667 6.65461L14.5235 2.28352C15.4416 1.45721 16.6331 1 17.8683 1H20V2H17.8683C16.8801 2 15.9269 2.36577 15.1924 3.02682L10.3356 7.39793C9.9553 7.74021 9.378 7.7402 8.9977 7.39793L4.1409 3.02682C3.4064 2.36577 2.4532 2 1.4651 2H0V1H1.4651C2.7002 1 3.8917 1.45722 4.8099 2.28352L9.6667 6.65461Z"
      fill="var(--color-border)"
    />
  </svg>
);
