/**
 * The settle keybinding's route to the session sidebar.
 *
 * Settling the open session has to move the chat somewhere, and only the
 * sidebar knows the list it would move along — so the shell's chord asks the
 * sidebar of the chat tab in front to do it. Each chat tab's sidebar registers
 * itself here while mounted (hidden counts: it stays mounted and renders
 * nothing). The dropdown picker does not register; it is the same list, shown
 * for a moment.
 */

type SettleHandler = () => void;

const handlers = new Map<string, SettleHandler>();

/** Make `handler` the settle action for `tabId`'s sidebar; returns the
 *  matching unregister, which leaves a newer registration alone. */
export function registerSettleAndAdvance(tabId: string, handler: SettleHandler): () => void {
  handlers.set(tabId, handler);
  return () => {
    if (handlers.get(tabId) === handler) handlers.delete(tabId);
  };
}

/** Settle (or un-settle) `tabId`'s open session through its sidebar. Answers
 *  `false` when no sidebar is mounted for that tab. */
export function settleAndAdvance(tabId: string): boolean {
  const handler = handlers.get(tabId);
  if (!handler) return false;
  handler();
  return true;
}
