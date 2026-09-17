import { fmtTokens, fmtCost } from "@/features/monitor/lib/usage-format";
import { useChartPalette } from "../../lib/chart-theme";
import type { MissionControlUsage } from "../../types";
import { StatCard } from "./stat-card";

/** The headline metric tiles — lifetime totals across all projects. */
export function StatCards({ data }: { data: MissionControlUsage }) {
  const { agent } = useChartPalette();
  const t = data.totals;
  const totalIn = t.agentInput;
  const totalOut = t.agentOutput;
  const byokSince = data.byokSince ? new Date(data.byokSince).toLocaleDateString() : null;

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2.5">
      <StatCard
        label="Total Tokens"
        value={fmtTokens(t.totalTokens)}
        sub={`${fmtTokens(totalIn)} in · ${fmtTokens(totalOut)} out`}
        accent={agent.agents}
      />
      <StatCard
        label="Total Cost"
        value={fmtCost(t.totalCostUsd)}
        sub="Agents + BYOK"
        accent={agent.output}
      />
      <StatCard
        label="Messages"
        value={fmtTokens(t.agentMessages)}
        sub={`${t.agentSessions} sessions`}
      />
      <StatCard label="Cache Tokens" value={fmtTokens(t.agentCache)} sub="creation + read" />
      <StatCard
        label="BYOK"
        value={fmtTokens(t.byokInput + t.byokOutput)}
        sub={byokSince ? `${t.byokRequests} calls · since ${byokSince}` : `${t.byokRequests} calls`}
        accent={agent.byok}
      />
      <StatCard label="Projects" value={String(data.projects.length)} sub="tracked" />
    </div>
  );
}
