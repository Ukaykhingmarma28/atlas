// Which actions a message's hover footer offers, and where each one sits.
//
// Pure so the action set per message kind can be tested without rendering a
// row; `user-row-actions.tsx` and `prose-row-actions.tsx` render exactly what
// this returns, in this order.
//
// The footer keeps the frequent actions inline as icons and puts the rare ones
// behind a "…" menu, so the resting row reads as copy (and retry or branch,
// where they apply) plus a timestamp. Two rules decide the split:
//
//  - Copy is inline everywhere. Retry is inline because it only ever appears
//    on the latest prompt, which is where it is wanted. Branch is inline for
//    the same reason: it only ever appears on the latest response.
//  - Pin and "Edit and send as new message" go in the menu. A PINNED message
//    shows its pin inline instead, lit, so the state is visible on hover and
//    one click undoes it.
//
// The comment button is not listed: it shares a surround with copy and appears
// only when the message has a cloud anchor (`CommentAndCopy`), which is a
// store fact the row resolves itself.

import { RowKind, type Row } from "./turn-rows";

export type MessageAction = "retry" | "copy" | "branch" | "pin" | "edit";

export interface MessageFooterActions {
  /** Icon buttons, in render order. */
  inline: MessageAction[];
  /** The "…" menu's items, in order. Empty means no menu button at all. */
  overflow: MessageAction[];
}

export function userFooterActions({
  canRetry,
  pinned,
}: {
  /** The session's last prompt on an agent that can rewind (`retry-gate.ts`). */
  canRetry: boolean;
  pinned: boolean;
}): MessageFooterActions {
  const inline: MessageAction[] = [];
  if (canRetry) inline.push("retry");
  if (pinned) inline.push("pin");
  inline.push("copy");
  const overflow: MessageAction[] = ["edit"];
  if (!pinned) overflow.push("pin");
  return { inline, overflow };
}

export function responseFooterActions({
  canBranch,
  pinned,
}: {
  /** The session's latest settled response, on an agent that advertised
   *  `fork`, with no turn running. Forking copies the session as it stands,
   *  so the latest response is the only row "branch from here" is true of. */
  canBranch: boolean;
  pinned: boolean;
}): MessageFooterActions {
  const inline: MessageAction[] = ["copy"];
  if (canBranch) inline.push("branch");
  if (pinned) inline.push("pin");
  return { inline, overflow: pinned ? [] : ["pin"] };
}

/**
 * The id of the session's latest settled response, which is the only prose row
 * that may offer "Branch from here". `undefined` when the last prompt has no
 * settled answer yet: a branch taken then would carry the unanswered prompt,
 * and the response above it is not "here" any more. Walks back from the end
 * and stops at the first prompt, so it touches only the last exchange.
 */
export function latestResponseRowId(rows: readonly Row[]): string | undefined {
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (row.kind === RowKind.User) return undefined;
    if (row.kind === RowKind.Prose) return row.streaming ? undefined : row.id;
  }
  return undefined;
}
