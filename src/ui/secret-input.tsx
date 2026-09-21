import { forwardRef, useState } from "react";
import { CopyGlyph } from "@/ui/animated-icon";
import { Eye, EyeOff } from "lucide-react";
import { cn } from "@/lib/utils";
import { HintGroup, HintItem } from "@/ui/hint-group";

/**
 * SecretInput — a masked text field with reveal + copy affordances. Modular
 * primitive: used by the BYOK provider panel today, but kept generic so any
 * "enter / inspect a secret" surface can reuse it.
 *
 * Controlled like a normal input via `value`/`onChange`. `onSubmit` fires on
 * Enter. `copyable` enables the inline copy button (copies the current value).
 */
export interface SecretInputProps extends Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  "type" | "onSubmit"
> {
  value: string;
  onValueChange?: (next: string) => void;
  onSubmit?: () => void;
  copyable?: boolean;
  /** Start revealed (default: masked). */
  defaultRevealed?: boolean;
}

export const SecretInput = forwardRef<HTMLInputElement, SecretInputProps>(function SecretInput(
  {
    value,
    onValueChange,
    onSubmit,
    copyable = false,
    defaultRevealed = false,
    className,
    onChange,
    onKeyDown,
    ...rest
  },
  ref,
) {
  const [revealed, setRevealed] = useState(defaultRevealed);
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard blocked — silently ignore */
    }
  };

  return (
    <HintGroup>
      <div
        className={cn(
          "group flex items-center gap-1 rounded-md border border-border bg-card",
          "px-2 h-8 transition-colors focus-within:border-primary",
          className,
        )}
      >
        <input
          ref={ref}
          type={revealed ? "text" : "password"}
          value={value}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          className={cn(
            "flex-1 min-w-0 bg-transparent outline-none text-xs",
            "text-foreground placeholder:text-muted-foreground font-mono",
          )}
          onChange={(e) => {
            onValueChange?.(e.target.value);
            onChange?.(e);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") onSubmit?.();
            onKeyDown?.(e);
          }}
          {...rest}
        />
        {copyable && (
          <IconBtn label={copied ? "Copied" : "Copy"} onClick={() => void copy()}>
            <CopyGlyph copied={copied} size="md" />
          </IconBtn>
        )}
        <IconBtn label={revealed ? "Hide" : "Reveal"} onClick={() => setRevealed((r) => !r)}>
          {revealed ? <EyeOff size={13} /> : <Eye size={13} />}
        </IconBtn>
      </div>
    </HintGroup>
  );
});

function IconBtn({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <HintItem label={label} className="shrink-0">
      <button
        type="button"
        tabIndex={-1}
        onClick={onClick}
        className="shrink-0 grid place-items-center h-6 w-6 rounded text-muted-foreground hover:text-foreground hover:bg-element-hover transition-colors"
      >
        {children}
      </button>
    </HintItem>
  );
}
