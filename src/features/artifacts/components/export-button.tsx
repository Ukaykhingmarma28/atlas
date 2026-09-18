/**
 * Take the Session out of Atlas.
 *
 * Two formats, because there are two reasons to want one — the machine-readable
 * record and the one you paste into a ticket — and the choice is one click deep
 * rather than a dialog, since neither is the obvious default.
 *
 * Lives in the Timeline header's dock beside checkpoints / filter / reload,
 * wearing the dock's trigger class, rather than floating in the masthead: it
 * is an action on the open Session, and the header is where the tab keeps
 * those.
 */

import { useState } from "react";
import { Popover } from "@base-ui/react/popover";
import { Download, Loader2 } from "lucide-react";

import { HintItem } from "@/ui/hint-group";

import type { SessionDetail as Detail } from "../types";
import { exportSession, type ExportFormat } from "../lib/export";
import { DOCK_TRIGGER } from "./header-dock";

export function ExportButton({ detail }: { detail: Detail }) {
  const [busy, setBusy] = useState<ExportFormat | null>(null);
  const [open, setOpen] = useState(false);

  const run = async (format: ExportFormat) => {
    setOpen(false);
    setBusy(format);
    try {
      await exportSession(detail, format);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <HintItem label="Export session">
        <Popover.Trigger
          render={
            <button type="button" disabled={busy !== null} className={DOCK_TRIGGER}>
              {busy ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <Download size={12} strokeWidth={1.7} />
              )}
            </button>
          }
        />
      </HintItem>
      <Popover.Portal>
        <Popover.Positioner className="z-popover" align="end" sideOffset={6}>
          <Popover.Popup className="w-[184px] origin-[var(--transform-origin)] overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--card)]/90 p-1 shadow-md backdrop-blur-2xl data-closed:animate-scale-out data-open:animate-scale-in">
            <ExportItem onClick={() => void run("md")} label="Markdown" hint=".md" />
            <ExportItem onClick={() => void run("json")} label="JSON" hint=".json" />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

function ExportItem({
  label,
  hint,
  onClick,
}: {
  label: string;
  hint: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-[var(--secondary-foreground)] transition-colors hover:bg-[var(--atlas-element-hover)] hover:text-[var(--foreground)]"
    >
      {label}
      <span className="flex-1" />
      <span className="font-mono text-2xs text-[var(--atlas-text-disabled)]">{hint}</span>
    </button>
  );
}
