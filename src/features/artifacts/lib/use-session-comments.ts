/**
 * One open Session's comments, kept current.
 *
 * Loads once when a shared Session opens, then follows the realtime channel.
 * Returns `null` for a Session that is not on the server, which is what hides
 * every comment affordance — there is no anchor to attach one to.
 *
 * # Why the socket and not a poll
 *
 * The server sends **one** frame shape for post, edit, resolve and delete, so a
 * single handler covers all four and the thread stays right without refetching.
 * A poll would also have to re-read the whole list every time: the comments
 * endpoint is unpaged.
 *
 * # No optimism, on purpose
 *
 * A posted comment appears when the server has it, because the server is what
 * stamps the author, parses the mentions, and can refuse. Painting one
 * optimistically — with no offline queue to hold it — would be a lie that loses
 * the text the moment the request failed.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";

import { useOrgDirectory } from "@/features/organisations/lib/use-org-directory";
import { safeUnlistenPromise } from "@/lib/safe-unlisten";

import type { RowComments } from "../components/session-detail";
import {
  applyComment,
  comments as api,
  EMPTY_THREADS,
  type AnchorKind,
  type Comment,
  type CommentThreads,
} from "./comments-api";
import { queueWatch } from "./watch-queue";

/** The window channel the cloud bridge emits on. */
const ARTIFACTS_EVENT = "atlas:artifacts-cloud";

type WireEvent =
  | { kind: "boardChanged" }
  | { kind: "entryUpsert"; sessionId: string; change: string; entry: unknown }
  | { kind: "commentUpsert"; sessionId: string; comment: Comment }
  | { kind: "presence"; projectId: string; online: string[] }
  | { kind: "revoked"; projectId: string }
  | { kind: "resync" };

export function useSessionComments(
  /** The **server** Project id. `null` for a Session that is not shared. */
  remoteProjectId: string | null,
  sessionId: string | null,
): RowComments | null {
  // One roster for every byline, mention and avatar stack in the pane. Resolved
  // here rather than per comment: the hook is stale-while-revalidate, so the
  // cost is one request however many surfaces read it.
  const directory = useOrgDirectory();
  const [threads, setThreads] = useState<CommentThreads>(EMPTY_THREADS);

  const shared = remoteProjectId !== null && sessionId !== null;

  // Follow this Session on the already-open socket. The subscription is held
  // per socket server-side, so it has to be re-announced whenever the Session
  // changes — and released when the pane closes, or a Session nobody is looking
  // at keeps pushing frames.
  //
  // Through one queue, so the unsubscribe of a cleanup can never overtake the
  // subscribe of the next mount — see `watch-queue.ts`. Rust records the
  // desired Session whether or not the socket exists yet, so a Project that
  // gets its socket later still ends up following this Session.
  useEffect(() => {
    if (!shared) return;
    void queueWatch(remoteProjectId, sessionId);
    return () => {
      void queueWatch(remoteProjectId, null);
    };
  }, [shared, remoteProjectId, sessionId]);

  const load = useCallback(() => {
    if (!shared) {
      setThreads(EMPTY_THREADS);
      return;
    }
    let live = true;
    void api
      .list(remoteProjectId, sessionId)
      .then((next) => {
        if (live) setThreads(next);
      })
      // A failed read leaves no comments rather than an error banner over a
      // Session that is otherwise perfectly readable. The realtime channel
      // still fills them in if it connects.
      .catch(() => {
        if (live) setThreads(EMPTY_THREADS);
      });
    return () => {
      live = false;
    };
  }, [shared, remoteProjectId, sessionId]);

  useEffect(() => load(), [load]);

  useEffect(() => {
    if (!shared) return;
    const stop = listen<WireEvent>(ARTIFACTS_EVENT, (event) => {
      const payload = event.payload;
      if (payload.kind === "commentUpsert") {
        // Frames reach every socket on the Project, not only this Session's.
        if (payload.sessionId !== sessionId) return;
        setThreads((current) => applyComment(current, payload.comment));
        return;
      }
      // We fell behind and frames were dropped, so local state has a gap it
      // cannot see. Re-read rather than carrying it.
      if (payload.kind === "resync") load();
    });
    return () => safeUnlistenPromise(stop);
  }, [shared, sessionId, load]);

  const actions = useMemo(
    () => ({
      post: async (
        anchorKind: AnchorKind,
        anchorId: string,
        body: string,
        parentId: string | null,
      ) => {
        if (!shared) return;
        const posted = await api.create(
          remoteProjectId,
          sessionId,
          anchorKind,
          anchorId,
          body,
          parentId,
        );
        // Apply the answer directly rather than waiting for the echo: the
        // socket frame is the same comment, and `applyComment` is keyed by id,
        // so whichever lands second is a no-op replacement.
        setThreads((current) => applyComment(current, posted));
      },
      resolve: async (commentId: string, resolved: boolean) => {
        if (!shared) return;
        const updated = await api.update(remoteProjectId, sessionId, commentId, { resolved });
        setThreads((current) => applyComment(current, updated));
      },
      remove: async (commentId: string) => {
        if (!shared) return;
        const removed = await api.remove(remoteProjectId, sessionId, commentId);
        setThreads((current) => applyComment(current, removed));
      },
    }),
    [shared, remoteProjectId, sessionId],
  );

  return useMemo(
    () =>
      shared
        ? {
            byAnchor: threads.byAnchor,
            session: threads.session,
            actions,
            directory,
          }
        : null,
    [shared, threads, actions, directory],
  );
}
