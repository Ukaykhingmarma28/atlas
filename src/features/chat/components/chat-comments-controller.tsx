/**
 * Keeps one chat pane's comments current. Renders nothing.
 *
 * Mounted once per `ChatPanel`. A session's comments live in one of two
 * places, and this is the only thing that knows which: on this machine
 * (`local-comments-store.ts`) until the session is in the cloud, then on the
 * server. Either way it writes the same shape into `chat-comments-store`,
 * where the header badge, the panel and the transcript rows read it through
 * narrow selectors and never ask where a comment lives.
 *
 * For a cloud session it answers three questions:
 *
 * 1. **Is this session in the cloud?** `chat_comment_target` says so only when
 *    the Organisation is synced, the Project is bound to Cloud for it, and the
 *    session has been captured. Asked on mount, when the session binds, when a
 *    turn ends (the captured rows land at turn end), when capture announces a
 *    write, and when a comment arrives on a row the map does not know.
 * 2. **Which captured row is which chat message?** `buildAnchorMap`, rebuilt
 *    when the thread's shape changes — never per streaming chunk.
 * 3. **What are the comments?** `useSessionComments`, verbatim from the
 *    Timeline: the same watch subscription, the same realtime handler, the
 *    same post/resolve/remove.
 *
 * For a local session the anchor map is built from the chat alone
 * (`local-comment-anchors.ts`) and the actions write to the local store. The
 * moment a cloud target appears for a session that has local threads, they
 * are posted to the server — roots, then replies, resolved state kept — and
 * forgotten here, so the team's copy is the only one from then on. A thread
 * on a row the cloud map cannot place yet (a turn capture has not written)
 * stays local until it can.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import type { CommentActions } from "@/features/artifacts/components/comment-thread";
import type { RowComments } from "@/features/artifacts/components/session-detail";
import { comments as cloudApi } from "@/features/artifacts/lib/comments-api";
import { useSessionComments } from "@/features/artifacts/lib/use-session-comments";
import { useAuthStore } from "@/features/auth/stores/auth-store";
import { useIsTabVisible } from "@/features/layout/lib/use-tab-visible";
import type { OrgDirectory } from "@/features/organisations/lib/use-org-directory";
import { safeUnlistenPromise } from "@/lib/safe-unlisten";
import { isBusyAgentStatus } from "@/types/agent";

import {
  buildAnchorMap,
  structureKey,
  type AnchorEntry,
  type AnchorMap,
} from "../lib/comment-anchors";
import { commentToMention, linkCommentToComposer } from "../lib/comment-mentions";
import { buildLocalAnchorMap } from "../lib/local-comment-anchors";
import { projectPathForTab } from "../lib/tab-project";
import { useChatCommentsStore, type CommentTargetIds } from "../stores/chat-comments-store";
import { pinScope } from "../stores/chat-pins-store";
import { useChatStore } from "../stores/chat-store";
import {
  bucketLocalComments,
  LOCAL_AUTHOR,
  localCommentsFor,
  useLocalCommentsStore,
} from "../stores/local-comments-store";

export interface CommentTarget extends CommentTargetIds {
  entries: AnchorEntry[];
}

/** Capture coalesces its own writes; this absorbs the board ticker's echo. */
const CAPTURE_DEBOUNCE_MS = 300;
/** The worker flushes a turn's messages after the turn ends; give it a beat. */
const TURN_END_DELAY_MS = 500;

function entriesKey(entries: AnchorEntry[]): string {
  let key = "";
  for (const e of entries) key += `${e.rowId}|${e.nativeId ?? ""};`;
  return key;
}

/**
 * The roster of a local session: the signed-in account, so a comment says
 * "You" and wears the account's face, or nobody when there is no account.
 * `OrgDirectory` so every thread surface reads one shape.
 */
function useLocalDirectory(): OrgDirectory {
  const user = useAuthStore((s) => (s.snapshot.status === "signed-in" ? s.snapshot.user : null));
  return useMemo(() => {
    const byId: OrgDirectory["byId"] = new Map();
    if (user) {
      byId.set(user.id, {
        id: user.id,
        userId: user.id,
        name: user.name,
        email: user.email,
        role: null,
        createdAt: null,
        avatarPath: user.avatarPath,
        isOwner: false,
      });
    }
    return { byId, currentUserId: user?.id ?? LOCAL_AUTHOR };
  }, [user]);
}

/**
 * Post this session's local threads to the server and forget them. Roots
 * first, then their replies under the new ids. One thread at a time, in
 * order, so a failure halfway leaves the rest local and nothing twice.
 */
async function migrateLocalComments(
  scope: string,
  target: CommentTargetIds,
  localAnchors: AnchorMap,
  cloudAnchors: AnchorMap,
): Promise<void> {
  const list = localCommentsFor(useLocalCommentsStore.getState(), scope);
  if (list.length === 0) return;
  const { forget } = useLocalCommentsStore.getState().actions;
  const roots = list.filter((c) => c.parentId === null && c.deletedAt === null);
  for (const root of roots) {
    const chatKey = localAnchors.chatKeyByRowId.get(root.anchorId);
    const hit = chatKey ? cloudAnchors.rowIdByChatKey.get(chatKey) : undefined;
    if (!hit || root.body === null) continue;
    const replies = list.filter((c) => c.parentId === root.id && c.deletedAt === null);
    const posted = await cloudApi.create(
      target.remoteProjectId,
      target.sessionId,
      hit.anchorKind,
      hit.rowId,
      root.body,
      null,
    );
    for (const reply of replies) {
      if (reply.body === null) continue;
      await cloudApi.create(
        target.remoteProjectId,
        target.sessionId,
        hit.anchorKind,
        hit.rowId,
        reply.body,
        posted.id,
      );
    }
    if (root.resolvedAt) {
      await cloudApi.update(target.remoteProjectId, target.sessionId, posted.id, {
        resolved: true,
      });
    }
    forget(scope, [root.id, ...replies.map((r) => r.id)]);
  }
  // Deleted rows and the replies of deleted roots have nothing to post.
  const leftover = localCommentsFor(useLocalCommentsStore.getState(), scope).filter(
    (c) =>
      c.deletedAt !== null ||
      (c.parentId !== null && !list.some((r) => r.id === c.parentId && r.deletedAt === null)),
  );
  if (leftover.length)
    forget(
      scope,
      leftover.map((c) => c.id),
    );
}

export function ChatCommentsController({ tabId }: { tabId: string }) {
  const acpSessionId = useChatStore((s) => s.sessions[tabId]?.acpSessionId);
  const busy = useChatStore((s) => isBusyAgentStatus(s.sessions[tabId]?.status));
  const shape = useChatStore((s) => structureKey(s.sessions[tabId]?.messages));
  const visible = useIsTabVisible(tabId);
  const { setTarget, setAnchors, setComments, clear } = useChatCommentsStore.use.actions();
  const scope = pinScope(tabId, acpSessionId);

  const [target, setLocalTarget] = useState<CommentTarget | null>(null);
  const targetRef = useRef<CommentTarget | null>(null);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const inFlight = useRef(false);
  const again = useRef(false);

  // One resolver, serialised: a second request while one is out is folded
  // into a single re-run after it lands, so bursts of capture events cost one
  // read.
  const resolve = useRef(async () => {});
  resolve.current = async () => {
    if (inFlight.current) {
      again.current = true;
      return;
    }
    inFlight.current = true;
    try {
      const projectPath = projectPathForTab(tabId);
      const sessionId = useChatStore.getState().sessions[tabId]?.acpSessionId;
      let next: CommentTarget | null = null;
      if (projectPath && sessionId) {
        next = await invoke<CommentTarget | null>("chat_comment_target", {
          projectPath,
          nativeSessionId: sessionId,
        }).catch(() => null);
      }
      const prev = targetRef.current;
      const same =
        prev?.remoteProjectId === next?.remoteProjectId &&
        prev?.sessionId === next?.sessionId &&
        entriesKey(prev?.entries ?? []) === entriesKey(next?.entries ?? []);
      if (!same) {
        targetRef.current = next;
        setLocalTarget(next);
        setTarget(
          tabId,
          next ? { remoteProjectId: next.remoteProjectId, sessionId: next.sessionId } : null,
          next?.entries ?? [],
        );
      }
    } finally {
      inFlight.current = false;
      if (again.current) {
        again.current = false;
        void resolve.current();
      }
    }
  };

  // Mount, and every time the session binds to a different agent session.
  useEffect(() => {
    void resolve.current();
  }, [tabId, acpSessionId]);

  // Turn end: the captured rows for that turn land now.
  const wasBusy = useRef(busy);
  useEffect(() => {
    if (wasBusy.current && !busy) {
      const t = setTimeout(() => void resolve.current(), TURN_END_DELAY_MS);
      wasBusy.current = busy;
      return () => clearTimeout(t);
    }
    wasBusy.current = busy;
  }, [busy]);

  // Capture wrote something (or the board ticker fired). Only a visible pane
  // pays the read; a hidden one catches up when it is shown.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const stop = listen("atlas:capture-changed", () => {
      if (!visibleRef.current) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void resolve.current(), CAPTURE_DEBOUNCE_MS);
    });
    return () => {
      if (timer) clearTimeout(timer);
      void safeUnlistenPromise(stop);
    };
  }, []);
  useEffect(() => {
    if (visible) void resolve.current();
  }, [visible]);

  // The anchor map: chat shape × captured rows in the cloud; the chat alone
  // locally. Both maps are kept while a target exists, because migration
  // needs the local one to find each thread's row in the cloud one.
  const [localAnchors, setLocalAnchors] = useState<AnchorMap>(() => buildLocalAnchorMap([]));
  useEffect(() => {
    const messages = useChatStore.getState().sessions[tabId]?.messages ?? [];
    const local = buildLocalAnchorMap(messages);
    setLocalAnchors(local);
    setAnchors(tabId, target ? buildAnchorMap(messages, target.entries) : local);
  }, [tabId, shape, target, setAnchors]);

  // The local session's comments, as the store's shape.
  const localList = useLocalCommentsStore((s) => localCommentsFor(s, scope));
  const localDirectory = useLocalDirectory();
  const localActions = useMemo((): CommentActions => {
    const store = () => useLocalCommentsStore.getState().actions;
    return {
      post: async (anchorKind, anchorId, body, parentId) => {
        store().post(
          scope,
          localDirectory.currentUserId ?? LOCAL_AUTHOR,
          anchorKind,
          anchorId,
          body,
          parentId,
        );
      },
      edit: async (commentId, body) => store().edit(scope, commentId, body),
      resolve: async (commentId, resolved) => store().resolve(scope, commentId, resolved),
      remove: async (commentId) => store().remove(scope, commentId),
    };
  }, [scope, localDirectory]);
  const localComments = useMemo(
    (): RowComments => ({
      byAnchor: bucketLocalComments(localList),
      session: localList.filter((c) => c.anchorKind === "session"),
      actions: localActions,
      directory: localDirectory,
    }),
    [localList, localActions, localDirectory],
  );

  // The comments themselves. Followed only while the pane is showing: a chat
  // pane stays mounted when hidden, and every follow is a socket. The hook
  // re-lists on show, so nothing said in between is missed.
  const comments = useSessionComments(
    visible ? (target?.remoteProjectId ?? null) : null,
    visible ? (target?.sessionId ?? null) : null,
  );
  // The chat's popovers can link a comment into THIS pane's composer. Added
  // here, where the tab is known, so the Timeline's popovers (no composer of
  // their own) keep drawing no link button.
  // `actions` is memoised on its own: every row subscribes to it, and a new
  // object per comment frame would re-render all of them.
  const baseActions = comments?.actions ?? null;
  const actions = useMemo(() => {
    if (!baseActions) return null;
    const link = (comment: Parameters<typeof commentToMention>[0]) => {
      const tab = useChatCommentsStore.getState().byTab[tabId];
      const mention = tab ? commentToMention(comment, tab) : null;
      if (mention) linkCommentToComposer(tabId, mention);
    };
    return { ...baseActions, link };
  }, [baseActions, tabId]);
  const linkable = useMemo(
    () => (comments && actions ? { ...comments, actions } : null),
    [comments, actions],
  );
  useEffect(() => {
    setComments(tabId, target ? linkable : localComments);
    if (!comments || !target) return;
    // A comment on a row the map cannot place: a turn that landed after the
    // last resolve. Ask once per change of the buckets, not per frame.
    const known = useChatCommentsStore.getState().byTab[tabId]?.anchors.chatKeyByRowId;
    for (const rowId in comments.byAnchor) {
      if (!known?.has(rowId)) {
        void resolve.current();
        break;
      }
    }
  }, [tabId, comments, linkable, target, setComments]);

  // A session that went to the cloud with local threads: post them. Runs
  // when the cloud map changes too, so a thread on a row that was not
  // captured yet goes up once it is. Serialised; a run that finds nothing to
  // do costs one read of the local store.
  const cloudAnchors = useChatCommentsStore((s) => s.byTab[tabId]?.anchors);
  const migrating = useRef(false);
  useEffect(() => {
    if (!target || !cloudAnchors || migrating.current) return;
    if (localCommentsFor(useLocalCommentsStore.getState(), scope).length === 0) return;
    migrating.current = true;
    void migrateLocalComments(scope, target, localAnchors, cloudAnchors)
      .catch((err) => console.warn("comment migration failed:", err))
      .finally(() => {
        migrating.current = false;
      });
  }, [scope, target, localAnchors, cloudAnchors]);

  // Clearing the store entry must also forget the target this instance last
  // pushed: a hidden pane (an inactive center tab) runs its effect cleanups but
  // keeps its refs, so on show `resolve` would find the same target, skip
  // `setTarget`, and leave the store without one — no badge, no faces, no link.
  useEffect(
    () => () => {
      targetRef.current = null;
      clear(tabId);
    },
    [tabId, clear],
  );

  return null;
}
