import { TEAM_CHAT_TAB, type useLayoutStore } from "../stores/layout-store";
import { revealSingleton, singletonShown, toggleSingleton } from "./singleton-surface";

/**
 * Team chat is a surface: one tab per window, in the surfaces pane like source
 * control. Unlike source control it belongs to the window rather than the
 * project (`WINDOW_TYPES`), so it follows the user between projects.
 */

/** Whether team chat is on screen. Selector-shaped. */
export function teamChatShown(s: ReturnType<typeof useLayoutStore.getState>): boolean {
  return singletonShown(s, "team-chat");
}

export function revealTeamChat(): void {
  revealSingleton(TEAM_CHAT_TAB);
}

/** ⌘⇧C: close team chat when it is on screen, else reveal it. */
export function toggleTeamChat(): void {
  toggleSingleton(TEAM_CHAT_TAB);
}
