import { Menu as DropdownMenu } from "@base-ui/react/menu";
import {
  Download,
  FileText,
  Image as ImageIcon,
  FileType2,
  RefreshCw,
  ChevronDown,
  Copy,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Hint } from "@/ui/tooltip";
import { AtlasIcon } from "@/components/atlas-icon";
import type { TimeRange } from "../../types";

const RANGES: TimeRange[] = ["7d", "30d", "90d", "all"];

export function DashboardHeader({
  range,
  onRange,
  onExport,
  onRefresh,
  loading,
}: {
  range: TimeRange;
  onRange: (r: TimeRange) => void;
  onExport: (kind: "pdf" | "jpeg" | "markdown" | "copy-markdown") => void;
  onRefresh: () => void;
  loading: boolean;
}) {
  return (
    <div className="flex items-center gap-2 px-3 h-control-lg shrink-0 border-b border-[var(--border)]">
      <AtlasIcon size={14} className="rounded" />
      <span className="text-sm font-semibold text-[var(--text-primary)]">Console</span>
      <div className="flex-1" />

      {/* Time range segmented control */}
      <div className="flex items-center rounded-md border border-[var(--border)] overflow-hidden">
        {RANGES.map((r) => (
          <button
            key={r}
            onClick={() => onRange(r)}
            className={cn(
              "px-2.5 h-control-md text-xs transition-colors",
              r === range
                ? "bg-[var(--bg-active)] text-[var(--text-primary)]"
                : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]",
            )}
          >
            {r === "all" ? "All" : r}
          </button>
        ))}
      </div>

      <Hint label="Refresh">
        <button
          onClick={onRefresh}
          className={cn(
            "flex items-center justify-center size-control-md rounded-md text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-secondary)] transition-colors",
            loading && "animate-spin",
          )}
        >
          <RefreshCw size={13} />
        </button>
      </Hint>

      <DropdownMenu.Root>
        <DropdownMenu.Trigger
          render={
            <button className="flex items-center gap-1.5 h-control-md px-2.5 rounded-md border border-[var(--border)] text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors outline-none">
              <Download size={12} /> Export{" "}
              <ChevronDown size={11} className="text-[var(--text-tertiary)]" />
            </button>
          }
        />
        <DropdownMenu.Portal>
          <DropdownMenu.Positioner className="z-popover" align="end" sideOffset={4}>
            <DropdownMenu.Popup className="min-w-[170px] rounded-lg border border-[var(--border)] bg-popover py-1.5 shadow-xl text-sm text-[var(--text-secondary)]">
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
      className="flex items-center gap-2.5 px-3 h-control-md outline-none hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] cursor-default"
    >
      <span className="text-[var(--text-tertiary)]">{icon}</span>
      {label}
    </DropdownMenu.Item>
  );
}
