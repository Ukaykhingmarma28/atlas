/**
 * What happens to open chat tabs when their agent is uninstalled.
 *
 * Removing an agent in Settings → Agents drops its connection on the backend
 * and re-hydrates the catalog, so the marketplace and the picker update at
 * once — but nothing told the TAB. Deltas route by session id and the drop
 * produces none, so a tab bound to the removed agent kept its "Claude Code"
 * pill, its picker had no current agent, and the next send failed with
 * "not installed" — the UI read as stale until the user switched agents by
 * hand. This is the missing edge: the catalog shrinking is the signal.
 */

import { NATIVE_AGENT_ID, pluginIdForAgent } from "@/types/agent";
import type { AgentCatalogEntry } from "@/types/agent-catalog";
import { agentMeta } from "@/features/agents/lib/agent-meta";
import { useAgentRegistryStore } from "@/features/agents/stores/agent-registry-store";
import { useChatStore } from "../stores/chat-store";
import { switchAgentForTab } from "./switch-agent";

/** External agents installed in `before` that `after` no longer lists as
 *  installed. Pure. An empty `before` is pre-hydration, not a mass uninstall,
 *  so it never reports anything. */
export function uninstalledBetween(
  before: AgentCatalogEntry[],
  after: AgentCatalogEntry[],
): string[] {
  if (before.length === 0) return [];
  const still = new Set(after.filter((e) => e.installed).map((e) => e.id));
  return before
    .filter((e) => e.installed && e.kind !== "native" && !still.has(e.id))
    .map((e) => e.id);
}

/** Settle every tab on a removed agent: an untouched tab (no session, no
 *  messages, nothing held) falls back to the native agent silently; a tab
 *  with a conversation keeps it and shows the disconnected banner, which
 *  offers a switch or a reinstall. */
export function reconcileRemovedAgent(pluginId: string, label: string): void {
  const { sessions, actions } = useChatStore.getState();
  for (const [tabId, session] of Object.entries(sessions)) {
    if (pluginIdForAgent(session.agentType) !== pluginId) continue;
    const untouched =
      !session.acpSessionId && session.messages.length === 0 && !session.pendingSend;
    if (untouched) switchAgentForTab(tabId, NATIVE_AGENT_ID);
  }
  actions.noteAgentRemoved(pluginId, `${label} was removed`);
}

/** Watch the catalog for uninstalls and reconcile the tabs. Returns the
 *  unsubscribe. */
export function watchRemovedAgents(): () => void {
  return useAgentRegistryStore.subscribe((state, prev) => {
    if (state.catalog === prev.catalog) return;
    for (const id of uninstalledBetween(prev.catalog, state.catalog)) {
      reconcileRemovedAgent(id, agentMeta(id).label);
    }
  });
}
