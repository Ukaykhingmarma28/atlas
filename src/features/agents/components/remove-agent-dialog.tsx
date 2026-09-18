import { Dialog } from "@base-ui/react/dialog";
import { Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useRemoveAgentConfirmStore } from "../lib/remove-agent-confirm";

/** The app's pill-button language (matches the stop-agents dialog). */
const pillButton =
  "inline-flex items-center gap-1.5 rounded-full border border-[var(--border)] px-3 py-1.5 text-xs font-medium leading-none cursor-pointer transition-colors";

/**
 * "Remove this agent?" confirmation for Settings → Agents, driven by
 * `useRemoveAgentConfirmStore.ask()`. Mounted once in App. Radix handles
 * Esc/overlay-click as dismiss → treated as "Keep".
 */
export function RemoveAgentDialog() {
  const pending = useRemoveAgentConfirmStore.use.pending();
  const { settle } = useRemoveAgentConfirmStore.use.actions();
  if (!pending) return null;

  return (
    <Dialog.Root open onOpenChange={(open) => !open && settle(false)}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-overlay bg-black/45 backdrop-blur-xl" />
        <Dialog.Popup
          aria-describedby={undefined}
          className={cn(
            "fixed left-1/2 top-1/2 z-modal -translate-x-1/2 -translate-y-1/2",
            "w-[380px] max-w-[92vw] overflow-hidden rounded-xl border border-[var(--border)]",
            "bg-[var(--card)]/60 backdrop-blur-2xl",
            "shadow-md animate-scale-in",
          )}
        >
          <div className="px-4 pt-3.5 pb-4">
            <Dialog.Title className="flex items-center gap-2 text-base font-semibold tracking-[-0.01em] text-[var(--foreground)]">
              <Trash2 size={13} className="text-error" />
              Remove {pending.name}?
            </Dialog.Title>
            <p className="mt-2 text-sm leading-relaxed text-[var(--secondary-foreground)]">
              Chats with this agent stay in history. Any chat currently using it will be asked to
              switch agents. You can install it again at any time.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                autoFocus
                onClick={() => settle(false)}
                className={cn(
                  pillButton,
                  "bg-[var(--card)] text-[var(--secondary-foreground)] hover:bg-[var(--atlas-element-hover)] hover:text-[var(--foreground)]",
                )}
              >
                Keep
              </button>
              <button
                onClick={() => settle(true)}
                className={cn(
                  pillButton,
                  "border-error/40 bg-[var(--card)] text-error hover:bg-error/10",
                )}
              >
                <Trash2 size={12} />
                Remove
              </button>
            </div>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
