import { useChatStore } from "@/features/chat/stores/chat-store";
import { NATIVE_AGENT, isBusyAgentStatus, type SwitchableAgent } from "@/types/agent";
import { switchableAgentIds } from "@/features/agents/lib/agent-meta";
import { openNewAgentChat } from "./open-agent-session";

/**
 * Bind a chat tab to a different coding agent — the single implementation
 * behind every entry point (⌥/ cycle, the composer's agent pill, the "+" menu
 * picker), so they can never drift apart.
 *
 * A session is paired to ONE agent for its lifetime, so switching means a fresh
 * session. Three cases:
 * - empty chat  → flip the agent in place, nothing to lose.
 * - idle chat   → reset in place bound to the new agent (the old conversation
 *                 is already persisted per-turn and stays in history).
 * - BUSY chat   → leave it completely alone and open a fresh tab on the new
 *                 agent. Clearing here would orphan the live turn: its deltas
 *                 would find no tab, Stop would vanish, and it would keep
 *                 running invisibly.
 * - STARTING     → the one busy case that IS switched in place: `running` only
 *                 because a first message is held on a bind that has not landed
 *                 (`pendingSend`, no `acpSessionId`). Nothing is streaming and
 *                 no backend turn exists, so there is nothing to orphan — and a
 *                 stuck start is exactly when the user reaches for ⌥/. The held
 *                 message is carried over: re-recorded as the new session's
 *                 first bubble and re-held, so the new bind dispatches it.
 */
export function switchAgentForTab(tabId: string, next: SwitchableAgent): void {
  const chat = useChatStore.getState();
  const sess = chat.sessions[tabId];
  if ((sess?.agentType ?? NATIVE_AGENT) === next) return;

  const startingOnly = isStartingOnly(sess);
  if (isBusyAgentStatus(sess?.status) && !startingOnly) {
    openNewAgentChat(next);
    return;
  }
  const held = startingOnly ? sess?.pendingSend : undefined;
  if ((sess?.messages.length ?? 0) > 0) {
    chat.actions.clearSession(tabId);
  }
  chat.actions.switchChatAgent(tabId, next);
  if (held) {
    // Same shape as the composer's first-while-starting send: bubble first,
    // title from the text, status running, prompt held on the session.
    const { actions } = useChatStore.getState();
    actions.addMessage(tabId, "user", held.content, held.attachments);
    actions.setSessionTitle(
      tabId,
      held.content.slice(0, 40) + (held.content.length > 40 ? "..." : ""),
    );
    actions.updateSessionStatus(tabId, "running");
    actions.setPendingSend(tabId, held);
  }
  window.dispatchEvent(new CustomEvent("atlas:chat-focus", { detail: { tabId } }));
}

/** "Busy" only in the sense that a first message is waiting on a bind that
 *  has not produced a session yet. Exported for the composer's stall
 *  affordance, which offers the switch in exactly this state. */
export function isStartingOnly(
  sess: { status?: string; pendingSend?: unknown; acpSessionId?: string } | undefined,
): boolean {
  return !!sess && sess.status === "running" && !!sess.pendingSend && !sess.acpSessionId;
}

/** The next agent in the ⌥/ rotation for a tab — first-party agents in their
 *  fixed order, then any installed registry externals. */
function nextAgentForTab(tabId: string): SwitchableAgent {
  const rotation = switchableAgentIds();
  const cur = useChatStore.getState().sessions[tabId]?.agentType;
  const idx = rotation.indexOf(cur ?? NATIVE_AGENT);
  return rotation[(Math.max(idx, 0) + 1) % rotation.length];
}

/** Advance a chat tab to the next agent (⌥/ and the composer's agent pill). */
export function cycleChatAgent(tabId: string): void {
  switchAgentForTab(tabId, nextAgentForTab(tabId));
}
