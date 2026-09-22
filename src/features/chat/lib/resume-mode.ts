// Re-applying the user's approval mode when a session is RESUMED.
//
// `session/new` already does this (see the bind effect in `chat-panel.tsx`):
// it reads the explicit pick the store was seeded with, validates it against
// what the agent advertises, and pushes it to the agent before the first turn
// can run. Resume did not, and the gap produced two separate faults:
//
//  1. The engine forces its own default mode on resume, so a user who chose
//     Bypass came back to Ask after a crash with nothing said about it.
//  2. One resume path seeded the mode pill from the stored preference but
//     never told the agent, so the pill could read Bypass while the engine was
//     enforcing Ask. A picker that disagrees with the engine is worse than one
//     that is merely reset, because it is not wrong in a way anyone can see.
//
// Restoring an explicit pick is restoring a stated intention: the preference
// is only ever written when the user picks a mode themselves (see
// `last-mode-pref.ts`), never from a mode an agent adopted on its own.

import type { SessionKey, SessionModeInfo, SessionSnapshot } from "@/types/agents";
import type { ClaudePermissionMode } from "@/types/agent";
import { CLAUDE_PERMISSION_MODES, agentTypeFromPluginId } from "@/types/agent";
import { useChatStore } from "../stores/chat-store";
import { agents } from "./agents-api";

/**
 * The mode a session should actually end up in.
 *
 * `requested` is the user's explicit pick, or undefined when they never made
 * one. A pick the agent does not advertise is dropped in favour of whatever
 * the agent reports, because sending it would be rejected and would leave the
 * picker stuck on a mode id that does not exist. An agent that advertises no
 * modes at all is taken at its word and the pick is kept.
 */
export function resolveEffectiveMode(
  requested: string | undefined,
  currentMode: string | null,
  availableModes: readonly SessionModeInfo[],
): string | null {
  if (!requested) return currentMode;
  const advertised = availableModes.length === 0 || availableModes.some((m) => m.id === requested);
  return advertised ? requested : currentMode;
}

/** The explicit pick this session carries, if any. */
function requestedMode(tabId: string): { isClaude: boolean; requested: string | undefined } {
  const session = useChatStore.getState().sessions[tabId];
  const isClaude = session?.agentType === "claude-code";
  if (!session) return { isClaude, requested: undefined };
  if (isClaude) {
    return {
      isClaude,
      requested: session.claudePermissionModeExplicit ? session.claudePermissionMode : undefined,
    };
  }
  return {
    isClaude,
    requested: session.acpModeExplicit ? (session.acpCurrentMode ?? undefined) : undefined,
  };
}

/**
 * Put a resumed session into the mode the user last explicitly picked, and
 * leave the picker showing what the agent actually has.
 *
 * Call it on every resume path, in place of seeding the picker from the
 * snapshot alone.
 */
export async function applyModeOnResume(
  tabId: string,
  key: SessionKey,
  snapshot: SessionSnapshot,
): Promise<void> {
  const { isClaude, requested } = requestedMode(tabId);
  let effective = resolveEffectiveMode(requested, snapshot.current_mode, snapshot.available_modes);
  let honouredPick = !!requested && effective === requested;

  if (effective && effective !== snapshot.current_mode) {
    try {
      await agents.setMode(key, effective);
    } catch (err) {
      // The agent is the authority. If it would not take the mode, the picker
      // has to show what the agent has rather than what we wanted it to have.
      console.warn("setMode on resume failed:", err);
      effective = snapshot.current_mode;
      honouredPick = false;
    }
  }

  const actions = useChatStore.getState().actions;
  if (isClaude) {
    // Only seed when we did NOT honour the pick: `hydrateClaudePermissionMode`
    // clears the explicit flag, and the store already reflects an honoured
    // pick from `applyPersistedModePref`.
    const mode = effective ?? snapshot.current_mode;
    if (!honouredPick && mode && (CLAUDE_PERMISSION_MODES as readonly string[]).includes(mode)) {
      actions.hydrateClaudePermissionMode(tabId, mode as ClaudePermissionMode);
    }
    return;
  }
  // Generic ACP agents: seed from the snapshot, because the advertised list
  // travels with it and the picker needs it. This action leaves
  // `acpModeExplicit` alone, so an honoured pick stays honoured next resume.
  //
  // An empty list is not an answer about this agent's modes, it is the absence
  // of one, so seeding from it would blank a picker that was right. The
  // session/new path guards the same way.
  if (snapshot.available_modes.length > 0) {
    actions.setAcpModes(
      tabId,
      effective ?? snapshot.current_mode,
      snapshot.available_modes,
      agentTypeFromPluginId(snapshot.plugin_id),
    );
  }
}
