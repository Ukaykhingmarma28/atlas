/**
 * Performing one UI action. A plain dispatcher over the tool name; each tool
 * goes through the app's existing openers and store actions, never around
 * them. Every action writes one row to the Logs panel, which is the audit
 * trail of what an agent did to the window.
 */

import { logEvent } from "@/features/log/lib/log";
import { useSettingsStore } from "@/features/settings/stores/settings-store";
import { buildUiState } from "./ui-state";
import { fail, ok, type UiActionReply, type UiActionRequest } from "./types";

export async function performUiAction(request: UiActionRequest): Promise<UiActionReply> {
  const reply = dispatch(request);
  logEvent({
    source: "agent",
    kind: "agent-ui-action",
    summary: `${request.agent} ${request.tool}${reply.ok ? "" : ` refused: ${reply.error}`}`,
    status: reply.ok ? "success" : "failure",
    payload: {
      agent: request.agent,
      sessionId: request.sessionId,
      tool: request.tool,
      args: request.args,
    },
  });
  return reply;
}

const SWITCHED_OFF =
  "Atlas Agent navigation is switched off in Settings → General; ask the user to turn it on.";

function dispatch(request: UiActionRequest): UiActionReply {
  // Rust refuses first; this catches a request that raced the switch.
  if (!useSettingsStore.getState().settings.agentUiNavigation) return fail(SWITCHED_OFF);
  switch (request.tool) {
    case "ui_state":
      return ok(buildUiState(request));
    default:
      return fail(`unknown UI action "${request.tool}"`);
  }
}
