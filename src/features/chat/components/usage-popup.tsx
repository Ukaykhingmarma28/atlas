import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { fmtCost, fmtTokens } from "@/features/monitor/lib/usage-format";
import type { MetricRow, RateLimitWindow, SessionUsageView } from "../lib/session-usage";
import { TickMeter } from "./usage-meter";

/**
 * The Usage popup's content — the analytics-card reading of one session.
 *
 * Nested rounded cards inside the dropup: a big headline number with a
 * caption and a status pill over a tick meter, then token rows with inline
 * bars, cost, quota bars and a session grid. Sections are conditional on the
 * view: what is not known is not drawn, so a Codex session (context only) is
 * one card, a Claude session after a turn is the full stack. Nothing here
 * names the agent or the model — the pills beside the composer already do.
 *
 * Rendered only while the panel is open. The stagger is a one-shot CSS
 * animation (`atlas-usage-in`) that replays on each open because the
 * sections mount fresh; the count-up and the bars settle inside 220 ms.
 */

const prefersReducedMotion = () =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Eases a number to `target` over `ms`, rAF-driven. Snaps under reduced motion. */
function useCountUp(target: number, ms = 220): number {
  const [value, setValue] = useState(() => (prefersReducedMotion() ? target : 0));
  const from = useRef(value);
  useEffect(() => {
    if (prefersReducedMotion()) {
      setValue(target);
      return;
    }
    const start = performance.now();
    const begin = from.current;
    let raf = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / ms);
      const eased = 1 - (1 - t) * (1 - t) * (1 - t);
      const v = begin + (target - begin) * eased;
      setValue(v);
      from.current = v;
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return value;
}

/** True after mount — bars transition from 0 on first paint. */
function useMounted(): boolean {
  const [mounted, setMounted] = useState(prefersReducedMotion());
  useEffect(() => {
    const raf = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(raf);
  }, []);
  return mounted;
}

const CAPTION = "text-[10px] font-medium uppercase tracking-wider text-[var(--text-tertiary)]";
const VALUE = "text-[11px] tabular-nums text-[var(--text-primary)]";

function Card({
  index,
  section,
  children,
}: {
  index: number;
  section: string;
  children: ReactNode;
}) {
  return (
    <section
      data-section={section}
      className="atlas-usage-in rounded-lg border border-white/[0.06] bg-[var(--bg-elevated-2)] px-2.5 py-2"
      style={{ "--i": index } as CSSProperties}
    >
      {children}
    </section>
  );
}

function StatusPill({ status }: { status: "ok" | "warn" | "full" }) {
  const tone =
    status === "full"
      ? "border-[var(--status-error)]/40 text-[var(--status-error)]"
      : status === "warn"
        ? "border-[var(--status-warning)]/40 text-[var(--status-warning)]"
        : "border-white/[0.08] text-[var(--text-secondary)]";
  return (
    <span
      className={cn(
        "inline-flex h-4 items-center rounded-full border px-1.5 text-[9px] font-medium uppercase tracking-wider",
        tone,
      )}
    >
      {status === "full" ? "Full" : status === "warn" ? "Warn" : "OK"}
    </span>
  );
}

function Headline({ view }: { view: SessionUsageView }) {
  const h = view.headline;
  const target = !h ? 0 : h.kind === "context" ? h.pct : h.kind === "tokens" ? h.total : h.usd;
  const value = useCountUp(target);
  if (!h) return null;
  if (h.kind === "context") {
    return (
      <Card index={0} section="context">
        <div className={CAPTION}>
          Context · {fmtTokens(h.used)} / {fmtTokens(h.size)}
        </div>
        <div className="mt-1 flex items-baseline gap-2">
          <span className="text-[28px] leading-none font-semibold tabular-nums text-[var(--text-primary)]">
            {value.toFixed(value >= 10 ? 0 : 1)}
            <span className="ml-0.5 text-[14px] font-medium text-[var(--text-tertiary)]">%</span>
          </span>
          <StatusPill status={h.status} />
        </div>
        <TickMeter value={h.pct} className="mt-2.5" />
        <div className={cn("mt-1 flex justify-between text-[9px]", CAPTION)}>
          <span>0</span>
          <span>{fmtTokens(h.size)}</span>
        </div>
        {view.compacting ? (
          <div className="mt-1.5 flex items-center gap-1.5 text-[10px] text-[var(--accent-primary)]">
            <span className="h-1.5 w-1.5 rounded-full bg-[var(--accent-primary)] animate-pulse" />
            Compacting the context window…
          </div>
        ) : view.savedTokens ? (
          <div className={cn("mt-1.5", CAPTION)}>
            Compression saved {fmtTokens(view.savedTokens)} tokens
          </div>
        ) : null}
      </Card>
    );
  }
  if (h.kind === "tokens") {
    return (
      <Card index={0} section="tokens-total">
        <div className={CAPTION}>Tokens · this session</div>
        <div className="mt-1 text-[28px] leading-none font-semibold tabular-nums text-[var(--text-primary)]">
          {fmtTokens(Math.round(value))}
        </div>
      </Card>
    );
  }
  return (
    <Card index={0} section="cost-total">
      <div className={CAPTION}>Cost · this session{h.estimated ? " · est." : ""}</div>
      <div className="mt-1 text-[28px] leading-none font-semibold tabular-nums text-[var(--text-primary)]">
        {fmtCost(value)}
      </div>
    </Card>
  );
}

function Bar({
  frac,
  mounted,
  color = "var(--text-secondary)",
}: {
  frac: number;
  mounted: boolean;
  color?: string;
}) {
  return (
    <span className="block h-[3px] w-full overflow-hidden rounded-full bg-white/[0.06]">
      <span
        className="block h-full rounded-full"
        style={{
          width: `${mounted ? Math.max(2, frac * 100) : 0}%`,
          background: color,
          transition: "width 220ms cubic-bezier(0.32,0.72,0,1)",
        }}
      />
    </span>
  );
}

function TokenRows({ rows, index }: { rows: MetricRow[]; index: number }) {
  const mounted = useMounted();
  return (
    <Card index={index} section="tokens">
      <div className={cn(CAPTION, "mb-1")}>Tokens</div>
      <div className="flex flex-col">
        {rows.map((r) => (
          <div key={r.key} className="flex h-6 items-center gap-2.5">
            <span className="w-[76px] shrink-0 truncate text-[11px] text-[var(--text-secondary)]">
              {r.label}
            </span>
            <span className="min-w-0 flex-1">
              <Bar frac={r.frac} mounted={mounted} />
            </span>
            <span className={cn("w-[48px] shrink-0 text-right", VALUE)}>{fmtTokens(r.value)}</span>
          </div>
        ))}
      </div>
    </Card>
  );
}

function Cost({ cost, index }: { cost: NonNullable<SessionUsageView["cost"]>; index: number }) {
  return (
    <Card index={index} section="cost">
      <div className="flex items-baseline justify-between">
        <span className={CAPTION}>Cost</span>
        <span className="flex items-baseline gap-1.5">
          <span className="text-[15px] leading-none font-semibold tabular-nums text-[var(--text-primary)]">
            {fmtCost(cost.total)}
          </span>
          {cost.estimated ? (
            <span className="rounded-full border border-white/[0.08] px-1 text-[8px] font-medium uppercase tracking-wider text-[var(--text-tertiary)]">
              est.
            </span>
          ) : null}
        </span>
      </div>
      {cost.rows.length ? (
        <div className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-0.5">
          {cost.rows.map((r) => (
            <div key={r.key} className="flex items-baseline justify-between">
              <span className="text-[10px] text-[var(--text-tertiary)]">{r.label}</span>
              <span className="text-[10px] tabular-nums text-[var(--text-secondary)]">
                {fmtCost(r.cost ?? 0)}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </Card>
  );
}

function resetsIn(w: RateLimitWindow, now: number): string | null {
  if (!w.resetsAt) return null;
  const s = Math.max(0, w.resetsAt - Math.floor(now / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `resets in ${h}h ${m}m` : `resets in ${m}m`;
}

function windowLabel(w: RateLimitWindow, fallback: string): string {
  if (!w.windowMinutes) return fallback;
  return w.windowMinutes >= 1440
    ? `${Math.round(w.windowMinutes / 1440)}-day limit`
    : `${Math.round(w.windowMinutes / 60)}-hour limit`;
}

function QuotaRow({
  label,
  window: w,
  now,
  mounted,
}: {
  label: string;
  window: RateLimitWindow;
  now: number;
  mounted: boolean;
}) {
  const pct = Math.max(0, Math.min(100, w.usedPercent));
  const when = resetsIn(w, now);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between">
        <span className="text-[11px] text-[var(--text-secondary)]">{label}</span>
        <span className={VALUE}>
          {Math.round(pct)}%
          {when ? (
            <span className="ml-1.5 text-[10px] text-[var(--text-tertiary)]">{when}</span>
          ) : null}
        </span>
      </div>
      <Bar
        frac={pct / 100}
        mounted={mounted}
        color={
          pct >= 90
            ? "var(--status-error)"
            : pct >= 70
              ? "var(--status-warning)"
              : "var(--capture-live)"
        }
      />
    </div>
  );
}

function Quota({ quota, index }: { quota: NonNullable<SessionUsageView["quota"]>; index: number }) {
  const mounted = useMounted();
  // A clock for the countdowns, ticking while this card is up.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <Card index={index} section="quota">
      <div className={cn(CAPTION, "mb-1.5 flex justify-between")}>
        <span>Quota</span>
        {quota.plan ? <span>{quota.plan}</span> : null}
      </div>
      <div className="flex flex-col gap-2">
        {quota.primary ? (
          <QuotaRow
            label={windowLabel(quota.primary, "Current window")}
            window={quota.primary}
            now={now}
            mounted={mounted}
          />
        ) : null}
        {quota.secondary ? (
          <QuotaRow
            label={windowLabel(quota.secondary, "Longer window")}
            window={quota.secondary}
            now={now}
            mounted={mounted}
          />
        ) : null}
      </div>
    </Card>
  );
}

function fmtActive(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function Session({
  session,
  index,
}: {
  session: NonNullable<SessionUsageView["session"]>;
  index: number;
}) {
  const cells: Array<[string, ReactNode]> = [];
  if (session.turns !== null) cells.push(["Turns", session.turns]);
  if (session.messages !== null) cells.push(["Messages", session.messages]);
  if (session.toolCalls !== null) cells.push(["Tool calls", session.toolCalls]);
  if (session.filesTouched !== null) cells.push(["Files touched", session.filesTouched]);
  if (session.insertions !== null || session.deletions !== null) {
    cells.push([
      "Lines",
      <span key="lines">
        <span className="text-[var(--capture-live)]">+{session.insertions ?? 0}</span>
        <span className="mx-0.5 text-[var(--text-tertiary)]">/</span>
        <span className="text-[var(--status-error)]">−{session.deletions ?? 0}</span>
      </span>,
    ]);
  }
  if (session.activeSeconds !== null) cells.push(["Active", fmtActive(session.activeSeconds)]);
  if (session.checkpoints !== null) cells.push(["Checkpoints", session.checkpoints]);
  if (!cells.length) return null;
  return (
    <Card index={index} section="session">
      <div className={cn(CAPTION, "mb-1")}>Session</div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1">
        {cells.map(([label, value]) => (
          <div key={label} className="flex items-baseline justify-between gap-2">
            <span className="text-[10px] text-[var(--text-tertiary)]">{label}</span>
            <span className={VALUE}>{value}</span>
          </div>
        ))}
      </div>
    </Card>
  );
}

export function UsagePopup({ view }: { view: SessionUsageView }) {
  let index = 0;
  const next = () => ++index;
  const empty = !view.headline && !view.tokens && !view.cost && !view.quota && !view.session;

  return (
    <div className="flex flex-col gap-1.5 p-1.5">
      {empty ? (
        <Card index={0} section="empty">
          <div className="text-[11px] font-medium text-[var(--text-primary)]">Nothing yet</div>
          <p className="mt-0.5 text-[10px] leading-snug text-[var(--text-tertiary)]">
            Usage shows up after the first turn — what this agent reports, and what Atlas records.
          </p>
        </Card>
      ) : (
        <>
          <Headline view={view} />
          {view.tokens ? <TokenRows rows={view.tokens} index={next()} /> : null}
          {view.cost ? <Cost cost={view.cost} index={next()} /> : null}
          {view.quota ? <Quota quota={view.quota} index={next()} /> : null}
          {view.session ? <Session session={view.session} index={next()} /> : null}
        </>
      )}
    </div>
  );
}
