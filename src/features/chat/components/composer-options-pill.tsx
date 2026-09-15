import { memo, useEffect, useMemo, useState } from "react";
import { Check, ChevronDown, Loader2, SlidersHorizontal } from "lucide-react";

import { cn } from "@/lib/utils";
import { useChatStore } from "../stores/chat-store";
import { parseConfigOptions } from "../lib/acp-config-options";
import { loadCachedAcpConfigOptions } from "../lib/acp-config-options-cache";
import { ComposerDropup, composerPillClass, useComposerDropup } from "./composer-dropup";

/**
 * The agent-options pill — the knobs an agent advertises beyond mode and model
 * (a thinking-level select, a persona picker, a web-search toggle).
 *
 * Lives on the RIGHT of the composer footer, immediately left of the plan pill,
 * as its own right-anchored dropup. It used to sit in `ComposerGroupsMenu` with
 * the agent/mode/model pills, which put it in the middle of the left cluster
 * and made its width changes shove those pills sideways as it loaded.
 *
 * # It is always rendered
 *
 * The old pill was gated on `configOptions.length > 0`, so on a cold start it
 * was simply absent for the three or four seconds an agent takes to spawn,
 * handshake and answer `session/new` — the composer visibly re-flowed when it
 * popped in. There are only three honest things to show, and all three are a
 * pill:
 *
 * - **knobs known** (from cache or live) → "Options", opens the picker
 * - **nothing known yet** → "Options" with a spinner, disabled
 * - **agent advertises none** → "Default", opens a one-line explanation
 *
 * The cache carries the first and third across restarts (see
 * `acp-config-options-cache`), so the spinner is reserved for an agent this
 * install has genuinely never heard from. It is also backstopped: an agent that
 * never answers settles to "Default" rather than spinning forever.
 */

/** How long to wait for a first-ever answer before calling it "Default".
 *
 *  A first boot of a freshly installed agent is slow (npx fetch, node spawn), so
 *  this is deliberately generous — it exists to stop an agent that will NEVER
 *  answer from spinning for the life of the tab, not to race a slow one. A late
 *  answer still lands: this only decides what is shown meanwhile. */
const SETTLE_AFTER_MS = 30_000;

export const ComposerOptionsPill = memo(function ComposerOptionsPill({ tabId }: { tabId: string }) {
  const agentType = useChatStore((s) => s.sessions[tabId]?.agentType ?? "claude-code");
  // `undefined` = no live session has spoken for this tab yet. An explicit `[]`
  // is a live session saying "no knobs", and the cache must not override it.
  const rawConfigOptions = useChatStore((s) => s.sessions[tabId]?.acpConfigOptions);
  const { setAcpConfigOption } = useChatStore.use.actions();

  // Cache read is keyed by agent and re-run when the live value changes, so a
  // tab that switches agents picks up the new agent's remembered knobs at once.
  const cached = useMemo(() => loadCachedAcpConfigOptions(agentType), [agentType]);
  const known = rawConfigOptions ?? cached;
  const configOptions = useMemo(() => parseConfigOptions(known), [known]);

  // Backstop for an agent that never answers. Keyed on the tab+agent so a switch
  // restarts the wait rather than inheriting a already-elapsed one.
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    setSettled(false);
    if (known !== null) return;
    const timer = setTimeout(() => setSettled(true), SETTLE_AFTER_MS);
    return () => clearTimeout(timer);
  }, [tabId, agentType, known]);

  const loading = known === null && !settled;
  // Knobs exist, but every one of them is owned by another pill (mode/model) —
  // `parseConfigOptions` filters those out. There is nothing left to offer, so
  // this reads as "default" exactly like an empty advertisement does.
  const hasOptions = configOptions.length > 0;
  /** The three things the pill can be. Drives the swap animation's key. */
  const state = loading ? "loading" : hasOptions ? "options" : "default";

  // A loading pill has nothing to open yet; the hook closes it if it got there.
  const { open, toggle, close, ref, contentRef, panelHeight } = useComposerDropup("options", {
    disabled: loading,
    measureKey: configOptions.length,
  });

  return (
    <div ref={ref} className="relative">
      {/* Morphing panel — right-anchored dropup, shared with the plan and
          usage pills. */}
      <ComposerDropup open={open} panelHeight={panelHeight} contentRef={contentRef}>
        <>
          {hasOptions ? (
            // Capped: the panel is bottom-anchored and grows upward, so an
            // uncapped knob list (an agent may advertise a select with dozens of
            // choices) clips its TOP — the FIRST knob — off-screen.
            <div className="hide-scrollbar max-h-[300px] overflow-y-auto p-1">
              {configOptions.map((opt) => (
                <div key={opt.id}>
                  {opt.kind === "boolean" ? (
                    <button
                      onClick={() => {
                        void setAcpConfigOption(tabId, opt.id, !opt.value);
                        close();
                      }}
                      className="flex w-full items-start gap-1.5 rounded-md px-2 py-1.5 text-left transition-colors cursor-pointer hover:bg-[var(--bg-hover)]"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1.5 text-[11px] font-medium text-[var(--text-primary)]">
                          {opt.name}
                          {opt.value && (
                            <Check size={11} className="text-[var(--accent-primary)]" />
                          )}
                        </span>
                        {opt.description && (
                          <span className="mt-0.5 block text-[9px] leading-snug text-[var(--text-tertiary)]">
                            {opt.description}
                          </span>
                        )}
                      </span>
                    </button>
                  ) : (
                    <>
                      <div className="px-2 pb-0.5 pt-1.5 text-[9px] font-medium uppercase tracking-wider text-[var(--text-tertiary)]">
                        {opt.name}
                      </div>
                      {opt.choices.map((c) => {
                        const active = c.id === opt.currentValue;
                        return (
                          <button
                            key={c.id}
                            onClick={() => {
                              void setAcpConfigOption(tabId, opt.id, c.id);
                              close();
                            }}
                            className={cn(
                              "flex w-full items-start gap-1.5 rounded-md px-2 py-1.5 text-left transition-colors cursor-pointer",
                              active ? "bg-[var(--bg-selected)]" : "hover:bg-[var(--bg-hover)]",
                            )}
                          >
                            <span className="min-w-0 flex-1">
                              <span className="flex items-center gap-1.5 text-[11px] font-medium text-[var(--text-primary)]">
                                {c.name}
                                {active && (
                                  <Check size={11} className="text-[var(--accent-primary)]" />
                                )}
                              </span>
                              {c.description && (
                                <span className="mt-0.5 block text-[9px] leading-snug text-[var(--text-tertiary)]">
                                  {c.description}
                                </span>
                              )}
                            </span>
                          </button>
                        );
                      })}
                    </>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div className="px-3 py-2.5">
              <div className="text-[11px] font-medium text-[var(--text-primary)]">Default</div>
              <p className="mt-0.5 text-[10px] leading-snug text-[var(--text-tertiary)]">
                Agent loaded with default configuration.
              </p>
            </div>
          )}
        </>
      </ComposerDropup>

      <button
        onClick={toggle}
        disabled={loading}
        aria-busy={loading}
        className={composerPillClass(open, { disabled: loading })}
        title={
          loading
            ? "Loading the options this agent offers…"
            : hasOptions
              ? "Agent options — knobs this agent advertises"
              : "Agent loaded with default configuration"
        }
      >
        {/* Keyed on the state so React remounts it and the one-shot animation
            replays: the pill fades its contents between loading / Options /
            Default instead of snapping. Most visible on an agent switch, where
            the old agent's state is dropped and the new agent's cached knobs
            land in the same frame. */}
        <span key={state} className="atlas-pill-swap flex items-center">
          {loading ? (
            <Loader2 size={11} className="shrink-0 animate-spin text-[var(--text-tertiary)]" />
          ) : (
            <SlidersHorizontal size={11} className="shrink-0 text-[var(--text-tertiary)]" />
          )}
          {/* While loading the label is "Options", not "Default": "Default" is a
              settled answer, and pairing it with a spinner would state a verdict
              we do not have yet. Thanks to the cache this only happens once per
              agent, ever. */}
          <span className="ml-1.5 whitespace-nowrap">
            {hasOptions || loading ? "Options" : "Default"}
          </span>
          {/* Kept in the layout while loading, just invisible: letting it pop in
              would change the pill's width at the same moment as the label and
              nudge the plan pill sideways. */}
          <ChevronDown
            size={10}
            className={cn("ml-0.5 shrink-0 text-[var(--text-tertiary)]", loading && "opacity-0")}
          />
        </span>
      </button>
    </div>
  );
});
