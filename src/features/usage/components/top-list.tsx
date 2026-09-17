import { Bar, CAPTION, Card, VALUE, useMounted } from "@/components/usage-primitives";
import { fmtCost, fmtNum, fmtPct, fmtTokens } from "@/features/monitor/lib/usage-format";
import type { GroupBy, Metric } from "../types";
import type { RankedKey } from "../lib/derive";
import { seriesColor } from "../lib/palette";

const TOP = 5;

/** The reference's "Top 5" card: rank, name, value, share, and a share bar in the series tint. */
export function TopList({
  ranked,
  groupBy,
  metric,
}: {
  ranked: RankedKey[];
  groupBy: GroupBy;
  metric: Metric;
}) {
  const mounted = useMounted();
  const fmt = metric === "cost" ? fmtCost : metric === "tokens" ? fmtTokens : fmtNum;
  const rows = ranked.slice(0, TOP);
  const rest = ranked.slice(TOP).reduce((s, r) => s + r.share, 0);
  return (
    <Card index={4} section="top" className="min-h-[172px]">
      <div className="flex items-baseline justify-between">
        <span className={CAPTION}>
          Top {Math.min(TOP, ranked.length) || ""}{" "}
          {groupBy === "project" ? "projects" : groupBy === "agent" ? "agents" : "models"} ·{" "}
          {metric === "cost" ? "est. cost" : metric}
        </span>
        {rest > 0 && (
          <span className="text-[9px] tabular-nums text-[var(--text-tertiary)]">
            +{fmtPct(rest)} other
          </span>
        )}
      </div>
      <div className="mt-1.5 flex flex-col gap-1.5">
        {rows.length === 0 && (
          <div className="text-[11px] text-[var(--text-tertiary)]">Nothing in this range.</div>
        )}
        {rows.map((r, i) => (
          <div key={r.key} className="flex h-6 items-center gap-2.5">
            <span className="w-3 shrink-0 text-[10px] tabular-nums text-[var(--text-ghost)]">
              {i + 1}
            </span>
            <span
              className="w-[120px] shrink-0 truncate text-[11px] text-[var(--text-secondary)]"
              title={r.label}
            >
              {r.label}
            </span>
            <span className="min-w-0 flex-1">
              <Bar
                frac={rows[0] && rows[0].value > 0 ? r.value / rows[0].value : 0}
                mounted={mounted}
                color={seriesColor(i)}
              />
            </span>
            <span className={`w-[56px] shrink-0 text-right ${VALUE}`}>{fmt(r.value)}</span>
            <span className="w-[34px] shrink-0 text-right text-[10px] tabular-nums text-[var(--text-tertiary)]">
              {fmtPct(r.share)}
            </span>
          </div>
        ))}
      </div>
    </Card>
  );
}
