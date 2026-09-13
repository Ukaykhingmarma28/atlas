import * as Dialog from "@radix-ui/react-dialog";
import { Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useRemoveAgentConfirmStore } from "../lib/remove-agent-confirm";

/** The app's pill-button language (matches the stop-agents dialog). */
const pillButton =
  "inline-flex items-center gap-1.5 rounded-full border border-[var(--border-default)] px-3 py-1.5 text-[11px] font-medium leading-none cursor-pointer transition-colors";

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
        <Dialog.Overlay className="fixed inset-0 z-[var(--z-max)] bg-black/45 backdrop-blur-xl" />
        <Dialog.Content
          aria-describedby={undefined}
          className={cn(
            "fixed left-1/2 top-1/2 z-[var(--z-max)] -translate-x-1/2 -translate-y-1/2",
            "w-[380px] max-w-[92vw] overflow-hidden rounded-xl border border-[var(--border-default)]",
            "bg-[var(--bg-elevated)]/60 backdrop-blur-2xl",
            "shadow-[var(--shadow-overlay)] animate-scale-in",
          )}
        >
          <div className="px-4 pt-3.5 pb-4">
            <Dialog.Title className="flex items-center gap-2 text-[13px] font-semibold tracking-[-0.01em] text-[var(--text-primary)]">
              <Trash2 size={13} className="text-error" />
              Remove {pending.name}?
            </Dialog.Title>
            <p className="mt-2 text-[12px] leading-relaxed text-[var(--text-secondary)]">
              Chats with this agent stay in history. Any chat currently using it will be asked to
              switch agents. You can install it again at any time.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                autoFocus
                onClick={() => settle(false)}
                className={cn(
                  pillButton,
                  "bg-[var(--bg-elevated)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]",
                )}
              >
                Keep
              </button>
              <button
                onClick={() => settle(true)}
                className={cn(
                  pillButton,
                  "border-error/40 bg-[var(--bg-elevated)] text-error hover:bg-error/10",
                )}
              >
                <Trash2 size={12} />
                Remove
              </button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
