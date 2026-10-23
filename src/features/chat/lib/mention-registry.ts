// Short form → the mention it was minted from.
//
// A draft is plain text (`chat-store` `drafts`), and so is a prefill, an
// insert, and whatever the clipboard holds. A short form names a mention but
// does not carry it: `@file:src/x.ts` has no absolute path, `@session:"Fix
// it"` no session id. So every mention the composer inserts is remembered
// here, keyed by the exact short form it writes, and the serializer asks for it
// back when that text returns — a tab switch, a draft restore, a copy and
// paste of the composer's own text — and the chip comes back whole.
//
// In memory on purpose: drafts are too (`chat-store` does not persist them),
// so the two live and die together.
//
// A token nobody minted this run can still be rebuilt when its short form
// carries everything the mention needs: a project-relative `@file:` or
// `@folder:` is a path under the current project. Every other kind stays text
// — guessing a session id or a member from a display name would send the
// agent somewhere the user never pointed.

import type { MentionData } from "./mentions";
import { toShortForm } from "./mentions";
import type { ShortFormToken } from "./composer-short-forms";

/** Enough for every chip a long session's drafts hold; the oldest go first. */
const CAPACITY = 500;

const minted = new Map<string, MentionData>();

/** Record a mention the composer just inserted. */
export function rememberMention(mention: MentionData): void {
  const key = toShortForm(mention);
  minted.delete(key);
  minted.set(key, mention);
  if (minted.size > CAPACITY) {
    const oldest = minted.keys().next().value;
    if (oldest !== undefined) minted.delete(oldest);
  }
}

/** The mention minted under exactly this token, if any. */
export function knownMention(raw: string): MentionData | null {
  return minted.get(raw) ?? null;
}

/** A mention rebuilt from the token alone — only a path can be. */
export function rebuildMention(
  token: ShortFormToken,
  projectPath: string | null,
): MentionData | null {
  if (token.prefix !== "@file" && token.prefix !== "@folder") return null;
  const value = token.value;
  let absPath: string;
  if (value.startsWith("/")) {
    absPath = value;
  } else if (projectPath) {
    absPath = `${projectPath.replace(/\/+$/, "")}/${value}`;
  } else {
    return null;
  }
  return token.prefix === "@file"
    ? { kind: "file", id: absPath, displayName: value, absPath }
    : { kind: "folder", id: absPath, displayName: value, absPath };
}

/** Test seam: forget every minted mention. */
export function resetMentionRegistryForTests(): void {
  minted.clear();
}
