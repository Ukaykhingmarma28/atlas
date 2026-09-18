import { useMemo } from "react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { fmtTokens } from "@/features/monitor/lib/usage-format";
import { useChartPalette } from "../../lib/chart-theme";
import type { MissionControlUsage } from "../../types";
import { ChartCard } from "./chart-card";
import { ChartTooltip } from "./chart-tooltip";

/** Per-project bars of agent token consumption. */
export function UsageBarChart({ data }: { data: MissionControlUsage }) {
  const { axes, agent } = useChartPalette();
  const rows = useMemo(
    () =>
      data.projects
        .map((p) => ({
          name: p.projectName,
          Agents: p.agents.inputTokens + p.agents.outputTokens,
        }))
        .filter((r) => r.Agents > 0)
        .sort((a, b) => b.Agents - a.Agents)
        .slice(0, 12),
    [data.projects],
  );

  return (
    <ChartCard title="By project" subtitle="Tokens by source">
      <div className="h-[240px]">
        {rows.length === 0 ? (
          <div className="h-full flex items-center justify-center text-xs text-[var(--muted-foreground)]">
            No data.
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={rows} margin={{ top: 8, right: 8, left: 4, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={axes.grid} vertical={false} />
              <XAxis
                dataKey="name"
                tick={{ fill: axes.axis, fontSize: axes.tickFont }}
                tickLine={false}
                axisLine={{ stroke: axes.grid }}
                interval={0}
                tickFormatter={(s: string) => (s.length > 10 ? `${s.slice(0, 9)}…` : s)}
              />
              <YAxis
                tick={{ fill: axes.axis, fontSize: axes.tickFont }}
                tickLine={false}
                axisLine={false}
                width={44}
                tickFormatter={(v: number) => fmtTokens(v)}
              />
              <Tooltip content={<ChartTooltip />} cursor={{ fill: axes.cursor }} />
              <Bar
                dataKey="Agents"
                fill={agent.agents}
                radius={[2, 2, 0, 0]}
                isAnimationActive={false}
              />
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>
    </ChartCard>
  );
}
