// Shared two-panel skill/pack modal, modelled on the agent "Review plan" modal
// (permission-modal.tsx): a wide dialog with the DESCRIPTION on the left and
// ACTIONS on the right. Used by both Discover (install / copy / GitHub) and My
// Skills (projection / promote / uninstall). One skill collapses to a single
// description; a pack lists its skills + descriptions.

import { Dialog } from "@base-ui/react/dialog";
import { Loader2, X, type LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

export interface ModalSkill {
  name: string;
  description?: string | null;
}

export function SkillModalShell({
  open,
  onClose,
  title,
  subtitle,
  children,
  actions,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  actions: React.ReactNode;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-overlay scrim backdrop-blur-sm" />
        <Dialog.Popup
          aria-describedby={undefined}
          className={cn(
            // Centered in the viewport.
            "fixed left-1/2 top-1/2 z-modal -translate-x-1/2 -translate-y-1/2",
            "flex max-h-[86vh] w-[760px] max-w-[94vw] flex-col overflow-hidden",
            "rounded-lg border border-border bg-card",
            "shadow-lg animate-scale-in text-foreground",
          )}
        >
          <div className="flex items-start gap-3 border-b border-border px-4 py-3">
            <div className="min-w-0 flex-1">
              <Dialog.Title className="truncate text-sm font-semibold">{title}</Dialog.Title>
              {subtitle && (
                <div className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
                  {subtitle}
                </div>
              )}
            </div>
            <Dialog.Close
              aria-label="Close"
              className="shrink-0 rounded p-1 text-muted-foreground hover:bg-element-hover hover:text-foreground"
            >
              <X size={14} />
            </Dialog.Close>
          </div>

          <div className="flex min-h-0 flex-1">
            <section className="min-h-0 min-w-0 flex-1 overflow-auto hide-scrollbar px-5 py-4">
              {children}
            </section>
            <aside className="min-h-0 w-[280px] shrink-0 overflow-auto hide-scrollbar border-l border-border px-4 py-4">
              {actions}
            </aside>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Left-pane content: a single skill's description, or a pack's list of skills
 *  with their descriptions. */
export function SkillDescriptions({
  skills,
  fallback,
}: {
  skills: ModalSkill[];
  fallback?: React.ReactNode;
}) {
  if (skills.length === 0) {
    return (
      <div className="text-sm text-muted-foreground">{fallback ?? "No description published."}</div>
    );
  }
  if (skills.length === 1) {
    const s = skills[0];
    return s.description ? (
      <p className="text-base leading-relaxed text-secondary-foreground">{s.description}</p>
    ) : (
      <div className="text-sm text-muted-foreground">{fallback ?? "No description published."}</div>
    );
  }
  return (
    <div className="flex flex-col gap-3.5">
      {skills.map((s) => (
        <div key={s.name}>
          <div className="text-sm font-medium text-foreground">{s.name}</div>
          {s.description && (
            <div className="mt-0.5 text-sm leading-relaxed text-muted-foreground">
              {s.description}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/** Full-width outlined action button for the right pane. */
export function ModalAction({
  icon: Icon,
  label,
  onClick,
  disabled,
  variant = "default",
  busy,
}: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  variant?: "default" | "primary" | "danger";
  busy?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || busy}
      className={cn(
        "flex w-full items-center gap-2 rounded-md border px-2.5 py-2 text-sm font-medium transition-colors disabled:opacity-50",
        variant === "primary"
          ? "border-border text-foreground hover:bg-element-hover"
          : variant === "danger"
            ? "border-error/40 text-error hover:bg-error/10"
            : "border-border text-secondary-foreground hover:bg-element-hover hover:text-foreground",
      )}
    >
      {busy ? (
        <Loader2 size={13} className="shrink-0 animate-spin" />
      ) : (
        <Icon size={13} className="shrink-0" />
      )}
      {label}
    </button>
  );
}
