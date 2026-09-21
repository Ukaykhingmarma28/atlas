// Shared Cross-Agent Memory — Memory-panel header controls.
//
// Two affordances, kept to the monochrome/hairline house style (see Atlas
// Design Principles): a Shared toggle pill (white when on) and a settings
// popover holding the handoff-summarizer mode selector (Raw / Provider /
// Local-disabled) plus the reused ProviderModelSelector when mode === provider.

import { useEffect, useMemo } from "react";
import { Popover } from "@base-ui/react/popover";
import { Share2, SlidersHorizontal, FileText, Server, Cpu, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { Hint } from "@/ui/tooltip";
import { ProviderModelSelector } from "./provider-pickers";
import { useByokStore } from "@/features/settings/stores/byok-store";
import { CHAT_PROVIDERS } from "@/features/settings/lib/providers";
import { useMemorySharingStore } from "../stores/memory-sharing-store";
import type { SummarizerMode } from "../lib/memory-sharing-api";

export function MemorySharingControls({ projectPath }: { projectPath: string | null }) {
  const enabled = useMemorySharingStore.use.enabled();
  const pref = useMemorySharingStore.use.pref();
  const { load, setEnabled, setPref } = useMemorySharingStore.use.actions();

  const byokKeys = useByokStore.use.keys();
  const byokLoaded = useByokStore.use.loaded();
  const loadByok = useByokStore.use.actions().load;

  useEffect(() => {
    if (projectPath) void load(projectPath);
  }, [projectPath, load]);

  useEffect(() => {
    if (!byokLoaded) void loadByok();
  }, [byokLoaded, loadByok]);

  const configured = useMemo(
    () =>
      CHAT_PROVIDERS.filter((p) => !!byokKeys[p.id]).map((p) => ({
        id: p.id,
        name: p.name,
      })),
    [byokKeys],
  );
  const providerReady = configured.length > 0;

  const setMode = (mode: SummarizerMode) => void setPref({ ...pref, mode });

  return (
    <div className="flex items-center gap-1">
      {/* Shared toggle */}
      <button
        type="button"
        onClick={() => void setEnabled(!enabled)}
        title={
          enabled
            ? "Shared memory ON — served to agents as the atlas_memory tools"
            : "Shared memory OFF"
        }
        className={cn(
          "flex items-center gap-1 h-6 px-2 rounded-full border text-2xs font-medium transition-colors cursor-pointer outline-none",
          enabled
            ? "border-[var(--border)] bg-[var(--atlas-element-hover)] text-[var(--foreground)]"
            : "border-[var(--border)] text-[var(--muted-foreground)] hover:text-[var(--secondary-foreground)] hover:bg-[var(--atlas-element-hover)]",
        )}
      >
        <Share2 size={11} />
        Shared
      </button>

      {/* Summarizer settings popover */}
      <Popover.Root>
        <Hint label="Handoff summarizer settings">
          <Popover.Trigger
            render={
              <button
                type="button"
                className="flex items-center justify-center h-6 w-6 rounded-full border border-[var(--border)] text-[var(--secondary-foreground)] hover:bg-[var(--atlas-element-hover)] hover:text-[var(--foreground)] outline-none transition-colors cursor-pointer"
              >
                <SlidersHorizontal size={12} />
              </button>
            }
          />
        </Hint>
        <Popover.Portal>
          <Popover.Positioner className="z-popover" align="end" side="bottom" sideOffset={6}>
            <Popover.Popup className="w-[300px] rounded-md border border-border bg-card p-3 shadow-md">
              <div className="eyebrow mb-2">Recent-session handoff</div>
              <p className="mb-2.5 text-xs leading-snug text-muted-foreground">
                How the previous session's tail is summarized before it is injected into the next
                agent.
              </p>

              <div className="inline-flex items-center gap-0.5 rounded-full border border-border bg-card p-0.5">
                <ModeSeg
                  active={pref.mode === "raw"}
                  label="Raw"
                  icon={FileText}
                  enabled
                  onClick={() => setMode("raw")}
                />
                <ModeSeg
                  active={pref.mode === "provider"}
                  label="Provider"
                  icon={Server}
                  enabled={providerReady}
                  onClick={() => setMode("provider")}
                />
                <ModeSeg
                  active={pref.mode === "local"}
                  label="Local"
                  icon={Cpu}
                  enabled={false}
                  onClick={() => {}}
                />
              </div>

              {pref.mode === "provider" && (
                <div className="mt-3 flex flex-wrap items-center gap-1.5">
                  {providerReady ? (
                    <ProviderModelSelector
                      configured={configured}
                      provider={pref.provider}
                      model={pref.model}
                      onProvider={(provider) => void setPref({ ...pref, provider, model: "" })}
                      onModel={(model) => void setPref({ ...pref, model })}
                    />
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      Add a provider key in Settings to use provider summaries.
                    </p>
                  )}
                </div>
              )}

              {pref.mode === "raw" && (
                <p className="mt-2.5 text-xs text-muted-foreground">
                  Injecting the last turns verbatim — no model call, no latency.
                </p>
              )}
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}

function ModeSeg({
  active,
  label,
  icon: Icon,
  enabled,
  onClick,
}: {
  active: boolean;
  label: string;
  icon: typeof Cpu;
  enabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={!enabled}
      onClick={() => enabled && onClick()}
      title={enabled ? label : `${label} (coming soon)`}
      className={cn(
        "flex items-center gap-1 h-[22px] px-2 rounded-full text-2xs font-medium transition-colors",
        active
          ? "bg-[var(--atlas-element-hover)] text-[var(--foreground)]"
          : "text-[var(--muted-foreground)] hover:text-[var(--secondary-foreground)]",
        !enabled && "opacity-40 cursor-not-allowed",
      )}
    >
      <Icon size={11} />
      {label}
      {active && <Check size={10} className="text-foreground" />}
    </button>
  );
}
