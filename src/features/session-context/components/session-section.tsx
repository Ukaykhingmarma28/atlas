// Atlas-only rows: who is answering, what it has cost, and whether the
// session is being recorded. They sit here because this overlay is the one
// place a session's context is gathered.
//
// Usage and Capture drill in: each replaces the rows with the surface Atlas
// already has for it (`UsagePopup`, `CapturePopover`), rather than a second,
// smaller copy of either.

import { ChevronRight, Gauge, Radar } from "lucide-react";

import { AgentGlyph } from "@/components/agent-mark";
import { agentMeta } from "@/features/agents/lib/agent-meta";
import { CaptureDot } from "@/features/capture/components/capture-status";
import { UsageRing } from "@/features/chat/components/usage-meter";
import { resolveModelLabel } from "@/features/chat/lib/model-label";
import { useSessionUsage } from "@/features/chat/lib/use-session-usage";
import { useChatStore } from "@/features/chat/stores/chat-store";

import type { CaptureState } from "../lib/use-capture-state";
import { useSessionContextStore } from "../stores/session-context-store";
import { ContextRow, ContextSection, RowIcon, RowLabel, RowMeta } from "./context-rows";

export function SessionSection({
  tabId,
  capture,
  projectPath,
}: {
  tabId: string | null;
  capture: CaptureState;
  projectPath: string | null;
}) {
  const isChat = useChatStore((s) => (tabId ? !!s.sessions[tabId] : false));
  if (!isChat && !projectPath) return null;
  return (
    <ContextSection title="Session" showHeading={false}>
      {isChat && tabId && <AgentRow tabId={tabId} />}
      {isChat && tabId && <UsageRow tabId={tabId} />}
      {projectPath && <CaptureRow capture={capture} />}
    </ContextSection>
  );
}

function AgentRow({ tabId }: { tabId: string }) {
  const agentType = useChatStore((s) => s.sessions[tabId]?.agentType);
  const modelId = useChatStore(
    (s) => s.sessions[tabId]?.acpCurrentModel ?? s.sessions[tabId]?.model ?? undefined,
  );
  const available = useChatStore((s) => s.sessions[tabId]?.acpAvailableModels);
  if (!agentType) return null;
  const model = resolveModelLabel(modelId || undefined, agentType, available);
  return (
    <ContextRow title={model ? `${agentMeta(agentType).label} · ${model}` : undefined}>
      <span className="flex size-3.5 shrink-0 items-center justify-center" aria-hidden>
        <AgentGlyph agentType={agentType} />
      </span>
      <RowLabel>{agentMeta(agentType).label}</RowLabel>
      {model && <RowMeta>{model}</RowMeta>}
    </ContextRow>
  );
}

function UsageRow({ tabId }: { tabId: string }) {
  const { pill } = useSessionUsage(tabId, false);
  const show = useSessionContextStore.use.actions().show;
  return (
    <ContextRow onClick={() => show("usage")} title="Context, tokens, cost and what Atlas recorded">
      <span className="flex size-3.5 shrink-0 items-center justify-center text-muted-foreground">
        {pill.ringFrac !== null ? <UsageRing frac={pill.ringFrac} /> : <Gauge size={14} />}
      </span>
      <RowLabel>Usage</RowLabel>
      <RowMeta
        className={
          pill.tint === "error" ? "text-error" : pill.tint === "warn" ? "text-warning" : undefined
        }
      >
        {pill.label}
      </RowMeta>
      <RowIcon icon={ChevronRight} />
    </ContextRow>
  );
}

function CaptureRow({ capture }: { capture: CaptureState }) {
  const show = useSessionContextStore.use.actions().show;
  const { binding, health, tone } = capture;
  const status = !binding
    ? "Off"
    : !binding.enabled
      ? "Paused"
      : health?.state === "stopped" || health?.state === "degraded"
        ? health.summary
        : binding.mode === "cloud"
          ? "Recording · Cloud"
          : "Recording · Local";
  return (
    <ContextRow onClick={() => show("capture")} title={health?.summary ?? "Session capture"}>
      <span className="relative flex size-3.5 shrink-0 items-center justify-center">
        <RowIcon icon={Radar} />
      </span>
      <RowLabel>Capture</RowLabel>
      <span className="flex min-w-0 items-center gap-1">
        {binding?.enabled && <CaptureDot tone={tone} />}
        <RowMeta className="truncate">{status}</RowMeta>
      </span>
      <RowIcon icon={ChevronRight} />
    </ContextRow>
  );
}
