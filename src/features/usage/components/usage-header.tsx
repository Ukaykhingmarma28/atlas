import * as Popover from "@radix-ui/react-popover";
import { Copy, Download, FileText, FileType2, Image as ImageIcon, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { HintGroup, HintItem } from "@/ui/hint-group";
import { DockButton, DOCK_TRIGGER, HeaderDock } from "@/features/artifacts/components/header-dock";
import type { DateRange } from "../types";
import { DateRangeControl } from "./date-range-control";

export type ExportKind = "pdf" | "jpeg" | "markdown" | "copy-markdown";

/**
 * The Usage header: what window you are looking through, and the two actions
 * on the page.
 *
 * Built to the Timeline's bar rather than its own thing — a name on the left,
 * one round-ended track for the setting, one icon dock on the right. What it
 * replaced drew five bordered boxes across two rows (presets, custom, export,
 * and a label-plus-box for each of group and metric) plus an app icon, which
 * is a lot of chrome to say "last 30 days".
 *
 * No Atlas mark: a tab inside the app does not need to say which app it is,
 * and it was the only icon in a bar whose other glyphs all do something.
 */
export function UsageHeader({
  orgName,
  range,
  onRange,
  earliest,
  onExport,
  onRefresh,
  loading,
  canExport,
  inset,
}: {
  orgName: string | null;
  range: DateRange;
  onRange: (r: DateRange) => void;
  earliest: string | null;
  onExport: (kind: ExportKind) => void;
  onRefresh: () => void;
  loading: boolean;
  canExport: boolean;
  /** The card's inset, so the bar's ends line up with the body below it. */
  inset: number;
}) {
  return (
    <div className="flex h-[32px] shrink-0 items-center gap-2" style={{ paddingInline: inset + 6 }}>
      <span className="shrink-0 text-[12px] font-semibold text-[var(--text-primary)]">Usage</span>
      {orgName && (
        <span className="min-w-0 truncate text-[11px] text-[var(--text-tertiary)]" title={orgName}>
          {orgName}
        </span>
      )}

      <div className="ml-auto flex shrink-0 items-center gap-2">
        <DateRangeControl range={range} onChange={onRange} earliest={earliest} />
        <HintGroup>
          <HeaderDock>
            <ExportMenu onExport={onExport} disabled={!canExport} />
            <DockButton label="Reload usage" onClick={onRefresh}>
              <RefreshCw size={12} className={cn(loading && "animate-spin")} />
            </DockButton>
          </HeaderDock>
        </HintGroup>
      </div>
    </div>
  );
}

const ITEMS: ReadonlyArray<{ kind: ExportKind; label: string; hint: string; icon: typeof Copy }> = [
  { kind: "pdf", label: "PDF report", hint: ".pdf", icon: FileType2 },
  { kind: "jpeg", label: "JPEG image", hint: ".jpg", icon: ImageIcon },
  { kind: "markdown", label: "Markdown report", hint: ".md", icon: FileText },
  { kind: "copy-markdown", label: "Copy as Markdown", hint: "⌘C", icon: Copy },
];

/** Export, as a dock glyph — same shape the Timeline's export takes. */
function ExportMenu({
  onExport,
  disabled,
}: {
  onExport: (kind: ExportKind) => void;
  disabled: boolean;
}) {
  return (
    <Popover.Root>
      <HintItem label="Export usage">
        <Popover.Trigger asChild>
          <button
            type="button"
            disabled={disabled}
            className={cn(DOCK_TRIGGER, "disabled:opacity-40")}
          >
            <Download size={12} strokeWidth={1.7} />
          </button>
        </Popover.Trigger>
      </HintItem>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={6}
          className="z-[var(--z-max)] w-[196px] origin-[var(--radix-popover-content-transform-origin)] overflow-hidden rounded-lg border border-[var(--border-default)] bg-[var(--bg-elevated)]/90 p-1 shadow-[var(--shadow-overlay)] backdrop-blur-2xl data-[state=closed]:animate-scale-out data-[state=open]:animate-scale-in"
        >
          {ITEMS.map((item) => (
            <Popover.Close asChild key={item.kind}>
              <button
                type="button"
                onClick={() => onExport(item.kind)}
                className="flex h-[26px] w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left text-[11px] text-[var(--text-secondary)] outline-none transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
              >
                <item.icon size={12} className="shrink-0 text-[var(--text-tertiary)]" />
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
                <span className="shrink-0 text-[10px] text-[var(--text-ghost)]">{item.hint}</span>
              </button>
            </Popover.Close>
          ))}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
