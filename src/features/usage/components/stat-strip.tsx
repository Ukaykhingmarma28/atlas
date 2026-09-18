import { CAPTION, Card, EstTag, useCountUp } from "@/components/usage-primitives";
import { fmtCost, fmtNum, fmtPct, fmtTokens } from "@/features/monitor/lib/usage-format";
import type { Metrics } from "../types";
import { deltaPct, tokensOf, type Efficiency } from "../lib/derive";
import { DeltaChip } from "./delta-chip";

/**
 * The headline band (the reference dashboard's top row): five figures separated by hairlines
 * inside ONE card, each with a caption, a count-up number and its period-over-period chip.
 */
export function StatStrip({
  totals,
  prevTotals,
  sessionCount,
  prevSessionCount,
  eff,
  prevEff,
}: {
  totals: Metrics;
  prevTotals: Metrics | null;
  sessionCount: number;
  prevSessionCount: number | null;
  eff: Efficiency;
  prevEff: Efficiency | null;
}) {
  const cells: Array<{
    key: string;
    caption: React.ReactNode;
    value: number;
    fmt: (n: number) => string;
    delta: number | null;
  }> = [
    {
      key: "tokens",
      caption: "Tokens",
      value: tokensOf(totals),
      fmt: fmtTokens,
      delta: deltaPct(tokensOf(totals), prevTotals ? tokensOf(prevTotals) : null),
    },
    {
      key: "cost",
      caption: (
        <span className="inline-flex items-center gap-1">
          Cost <EstTag />
        </span>
      ),
      value: totals.cost,
      fmt: fmtCost,
      delta: deltaPct(totals.cost, prevTotals?.cost),
    },
    {
      key: "sessions",
      caption: "Sessions",
      value: sessionCount,
      fmt: fmtNum,
      delta: deltaPct(sessionCount, prevSessionCount),
    },
    {
      key: "messages",
      caption: "Messages",
      value: totals.messages,
      fmt: fmtNum,
      delta: deltaPct(totals.messages, prevTotals?.messages),
    },
    {
      key: "cache",
      caption: "Cache hit rate",
      value: (eff.cacheHitRate ?? 0) * 100,
      fmt: (n) => (eff.cacheHitRate === null ? "—" : fmtPct(n / 100)),
      delta:
        eff.cacheHitRate === null
          ? null
          : deltaPct(eff.cacheHitRate, prevEff?.cacheHitRate ?? null),
    },
  ];
  return (
    <Card index={0} section="stats" className="!px-0 !py-0">
      <div className="grid grid-cols-5 divide-x divide-[var(--atlas-element-selected)]">
        {cells.map((c) => (
          <StatCell key={c.key} caption={c.caption} value={c.value} fmt={c.fmt} delta={c.delta} />
        ))}
      </div>
    </Card>
  );
}

function StatCell({
  caption,
  value,
  fmt,
  delta,
}: {
  caption: React.ReactNode;
  value: number;
  fmt: (n: number) => string;
  delta: number | null;
}) {
  const shown = useCountUp(value);
  return (
    <div className="min-w-0 px-3 py-2.5">
      <div className={CAPTION}>{caption}</div>
      <div className="mt-1 flex items-baseline gap-2">
        {/* One step below the insight headline's text-2xl (the scale's top
            step) — a stat cell is five-per-row, the headline is one figure
            alone, and they should not read as the same weight. */}
        <span className="truncate text-xl leading-none font-semibold tabular-nums text-[var(--foreground)]">
          {fmt(shown)}
        </span>
        <DeltaChip delta={delta} />
      </div>
    </div>
  );
}
