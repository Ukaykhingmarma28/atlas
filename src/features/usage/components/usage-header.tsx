import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  ChevronDown,
  Copy,
  Download,
  FileText,
  FileType2,
  Image as ImageIcon,
  RefreshCw,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { AtlasIcon } from "@/components/atlas-icon";
import type { DateRange } from "../types";
import { DateRangeControl } from "./date-range-control";

export type ExportKind = "pdf" | "jpeg" | "markdown" | "copy-markdown";

export function UsageHeader({
  orgName,
  range,
  onRange,
  earliest,
  onExport,
  onRefresh,
  loading,
  canExport,
}: {
  orgName: string | null;
  range: DateRange;
  onRange: (r: DateRange) => void;
  earliest: string | null;
  onExport: (kind: ExportKind) => void;
  onRefresh: () => void;
  loading: boolean;
  canExport: boolean;
}) {
  return (
    <div className="flex h-[32px] shrink-0 items-center gap-2 border-b border-[var(--border-default)] px-3">
      <AtlasIcon size={14} className="rounded-[3px]" />
      <span className="text-[12px] font-semibold text-[var(--text-primary)]">Usage</span>
      {orgName && (
        <span className="truncate text-[11px] text-[var(--text-tertiary)]" title={orgName}>
          {orgName}
        </span>
      )}
      <div className="flex-1" />

      <DateRangeControl range={range} onChange={onRange} earliest={earliest} />

      <button
        type="button"
        onClick={onRefresh}
        className={cn(
          "flex h-[26px] w-[26px] items-center justify-center rounded-md text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-secondary)]",
          loading && "animate-spin",
        )}
        title="Refresh"
        aria-label="Refresh"
      >
        <RefreshCw size={13} />
      </button>

      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            disabled={!canExport}
            className="flex h-[26px] items-center gap-1.5 rounded-md border border-[var(--border-default)] px-2.5 text-[11px] text-[var(--text-secondary)] transition-colors outline-none hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] disabled:opacity-40"
          >
            <Download size={12} /> Export{" "}
            <ChevronDown size={11} className="text-[var(--text-tertiary)]" />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="end"
            sideOffset={4}
            className="z-[var(--z-max)] min-w-[170px] rounded-lg border border-[var(--border-default)] bg-[var(--bg-elevated)] py-1.5 text-[12px] text-[var(--text-secondary)] shadow-[var(--shadow-overlay)]"
          >
            <Item
              icon={<FileType2 size={13} />}
              label="PDF report"
              onSelect={() => onExport("pdf")}
            />
            <Item
              icon={<ImageIcon size={13} />}
              label="JPEG image"
              onSelect={() => onExport("jpeg")}
            />
            <Item
              icon={<FileText size={13} />}
              label="Markdown report"
              onSelect={() => onExport("markdown")}
            />
            <Item
              icon={<Copy size={13} />}
              label="Copy as Markdown"
              onSelect={() => onExport("copy-markdown")}
            />
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
  );
}

function Item({
  icon,
  label,
  onSelect,
}: {
  icon: React.ReactNode;
  label: string;
  onSelect: () => void;
}) {
  return (
    <DropdownMenu.Item
      onSelect={onSelect}
      className="flex h-[28px] cursor-default items-center gap-2.5 px-3 outline-none hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
    >
      <span className="text-[var(--text-tertiary)]">{icon}</span>
      {label}
    </DropdownMenu.Item>
  );
}
