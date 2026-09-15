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
import * as Popover from "@radix-ui/react-popover";
import { Download, Loader2 } from "lucide-react";

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
      <Popover.Trigger asChild>
        <button
          type="button"
          title="Export session"
          aria-label="Export session"
          disabled={busy !== null}
          className={DOCK_TRIGGER}
        >
          {busy ? (
            <Loader2 size={12} className="animate-spin" />
          ) : (
            <Download size={12} strokeWidth={1.7} />
          )}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={6}
          className="z-[var(--z-max)] w-[184px] origin-[var(--radix-popover-content-transform-origin)] overflow-hidden rounded-lg border border-[var(--border-default)] bg-[var(--bg-elevated)]/90 p-1 shadow-[var(--shadow-overlay)] backdrop-blur-2xl data-[state=closed]:animate-scale-out data-[state=open]:animate-scale-in"
        >
          <ExportItem onClick={() => void run("md")} label="Markdown" hint=".md" />
          <ExportItem onClick={() => void run("json")} label="JSON" hint=".json" />
        </Popover.Content>
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
      className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
    >
      {label}
      <span className="flex-1" />
      <span className="font-mono text-[10px] text-[var(--text-ghost)]">{hint}</span>
    </button>
  );
}
