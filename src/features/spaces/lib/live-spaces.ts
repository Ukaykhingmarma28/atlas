/**
 * What this window holds live of each conversation's Space, for everything
 * that reaches a Space without mounting a canvas (Atlas Agent drawing on a
 * page, `org_page_write`):
 *
 *  - **the socket's holders.** Rust keeps one socket per conversation and
 *    `spaces_disconnect` closes it whoever else is using it, so every holder
 *    — a mounted canvas, a write in flight — takes and gives it back through
 *    here, and only the last one out disconnects;
 *  - **the pages open on a canvas**, caught up with the Space. A write to one
 *    of those goes into the canvas's own doc and out on its own sync, never
 *    through a second subscription beside it.
 */
import type * as Y from "yjs";

import { spacesApi } from "./spaces-api";
import { spaceBusReady, spaceConnection, subscribeSpaceBus } from "./spaces-bus";
import type { SpacePageTransport } from "./space-page-write";

const holders = new Map<string, number>();

/** Take a hold on the conversation's socket, dialling it if nobody holds it.
 *  Resolves once the bus is listening, so its first events are heard. */
export async function acquireSpaceSocket(convId: string): Promise<void> {
  holders.set(convId, (holders.get(convId) ?? 0) + 1);
  await spaceBusReady();
  // Idempotent in Rust: a socket already open for this conversation is kept.
  await spacesApi.connect(convId);
}

/** Give a hold back; the last one out closes the socket. */
export function releaseSpaceSocket(convId: string): void {
  const left = (holders.get(convId) ?? 1) - 1;
  if (left > 0) {
    holders.set(convId, left);
    return;
  }
  holders.delete(convId);
  void spacesApi.disconnect(convId).catch(() => {});
}

interface OpenPage {
  doc: Y.Doc;
  /** Why the Space will not take this page's edits, or `null`. */
  readOnly: string | null;
}

const openPages = new Map<string, OpenPage>();
const key = (convId: string, pageId: string) => `${convId}\u0000${pageId}`;

/** A canvas has `pageId` open and caught up (its `page.opened` applied).
 *  Returns the unregister, for the page switch or the unmount. */
export function registerOpenPage(
  convId: string,
  pageId: string,
  doc: Y.Doc,
  readOnly: string | null,
): () => void {
  const k = key(convId, pageId);
  const entry = { doc, readOnly };
  openPages.set(k, entry);
  return () => {
    if (openPages.get(k) === entry) openPages.delete(k);
  };
}

/** The doc of `pageId` as an open canvas holds it, or `null`. */
export function openPage(convId: string, pageId: string): OpenPage | null {
  return openPages.get(key(convId, pageId)) ?? null;
}

/** The Space as a page write reaches it from this window. */
export const appSpaceTransport: SpacePageTransport = {
  summary: (convId) => spacesApi.summary(convId),
  openPage,
  acquire: acquireSpaceSocket,
  release: releaseSpaceSocket,
  connection: spaceConnection,
  subscribe: subscribeSpaceBus,
  sendControl: (convId, message) => spacesApi.sendControl(convId, message),
  sendBinary: (convId, data) => spacesApi.sendBinary(convId, data),
};
