import { useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Check, ChevronDown, Search, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { fmtTokens } from "@/features/monitor/lib/usage-format";
import type { Facets, GroupBy, Metric } from "../types";
import type { FacetOption } from "../lib/derive";
import { Segmented } from "./segmented";

type Axis = keyof Facets;

const AXES: ReadonlyArray<{ axis: Axis; all: string; one: string }> = [
  { axis: "projects", all: "All projects", one: "project" },
  { axis: "agents", all: "All agents", one: "agent" },
  { axis: "models", all: "All models", one: "model" },
];

const GROUPS: ReadonlyArray<{ value: GroupBy; label: string }> = [
  { value: "project", label: "Project" },
  { value: "agent", label: "Agent" },
  { value: "model", label: "Model" },
];
const METRICS: ReadonlyArray<{ value: Metric; label: string }> = [
  { value: "tokens", label: "Tokens" },
  { value: "cost", label: "Cost" },
  { value: "messages", label: "Messages" },
];

/** Options beyond this count get a search field in the menu. */
const SEARCH_ABOVE = 8;

/**
 * The filter row: one multi-select pill per axis (project · agent · model), each a checklist
 * with the tokens behind every option so the heavy hitters are visible before they're picked,
 * plus the group-by and metric controls that shape the chart and the ranked lists.
 *
 * Options are computed over the RANGE-filtered rows, not the facet-filtered ones, so picking
 * one project never makes the other projects vanish from the menu.
 */
export function FilterBar({
  facets,
  options,
  onToggle,
  onClear,
  groupBy,
  onGroupBy,
  metric,
  onMetric,
}: {
  facets: Facets;
  options: Record<Axis, FacetOption[]>;
  onToggle: (axis: Axis, value: string) => void;
  onClear: () => void;
  groupBy: GroupBy;
  onGroupBy: (g: GroupBy) => void;
  metric: Metric;
  onMetric: (m: Metric) => void;
}) {
  const active = AXES.reduce((n, a) => n + facets[a.axis].length, 0);
  return (
    <div className="flex h-[36px] shrink-0 items-center gap-1.5 border-b border-[var(--border-subtle)] px-3">
      {AXES.map((a) => (
        <FacetPill
          key={a.axis}
          axis={a.axis}
          allLabel={a.all}
          oneLabel={a.one}
          selected={facets[a.axis]}
          options={options[a.axis]}
          onToggle={onToggle}
        />
      ))}
      {active > 0 && (
        <button
          type="button"
          onClick={onClear}
          className="flex h-6 items-center gap-1 rounded-full px-2 text-[10px] text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
        >
          <X size={10} /> Clear
        </button>
      )}
      <div className="flex-1" />
      <span className="text-[10px] uppercase tracking-wider text-[var(--text-tertiary)]">
        Group
      </span>
      <Segmented label="Group by" value={groupBy} options={GROUPS} onChange={onGroupBy} />
      <span className="ml-1 text-[10px] uppercase tracking-wider text-[var(--text-tertiary)]">
        Metric
      </span>
      <Segmented label="Metric" value={metric} options={METRICS} onChange={onMetric} />
    </div>
  );
}

function FacetPill({
  axis,
  allLabel,
  oneLabel,
  selected,
  options,
  onToggle,
}: {
  axis: Axis;
  allLabel: string;
  oneLabel: string;
  selected: string[];
  options: FacetOption[];
  onToggle: (axis: Axis, value: string) => void;
}) {
  const [query, setQuery] = useState("");
  const sel = new Set(selected);
  const label =
    selected.length === 0
      ? allLabel
      : selected.length === 1
        ? (options.find((o) => o.value === selected[0])?.label ?? selected[0])
        : `${selected.length} ${oneLabel}s`;
  const q = query.trim().toLowerCase();
  const shown = q ? options.filter((o) => o.label.toLowerCase().includes(q)) : options;
  const on = selected.length > 0;

  return (
    <DropdownMenu.Root onOpenChange={(open) => !open && setQuery("")}>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          disabled={options.length === 0}
          className={cn(
            "flex h-6.5 items-center rounded-full border px-2 text-[10px] font-medium leading-none transition-colors outline-none disabled:opacity-40",
            on
              ? "border-[var(--border-strong)] bg-[var(--bg-selected)] text-[var(--text-primary)]"
              : "border-[var(--border-default)] bg-[var(--bg-elevated)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]",
          )}
        >
          <span className="max-w-[160px] truncate">{label}</span>
          {selected.length > 1 && (
            <span className="ml-1 rounded-full bg-white/[0.08] px-1 text-[9px] tabular-nums">
              {selected.length}
            </span>
          )}
          <ChevronDown size={10} className="ml-1 shrink-0 text-[var(--text-tertiary)]" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          sideOffset={4}
          className="z-[var(--z-max)] w-[260px] rounded-lg border border-[var(--border-default)] bg-[var(--bg-elevated)] py-1 text-[11px] text-[var(--text-secondary)] shadow-[var(--shadow-overlay)]"
          onCloseAutoFocus={(e) => e.preventDefault()}
        >
          {options.length > SEARCH_ABOVE && (
            <div className="mx-1.5 mb-1 flex h-[26px] items-center gap-1.5 rounded-md border border-[var(--border-default)] bg-[var(--bg-base)] px-2">
              <Search size={11} className="shrink-0 text-[var(--text-tertiary)]" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.stopPropagation()}
                placeholder={`Filter ${oneLabel}s`}
                className="w-full bg-transparent text-[11px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-tertiary)]"
              />
            </div>
          )}
          <div className="max-h-[280px] overflow-y-auto hide-scrollbar">
            {shown.length === 0 && (
              <div className="px-3 py-2 text-[10px] text-[var(--text-tertiary)]">No matches</div>
            )}
            {shown.map((o) => (
              <DropdownMenu.CheckboxItem
                key={o.value}
                checked={sel.has(o.value)}
                onCheckedChange={() => onToggle(axis, o.value)}
                onSelect={(e) => e.preventDefault()}
                className="flex h-[26px] cursor-default items-center gap-2 px-3 outline-none hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] data-[state=checked]:text-[var(--text-primary)]"
              >
                <span className="flex size-3.5 shrink-0 items-center justify-center rounded-[3px] border border-white/[0.12]">
                  <DropdownMenu.ItemIndicator>
                    <Check size={10} />
                  </DropdownMenu.ItemIndicator>
                </span>
                <span className="min-w-0 flex-1 truncate">{o.label}</span>
                <span className="shrink-0 text-[10px] tabular-nums text-[var(--text-tertiary)]">
                  {fmtTokens(o.tokens)}
                </span>
              </DropdownMenu.CheckboxItem>
            ))}
          </div>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
