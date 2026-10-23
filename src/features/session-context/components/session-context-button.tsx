// The overlay's trigger — the main pane header's "≡" button, which opens the
// session context card below-end.
//
// While capture is recording the button carries a STEADY green dot, never a
// pulse: capture is on for hours, and a light that moves pulls the eye every
// time it does (the same call `CaptureDot` makes for the titlebar). A fault
// keeps its own colour — a stopped recorder painted green would be a lie.

import { Popover } from "@base-ui/react/popover";
import { List } from "lucide-react";

import { CaptureDot } from "@/features/capture/components/capture-status";
import { projectPathForTab } from "@/features/chat/lib/tab-project";
import { useProjectStore } from "@/features/projects/stores/project-store";
import { cn } from "@/lib/utils";
import { HintItem } from "@/ui/hint-group";
import { IconButton } from "@/ui/icon-button";

import { useCaptureState } from "../lib/use-capture-state";
import { NO_TAB_KEY, useSessionContextStore } from "../stores/session-context-store";
import { SessionContextBody } from "./session-context-popover";

export interface SessionContextButtonProps {
  /** The chat tab the header belongs to. Omit (or `null`) for a non-chat tab:
   *  the overlay then shows the project's rows only. */
  tabId?: string | null;
  /** The project to describe. Defaults to the tab's own project, else the
   *  active one — pass it when the header already knows it. */
  projectPath?: string | null;
  className?: string;
}

export function SessionContextButton({
  tabId = null,
  projectPath,
  className,
}: SessionContextButtonProps) {
  const activePath = useProjectStore(
    (s) => s.projects.find((p) => p.id === s.activeProjectId)?.path ?? null,
  );
  const path = projectPath ?? (tabId ? projectPathForTab(tabId) : null) ?? activePath;

  const key = tabId ?? NO_TAB_KEY;
  const open = useSessionContextStore((s) => s.openFor === key);
  const view = useSessionContextStore.use.view();
  const { setOpen } = useSessionContextStore.use.actions();
  const capture = useCaptureState(path);

  const label = capture.recording
    ? `Session context — ${capture.health?.summary ?? "capture is on"}`
    : "Session context";

  return (
    <Popover.Root open={open} onOpenChange={(next) => setOpen(key, next)}>
      <span className={cn("relative inline-flex", className)}>
        <HintItem label={label}>
          <Popover.Trigger
            render={<IconButton icon={List} label={label} size="sm" iconSize="md" />}
          />
        </HintItem>
        {capture.recording && (
          <span
            data-capture-dot
            className="pointer-events-none absolute -top-0.5 -right-0.5"
            aria-hidden
          >
            <CaptureDot tone={capture.tone === "idle" ? "success" : capture.tone} />
          </span>
        )}
      </span>
      <Popover.Portal>
        <Popover.Positioner className="z-popover" side="bottom" align="end" sideOffset={6}>
          <Popover.Popup
            aria-label="Session context"
            className={cn(
              "max-h-(--available-height) origin-[var(--transform-origin)] overflow-y-auto overscroll-contain",
              "rounded-lg border border-border bg-popover text-foreground shadow-md outline-none",
              "data-closed:animate-scale-out data-open:animate-scale-in",
              // 300px gives the rows a little room past a compact card. The
              // capture view keeps the 352px its radar is laid out against.
              view === "capture" ? "w-[352px]" : "w-[300px]",
            )}
          >
            <SessionContextBody tabId={tabId} projectPath={path} capture={capture} />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
