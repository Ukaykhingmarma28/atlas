import { Menu as DropdownMenu } from "@base-ui/react/menu";
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
import { Hint } from "@/ui/tooltip";
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
    <div className="flex h-control-lg shrink-0 items-center gap-2 border-b border-[var(--border)] px-3">
      <AtlasIcon size={14} className="rounded" />
      <span className="text-sm font-semibold text-[var(--foreground)]">Usage</span>
      {orgName && (
        <span className="truncate text-xs text-[var(--muted-foreground)]" title={orgName}>
          {orgName}
        </span>
      )}
      <div className="flex-1" />

      <DateRangeControl range={range} onChange={onRange} earliest={earliest} />

      <Hint label="Refresh">
        <button
          type="button"
          onClick={onRefresh}
          className={cn(
            "flex size-control-md items-center justify-center rounded-md text-[var(--muted-foreground)] transition-colors hover:bg-[var(--atlas-element-hover)] hover:text-[var(--secondary-foreground)]",
            loading && "animate-spin",
          )}
        >
          <RefreshCw size={13} />
        </button>
      </Hint>

      <DropdownMenu.Root>
        <DropdownMenu.Trigger
          render={
            <button
              type="button"
              disabled={!canExport}
              className="flex h-control-md items-center gap-1.5 rounded-md border border-[var(--border)] px-2.5 text-xs text-[var(--secondary-foreground)] transition-colors outline-none hover:bg-[var(--atlas-element-hover)] hover:text-[var(--foreground)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Download size={12} /> Export{" "}
              <ChevronDown size={11} className="text-[var(--muted-foreground)]" />
            </button>
          }
        />
        <DropdownMenu.Portal>
          <DropdownMenu.Positioner className="z-popover" align="end" sideOffset={4}>
            <DropdownMenu.Popup className="min-w-[170px] rounded-lg border border-[var(--border)] bg-popover py-1.5 shadow-xl text-sm text-[var(--secondary-foreground)]">
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
            </DropdownMenu.Popup>
          </DropdownMenu.Positioner>
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
      onClick={onSelect}
      className="flex h-control-md cursor-default items-center gap-2.5 px-3 outline-none hover:bg-[var(--atlas-element-hover)] hover:text-[var(--foreground)]"
    >
      <span className="text-[var(--muted-foreground)]">{icon}</span>
      {label}
    </DropdownMenu.Item>
  );
}
