import { Slider as SliderPrimitive } from "@base-ui/react/slider";
import { cn } from "@/lib/utils";

/**
 * The house slider, built on `@base-ui/react/slider`: one thumb over a track
 * whose filled part is the brand colour.
 *
 * `onValueChange` fires on every step of a drag and `onValueCommitted` once,
 * on release. A control bound to `config.toml` saves on the second: every save
 * rewrites the file.
 */
export interface SliderProps {
  value: number;
  min: number;
  max: number;
  step?: number;
  disabled?: boolean;
  onValueChange: (value: number) => void;
  onValueCommitted?: (value: number) => void;
  "aria-label"?: string;
  className?: string;
}

export function Slider({
  value,
  min,
  max,
  step = 1,
  disabled,
  onValueChange,
  onValueCommitted,
  className,
  ...props
}: SliderProps) {
  return (
    <SliderPrimitive.Root
      value={value}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      onValueChange={(next) => onValueChange(next)}
      onValueCommitted={(next) => onValueCommitted?.(next)}
      className={cn("w-full data-disabled:opacity-50", className)}
    >
      <SliderPrimitive.Control className="flex h-5 w-full cursor-pointer touch-none items-center select-none">
        <SliderPrimitive.Track className="relative h-1 w-full rounded-full bg-element-selected">
          <SliderPrimitive.Indicator className="rounded-full bg-primary" />
          <SliderPrimitive.Thumb
            aria-label={props["aria-label"]}
            className={cn(
              "size-3.5 rounded-full border border-border-strong bg-foreground shadow-sm outline-none",
              "transition-transform duration-fast ease-out-strong",
              "focus-visible:ring-2 focus-visible:ring-ring data-dragging:scale-110",
            )}
          />
        </SliderPrimitive.Track>
      </SliderPrimitive.Control>
    </SliderPrimitive.Root>
  );
}
