/**
 * `ui_terminal`: open a terminal, or type a line at a terminal's prompt. The
 * line is never run: the user presses Enter (ADR-0012). A line with a line
 * break would run everything before it, so it is refused.
 */

import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { useTerminalStore } from "@/features/terminal/stores/terminal-store";
import { openCommandTerminal } from "@/features/terminal/lib/open-command-terminal";
import { readArgs, refuse } from "./args";
import { tabInScope } from "./scope";
import type { UiActionRequest } from "./types";

export function performTerminal(request: UiActionRequest): unknown {
  const a = readArgs("ui_terminal", request.args);
  const op = a.oneOf("op", ["open", "type"] as const);
  const tabId = a.optStr("tabId");
  const text = op === "type" ? a.str("text") : undefined;
  if (text !== undefined && /[\r\n]/.test(text)) {
    return refuse("ui_terminal: text must be one line; a line break would run it");
  }
  const layout = useLayoutStore.getState();
  if (tabId) {
    if (tabInScope(tabId).type !== "terminal") return refuse(`tab ${tabId} is not a terminal`);
    // Focus it, so the terminal opened below lands in its column.
    layout.actions.setActiveTab(tabId);
  }

  if (op === "open") {
    layout.actions.addTab({
      id: `terminal-${Date.now()}`,
      type: "terminal",
      title: "Terminal",
      closable: true,
      dirty: false,
      data: {},
    });
    const opened = useLayoutStore.getState().activeTabId;
    if (!opened) return refuse("no terminal could be opened");
    useTerminalStore.getState().actions.requestTerminalFocus(opened);
    return { tabId: opened };
  }

  // A terminal of its own, so the line never interleaves with a running one.
  const opened = openCommandTerminal(text as string, "Terminal", { execute: false });
  if (!opened) return refuse("no terminal could be opened");
  return { tabId: opened.tabId, terminalId: opened.terminalId, executed: false };
}
