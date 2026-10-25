/**
 * What a local comment hangs off: a key for a message that survives everything
 * the message's id does not.
 *
 * A cloud comment is anchored to a captured row id, and `comment-anchors.ts`
 * joins those to the live chat. A local comment (`local-comments-store.ts`)
 * has no capture to lean on, and `ChatMessage.id` is minted afresh on every
 * history load (`replaceMessages`), so it cannot be the anchor either — the
 * same problem a pin has (`chat-pins-store.ts`). The answer is the same as the
 * pin's: the text the row SHOWS, which is what the reader commented on and what
 * comes back identical from history. Not the timestamp: a replayed message's
 * clock is the replay's (`timestampApproximate`).
 *
 * The key is the role, a hash of the shown text, and an ordinal among earlier
 * messages with the same role and text, so two identical prompts ("continue")
 * keep their own threads. Tool calls keep their wire id, which does survive
 * a reload.
 *
 * Built into the same `AnchorMap` the cloud path builds, so every row, pill,
 * badge and jump reads one shape and never asks where a comment lives.
 */

import type { ChatMessage } from "@/types/agent";

import type { AnchorHit, AnchorMap, OrderedAnchor } from "./comment-anchors";
import { EMPTY_ANCHOR_MAP } from "./comment-anchors";
import { assistantMessageText, userMessageText } from "./turn-rows";

/** FNV-1a, 32 bits, as eight hex digits. A key, not a secret. */
export function textHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export type LocalRowKind = "prompt" | "response" | "thinking";

/** The role and shown text a message is keyed by; null for a row that
 *  carries nothing a comment could attach to (a tool-only message). */
export function localKeyParts(m: ChatMessage): { kind: LocalRowKind; text: string } | null {
  if (m.role === "user") {
    const text = userMessageText(m);
    return text.trim() ? { kind: "prompt", text } : null;
  }
  if (m.role !== "assistant") return null;
  if (m.mode === "thinking") {
    const text = m.thinking ?? "";
    return text.trim() ? { kind: "thinking", text } : null;
  }
  if (m.mode === "tool") return null;
  const text = assistantMessageText(m);
  return text.trim() ? { kind: "response", text } : null;
}

const PREFIX: Record<LocalRowKind, string> = { prompt: "u", response: "a", thinking: "th" };

export function buildLocalAnchorMap(messages: readonly ChatMessage[]): AnchorMap {
  if (messages.length === 0) return EMPTY_ANCHOR_MAP;
  const rowIdByChatKey = new Map<string, AnchorHit>();
  const chatKeyByRowId = new Map<string, string>();
  const ordered: OrderedAnchor[] = [];
  const seen = new Map<string, number>();
  const hit = (chatKey: string, rowId: string, hit: AnchorHit["anchorKind"]) => {
    rowIdByChatKey.set(chatKey, { rowId, anchorKind: hit });
    chatKeyByRowId.set(rowId, chatKey);
  };
  for (const m of messages) {
    const parts = localKeyParts(m);
    if (parts) {
      const base = `${PREFIX[parts.kind]}:${textHash(parts.text)}`;
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      const rowId = `${base}:${n}`;
      hit(m.id, rowId, "message");
      ordered.push({ id: rowId, kind: parts.kind, toolName: null });
    }
    for (const tc of m.toolCalls) {
      const rowId = `tc:${tc.id}`;
      hit(tc.id, rowId, "tool_call");
      ordered.push({ id: rowId, kind: "tool_call", toolName: tc.toolName || null });
    }
  }
  return { rowIdByChatKey, chatKeyByRowId, ordered };
}
