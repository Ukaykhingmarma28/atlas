// @vitest-environment happy-dom
// The local comment store: the server's `Comment` shape, kept on this
// machine per session scope, with the server's rules — a delete keeps the
// row with a null body, a resolve is on roots, and forgetting is how a
// migrated thread leaves.

import { beforeEach, describe, expect, it } from "vitest";

import {
  bucketLocalComments,
  localCommentsFor,
  useLocalCommentsStore,
} from "./local-comments-store";

const SCOPE = "s:session-1";

beforeEach(() => {
  localStorage.clear();
  useLocalCommentsStore.setState({ byScope: {} });
});

describe("local comments", () => {
  it("posts a root and a reply under it, oldest first", () => {
    const { post } = useLocalCommentsStore.getState().actions;
    const root = post(SCOPE, "me", "message", "a:abc:0", "Why here?", null);
    const reply = post(SCOPE, "me", "message", "a:abc:0", "Because.", root.id);
    const list = localCommentsFor(useLocalCommentsStore.getState(), SCOPE);
    expect(list.map((c) => c.id)).toEqual([root.id, reply.id]);
    expect(root).toMatchObject({
      sessionId: SCOPE,
      anchorKind: "message",
      anchorId: "a:abc:0",
      parentId: null,
      authorId: "me",
      guestName: null,
      body: "Why here?",
      resolvedAt: null,
      deletedAt: null,
    });
    expect(reply.parentId).toBe(root.id);
    expect(bucketLocalComments(list)).toEqual({ "a:abc:0": [root, reply] });
  });

  it("edits, resolves and reopens, and deletes by blanking the body", () => {
    const { post, edit, resolve, remove } = useLocalCommentsStore.getState().actions;
    const root = post(SCOPE, "me", "message", "u:1:0", "draft", null);
    edit(SCOPE, root.id, "final");
    resolve(SCOPE, root.id, true);
    let [c] = localCommentsFor(useLocalCommentsStore.getState(), SCOPE);
    expect(c.body).toBe("final");
    expect(c.editedAt).not.toBeNull();
    expect(c.resolvedAt).not.toBeNull();
    expect(c.resolvedBy).toBe("me");
    resolve(SCOPE, root.id, false);
    remove(SCOPE, root.id);
    [c] = localCommentsFor(useLocalCommentsStore.getState(), SCOPE);
    expect(c.resolvedAt).toBeNull();
    expect(c.body).toBeNull();
    expect(c.deletedAt).not.toBeNull();
  });

  it("forgets what was migrated and drops an empty scope", () => {
    const { post, forget } = useLocalCommentsStore.getState().actions;
    const a = post(SCOPE, "me", "message", "u:1:0", "a", null);
    const b = post(SCOPE, "me", "message", "u:2:0", "b", null);
    forget(SCOPE, [a.id]);
    expect(localCommentsFor(useLocalCommentsStore.getState(), SCOPE).map((c) => c.id)).toEqual([
      b.id,
    ]);
    forget(SCOPE, [b.id]);
    expect(useLocalCommentsStore.getState().byScope[SCOPE]).toBeUndefined();
    expect(localCommentsFor(useLocalCommentsStore.getState(), SCOPE)).toBe(
      localCommentsFor(useLocalCommentsStore.getState(), "other"),
    );
  });

  it("keeps scopes apart and a session-wide comment out of the row buckets", () => {
    const { post } = useLocalCommentsStore.getState().actions;
    post(SCOPE, "me", "session", "session", "overall", null);
    post("s:other", "me", "message", "u:1:0", "elsewhere", null);
    const list = localCommentsFor(useLocalCommentsStore.getState(), SCOPE);
    expect(list).toHaveLength(1);
    expect(bucketLocalComments(list)).toEqual({});
  });
});
