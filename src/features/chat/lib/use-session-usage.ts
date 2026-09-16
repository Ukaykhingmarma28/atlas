import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useChatStore } from "../stores/chat-store";
import {
  useModelPricingStore,
  priceForModel,
} from "@/features/settings/stores/model-pricing-store";
import { isBusyAgentStatus } from "@/types/agent";
import type { SessionSummary } from "@/features/artifacts/types";
import { deriveSessionUsage, type RateLimits, type SessionUsageView } from "./session-usage";
import type { ChatSession } from "@/types/agent";
import type { RateLimitWindow } from "@/types/agents";

/**
 * Gathers one tab's usage inputs and derives the view.
 *
 * Every chat-store read is a PRIMITIVE selector. The store is written dozens
 * of times a second while an agent streams, and a selector returning a fresh
 * object would re-render the pill on each one; a number, a string or a
 * boolean only re-renders when it actually changes. The transcript is read as
 * a `${messages}:${assistantTurns}` signature for the same reason.
 *
 * The persisted record (`capture_session_summary`) is fetched only while the
 * popup is open — the pill's label needs nothing from it — and re-fetched
 * shortly after a turn ends, because capture writes its usage row as an async
 * job and the turn-end delta arrives first.
 */

/** How long after a turn ends before the record is asked again. */
const REFETCH_AFTER_TURN_MS = 800;

const assistantTurns = (messages: ReadonlyArray<{ role: string }>): number =>
  messages.reduce((n, m) => (m.role === "assistant" ? n + 1 : n), 0);

export function useSessionUsage(tabId: string, open: boolean): SessionUsageView {
  const agentType = useChatStore((s) => s.sessions[tabId]?.agentType ?? "claude-code");
  const model = useChatStore((s) => s.sessions[tabId]?.model ?? null);
  const status = useChatStore((s) => s.sessions[tabId]?.status ?? "idle");
  const acpSessionId = useChatStore((s) => s.sessions[tabId]?.acpSessionId ?? null);
  const projectPath = useChatStore((s) => s.sessions[tabId]?.workingDirectory ?? "");

  const contextUsed = useChatStore((s) => s.sessions[tabId]?.contextUsage?.used ?? null);
  const contextSize = useChatStore((s) => s.sessions[tabId]?.contextUsage?.size ?? null);
  const contextCost = useChatStore((s) => s.sessions[tabId]?.contextUsage?.cost ?? 0);
  const input = useChatStore((s) => s.sessions[tabId]?.usage?.input_tokens ?? null);
  const output = useChatStore((s) => s.sessions[tabId]?.usage?.output_tokens ?? null);
  const cacheRead = useChatStore((s) => s.sessions[tabId]?.usage?.cache_read_tokens ?? null);
  const cacheWrite = useChatStore((s) => s.sessions[tabId]?.usage?.cache_creation_tokens ?? null);
  const reasoning = useChatStore((s) => s.sessions[tabId]?.usage?.reasoning_tokens ?? null);
  const usageCost = useChatStore((s) => s.sessions[tabId]?.usage?.cost ?? 0);
  const compacting = useChatStore((s) => s.sessions[tabId]?.compacting ?? false);
  const pendingSavedTokens = useChatStore((s) => s.sessions[tabId]?.pendingSavedTokens ?? null);
  // A signature, not the object: the engine re-announces the same snapshot
  // every turn and the projector already dedupes, but the store field is
  // still replaced — the string only changes when a number does.
  const rateSig = useChatStore((s) => {
    const r = s.sessions[tabId]?.rateLimits;
    return r ? JSON.stringify(r) : "";
  });
  const transcriptSig = useChatStore((s) => {
    const m = s.sessions[tabId]?.messages;
    return m ? `${m.length}:${assistantTurns(m)}` : "0:0";
  });

  const prices = useModelPricingStore.use.prices();
  const price = useMemo(() => priceForModel(prices, model), [prices, model]);

  // ── The persisted record, while the popup is open ─────────────────────
  const [summary, setSummary] = useState<SessionSummary | null>(null);
  const busy = isBusyAgentStatus(status);
  const wasBusy = useRef(busy);
  const [turnEnds, setTurnEnds] = useState(0);
  useEffect(() => {
    if (wasBusy.current && !busy) {
      const t = setTimeout(() => setTurnEnds((n) => n + 1), REFETCH_AFTER_TURN_MS);
      wasBusy.current = busy;
      return () => clearTimeout(t);
    }
    wasBusy.current = busy;
  }, [busy]);

  useEffect(() => {
    if (!open || !acpSessionId || !projectPath) return;
    let cancelled = false;
    void invoke<SessionSummary | null>("capture_session_summary", {
      projectPath,
      sessionId: acpSessionId,
    })
      .then((s) => {
        if (!cancelled) setSummary(s);
      })
      .catch(() => {
        // Capture off, or a store that cannot be opened: the section stays out.
      });
    return () => {
      cancelled = true;
    };
  }, [open, acpSessionId, projectPath, turnEnds]);

  // A different session in the same tab must not wear the old record.
  useEffect(() => {
    setSummary(null);
  }, [acpSessionId]);

  const rateLimits = useMemo<RateLimits | null>(() => {
    if (!rateSig) return null;
    const r = JSON.parse(rateSig) as NonNullable<ChatSession["rateLimits"]>;
    const window = (w: RateLimitWindow | null) =>
      w
        ? { usedPercent: w.used_percent, windowMinutes: w.window_minutes, resetsAt: w.resets_at }
        : null;
    return { primary: window(r.primary), secondary: window(r.secondary), planType: r.planType };
  }, [rateSig]);

  const [messages, turns] = useMemo(() => {
    const [m, t] = transcriptSig.split(":");
    return [Number(m) || 0, Number(t) || 0];
  }, [transcriptSig]);

  return useMemo(
    () =>
      deriveSessionUsage({
        agentType,
        model,
        contextUsed,
        contextSize,
        input,
        output,
        cacheRead,
        cacheWrite,
        reasoning,
        agentCost: usageCost > 0 ? usageCost : contextCost > 0 ? contextCost : null,
        compacting,
        pendingSavedTokens,
        rateLimits,
        turns,
        messages,
        price,
        summary,
      }),
    [
      agentType,
      model,
      contextUsed,
      contextSize,
      input,
      output,
      cacheRead,
      cacheWrite,
      reasoning,
      usageCost,
      contextCost,
      compacting,
      pendingSavedTokens,
      rateLimits,
      turns,
      messages,
      price,
      summary,
    ],
  );
}
