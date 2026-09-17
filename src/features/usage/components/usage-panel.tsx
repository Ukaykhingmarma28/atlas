import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { Card } from "@/components/usage-primitives";
import { useOrgStore } from "@/features/organisations/stores/org-store";
import { useWorkspaceStore } from "@/features/workspaces/stores/workspace-store";
import { useUsageStore } from "../stores/usage-store";
import { useUsageView } from "../lib/use-usage-view";
import { copyMarkdownReport, exportJpeg, exportMarkdown, exportPdf } from "../lib/export";
import { fmtDay, resolveRange } from "../lib/date-range";
import { rankBy } from "../lib/derive";
import { ClassTrackers } from "./class-trackers";
import { DailyGlyphChart } from "./daily-glyph-chart";
import { EfficiencyCard } from "./efficiency-card";
import { FilterBar } from "./filter-bar";
import { InsightsCard } from "./insights-card";
import { StatStrip } from "./stat-strip";
import { TopList } from "./top-list";
import { UsageHeader, type ExportKind } from "./usage-header";
import { UsageTables } from "./usage-tables";

/**
 * The Usage tab: the organisation's token usage, filtered client-side over one payload.
 *
 * Order, top to bottom: the headline band, the token classes, the daily series, insight +
 * top-N side by side, the efficiency report, then the tables. Everything above the tables is
 * the export capture region. Sections follow the composer Usage pill's grammar — nested
 * cards, count-ups, tick meters — and share its primitives.
 */
export function UsagePanel() {
  const view = useUsageView();
  const {
    refresh,
    setRange,
    toggleFacet,
    clearFacets,
    setGroupBy,
    setMetric,
    setTable,
    setSearch,
  } = useUsageStore.use.actions();
  const orgName = useOrgStore((s) => {
    const id = s.activeOrganisationId;
    return s.organisations.find((o) => o.id === id)?.name ?? null;
  });
  // Re-fetch when the org's workspace set changes (this also covers an org switch).
  const wsSig = useWorkspaceStore((s) => s.workspaces.map((w) => w.path).join("|"));
  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsSig]);

  const captureRef = useRef<HTMLDivElement>(null);
  const onExport = async (kind: ExportKind) => {
    if (!view.data) return;
    try {
      if (kind === "copy-markdown") {
        if (!(await copyMarkdownReport(view))) throw new Error("clipboard write failed");
        toast.success("Copied Markdown report");
        return;
      }
      if (kind === "markdown") await exportMarkdown(view);
      else if (captureRef.current) {
        if (kind === "pdf") await exportPdf(captureRef.current);
        else await exportJpeg(captureRef.current);
      }
      toast.success(`Exported ${kind.toUpperCase()}`);
    } catch (e) {
      toast.error(`Export failed: ${String(e)}`);
    }
  };

  const { data, loading, error, range, facets, groupBy, metric, table, search } = view;
  const earliest = data ? (data.daily[0]?.date ?? null) : null;
  const attribution = attributionLine(data?.ledgerSince ?? null, range);

  return (
    <div className="flex h-full flex-col bg-[var(--bg-base)]">
      <UsageHeader
        orgName={orgName}
        range={range}
        onRange={setRange}
        earliest={earliest}
        onExport={(k) => void onExport(k)}
        onRefresh={() => void refresh({ force: true })}
        loading={loading}
        canExport={!!data}
      />
      {data && (
        <FilterBar
          facets={facets}
          options={view.facetOptions}
          onToggle={toggleFacet}
          onClear={clearFacets}
          groupBy={groupBy}
          onGroupBy={setGroupBy}
          metric={metric}
          onMetric={setMetric}
        />
      )}

      <div className="hide-scrollbar min-h-0 flex-1 overflow-y-auto">
        {!data && loading && (
          <div className="p-6 text-[12px] text-[var(--text-tertiary)]">Reading usage…</div>
        )}
        {error && (
          <div className="p-6 text-[12px] text-[var(--status-error)]">Failed to load: {error}</div>
        )}
        {data && view.all.length === 0 && !loading && (
          <div className="p-4">
            <Card index={0} section="empty">
              <div className="text-[11px] font-medium text-[var(--text-primary)]">Nothing yet</div>
              <div className="mt-0.5 text-[10px] leading-snug text-[var(--text-tertiary)]">
                Usage appears after the first agent turn in one of this organisation's projects.
              </div>
            </Card>
          </div>
        )}
        {data && view.all.length > 0 && (
          <div className="flex flex-col gap-3 p-4">
            <div ref={captureRef} className="flex flex-col gap-3 bg-[var(--bg-base)]">
              <StatStrip
                totals={view.totals}
                prevTotals={view.prevTotals}
                sessionCount={view.sessionCount}
                prevSessionCount={view.prevSessionCount}
                eff={view.eff}
                prevEff={view.prevEff}
              />
              <ClassTrackers totals={view.totals} />
              <DailyGlyphChart
                series={view.chart}
                metric={metric}
                groupBy={groupBy}
                attribution={attribution}
              />
              <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                <InsightsCard insights={view.insightList} />
                <TopList ranked={view.ranked} groupBy={groupBy} metric={metric} />
              </div>
              <EfficiencyCard
                eff={view.eff}
                prevEff={view.prevEff}
                rows={view.rows}
                sessions={view.sessions}
                groupBy={groupBy}
                data={data}
              />
            </div>
            <UsageTables
              tab={table}
              onTab={setTable}
              sessions={view.sessions}
              sessionsTotal={data.sessionsTotal}
              ranked={{
                projects: rankBy(view.rows, "project", "tokens", data),
                agents: rankBy(view.rows, "agent", "tokens", data),
                models: rankBy(view.rows, "model", "tokens", data),
              }}
              data={data}
              search={search}
              onSearch={setSearch}
            />
          </div>
        )}
      </div>
    </div>
  );
}

/** How the chart's days are dated — honest about the pre-ledger window. */
function attributionLine(
  ledgerSince: string | null,
  range: Parameters<typeof resolveRange>[0],
): string {
  if (!ledgerSince) return "dated to each session's last-active day";
  const sinceDay = ledgerSince.slice(0, 10);
  const r = resolveRange(range);
  if (r.from !== null && r.from >= sinceDay) return "dated per turn";
  return `dated per turn since ${fmtDay(sinceDay)}; earlier by last-active day`;
}
