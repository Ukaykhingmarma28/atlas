import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, Lightbulb } from "lucide-react";
import { CAPTION, Card } from "@/components/usage-primitives";
import { cn } from "@/lib/utils";
import type { Insight } from "../lib/derive";

/**
 * One insight at a time (the reference's "Insight" card): the big figure, then the sentence
 * with its lead phrase emphasised, dots + arrows to walk the list. Rule-based, computed from
 * the window — nothing here asks a model anything.
 */
export function InsightsCard({ insights }: { insights: Insight[] }) {
  const [i, setI] = useState(0);
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    if (i >= insights.length) setI(0);
  }, [insights.length, i]);
  const go = (next: number) => {
    if (insights.length === 0) return;
    setVisible(false);
    window.setTimeout(() => {
      setI((next + insights.length) % insights.length);
      setVisible(true);
    }, 140);
  };
  const cur = insights[i] ?? null;
  return (
    <Card index={3} section="insights" className="flex min-h-[172px] flex-col">
      <div className="flex items-center gap-1.5">
        <Lightbulb size={11} className="text-[var(--text-tertiary)]" />
        <span className={CAPTION}>Insight</span>
      </div>
      <div
        className="flex flex-1 flex-col justify-center py-2"
        style={{ opacity: visible ? 1 : 0, transition: "opacity 140ms ease-out" }}
      >
        {cur ? (
          <>
            <div
              className="truncate text-[28px] leading-none font-semibold tabular-nums text-[var(--text-primary)]"
              title={cur.stat}
            >
              {cur.stat}
            </div>
            <p className="mt-2 text-[12px] leading-snug">
              <span className="text-[var(--text-primary)]">{cur.lead}</span>{" "}
              <span className="text-[var(--text-tertiary)]">{cur.rest}</span>
            </p>
          </>
        ) : (
          <p className="text-[11px] text-[var(--text-tertiary)]">
            Not enough in this window to say anything yet.
          </p>
        )}
      </div>
      {insights.length > 1 && (
        <div className="flex items-center justify-between">
          <button
            type="button"
            aria-label="Previous insight"
            onClick={() => go(i - 1)}
            className="flex size-5 items-center justify-center rounded text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
          >
            <ChevronLeft size={12} />
          </button>
          <div className="flex items-center gap-1">
            {insights.map((ins, k) => (
              <button
                key={ins.id}
                type="button"
                aria-label={`Insight ${k + 1}`}
                onClick={() => go(k)}
                className={cn(
                  "h-[3px] rounded-full transition-all duration-200",
                  k === i
                    ? "w-5 bg-[var(--capture-live)]"
                    : "w-3 bg-white/[0.12] hover:bg-white/[0.25]",
                )}
              />
            ))}
          </div>
          <button
            type="button"
            aria-label="Next insight"
            onClick={() => go(i + 1)}
            className="flex size-5 items-center justify-center rounded text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
          >
            <ChevronRight size={12} />
          </button>
        </div>
      )}
    </Card>
  );
}
