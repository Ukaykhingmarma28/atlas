// Short form → the mention it was minted from.
//
// A draft is plain text (`chat-store` `drafts`), and so is a prefill, an
// insert, and whatever the clipboard holds. A short form names a mention but
// does not carry it: `@file:src/x.ts` has no absolute path, `@session:"Fix
// it"` no session id. So every mention the composer inserts is remembered
// here, keyed by the project it was minted in and the exact short form it
// writes, and the serializer asks for it back when that text returns (a tab
// switch, a draft restore, a copy and paste of the composer's own text) and
// the chip comes back whole.
//
// Keyed by project because the same text means a different file in another
// one: `@file:src/main.rs` minted in project A must not resolve to A's file
// when it is pasted into project B. And a minted path outside the project it
// is asked for in is not handed back (`isUnderProject`): that text is rebuilt
// like anything typed.
//
// In memory on purpose: drafts are too (`chat-store` does not persist them),
// so the two live and die together. Bounded by count and by bytes, since a
// paste chip holds its whole text, and a paste is forgotten once it is sent.
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
/** What the registry may hold in all; a paste counts its text. */
export const REGISTRY_MAX_BYTES = 16 * 1024 * 1024;
/** What any other mention is counted as. */
const ENTRY_BYTES = 256;

const minted = new Map<string, { mention: MentionData; bytes: number }>();
let totalBytes = 0;

const keyOf = (raw: string, projectPath: string | null) => `${projectPath ?? ""}\u0000${raw}`;

function sizeOf(mention: MentionData): number {
  // UTF-16 code units, two bytes each: what the string costs in memory.
  return mention.kind === "pasted_text" ? mention.text.length * 2 + ENTRY_BYTES : ENTRY_BYTES;
}

function drop(key: string): void {
  const entry = minted.get(key);
  if (!entry) return;
  minted.delete(key);
  totalBytes -= entry.bytes;
}

/** Record a mention the composer just inserted, in the project it was
 *  inserted in. */
export function rememberMention(mention: MentionData, projectPath: string | null): void {
  const key = keyOf(toShortForm(mention), projectPath);
  drop(key);
  const bytes = sizeOf(mention);
  minted.set(key, { mention, bytes });
  totalBytes += bytes;
  while (minted.size > CAPACITY || (totalBytes > REGISTRY_MAX_BYTES && minted.size > 1)) {
    const oldest = minted.keys().next().value;
    if (oldest === undefined) break;
    drop(oldest);
  }
}

/** Whether `path` is the project root or under it. */
export function isUnderProject(path: string, projectPath: string | null): boolean {
  if (!projectPath) return false;
  const root = projectPath.replace(/\/+$/, "");
  return path === root || path.startsWith(`${root}/`);
}

/** The mention minted under exactly this token in this project, if any. A
 *  path outside the project is not given back. */
export function knownMention(raw: string, projectPath: string | null): MentionData | null {
  const mention = minted.get(keyOf(raw, projectPath))?.mention ?? null;
  if (!mention) return null;
  if (
    (mention.kind === "file" || mention.kind === "folder") &&
    !isUnderProject(mention.absPath, projectPath)
  ) {
    return null;
  }
  return mention;
}

/** Forget the pastes a send just carried: their text has gone out, and the
 *  registry should not keep a copy of every log the user ever pasted. */
export function forgetSentPastes(mentions: readonly MentionData[]): void {
  const ids = new Set(mentions.filter((m) => m.kind === "pasted_text").map((m) => m.id));
  if (ids.size === 0) return;
  for (const [key, { mention }] of minted) {
    if (mention.kind === "pasted_text" && ids.has(mention.id)) drop(key);
  }
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
  totalBytes = 0;
}
